import { describe, expect, test } from "bun:test";

import { createEventRequestSchema, serverProfileSchema } from "./directory.ts";

/**
 * The endpoint fields of the shapes a participant fills in.
 *
 * The split under test is deliberate. A schema validates the structure - an
 * absolute URL Muster could reach - while whether an http URL is acceptable is a
 * decision about configuration, made by `authoriseParticipantEndpoints` where the
 * allowlist is known. Keeping the scheme rule out of the schema is what lets the
 * same definition read a stored entry back: an entry recorded while its host was
 * allowlisted stays readable, so a check or a drift comparison over it still
 * works.
 *
 * @author John Grimes
 */

/** The rest of a server profile, so each test states only its endpoint. */
const restOfProfile = {
  authorizationMode: "smart",
  registrationMode: "manual",
  notes: "",
} as const;

describe("serverProfileSchema", () => {
  test("accepts an https FHIR base URL", () => {
    const parsed = serverProfileSchema.parse({
      fhirBaseUrl: "https://fhir.example.org",
      ...restOfProfile,
    });

    expect(parsed.fhirBaseUrl).toBe("https://fhir.example.org");
  });

  // Structurally acceptable, so the compose stack's http stubs can be recorded
  // and read back. Whether it is permitted is the allowlist's business.
  test("accepts an http FHIR base URL", () => {
    const parsed = serverProfileSchema.parse({
      fhirBaseUrl: "http://data-holder-stub:9091/fhir",
      ...restOfProfile,
    });

    expect(parsed.fhirBaseUrl).toBe("http://data-holder-stub:9091/fhir");
  });

  test("accepts an http registration endpoint", () => {
    const parsed = serverProfileSchema.parse({
      fhirBaseUrl: "http://register-stub:9090/fhir",
      authorizationMode: "smart",
      registrationMode: "trustedDcr",
      registrationEndpoint: "http://register-stub:9090/register",
      notes: "",
    });

    expect(parsed.registrationEndpoint).toBe(
      "http://register-stub:9090/register",
    );
  });

  // Nothing else is a URL Muster could fetch, so nothing else is accepted.
  test.each(["fhir.example.org", "ftp://fhir.example.org", "/fhir", ""])(
    "refuses %p as a FHIR base URL",
    (value) => {
      const parsed = serverProfileSchema.safeParse({
        fhirBaseUrl: value,
        ...restOfProfile,
      });

      expect(parsed.success).toBeFalse();
    },
  );

  // The rule that has always been here: a server that says it accepts software
  // statements without saying where is not usable.
  test("refuses trustedDcr without a registration endpoint", () => {
    const parsed = serverProfileSchema.safeParse({
      fhirBaseUrl: "https://fhir.example.org",
      authorizationMode: "smart",
      registrationMode: "trustedDcr",
      notes: "",
    });

    expect(parsed.success).toBeFalse();
  });
});

describe("createEventRequestSchema", () => {
  // The persona source is fetched by Muster, so it is the same kind of field and
  // carries the same relaxation.
  test("accepts an http persona source", () => {
    const parsed = createEventRequestSchema.parse({
      slug: "stack-2026",
      name: "Local stack event",
      startsOn: "2026-09-01",
      endsOn: "2026-09-03",
      personaSourceUrl: "http://persona-source-stub:9092/fhir",
    });

    expect(parsed.personaSourceUrl).toBe(
      "http://persona-source-stub:9092/fhir",
    );
  });

  test("refuses a persona source that is not an absolute URL", () => {
    const parsed = createEventRequestSchema.safeParse({
      slug: "stack-2026",
      name: "Local stack event",
      startsOn: "2026-09-01",
      endsOn: "2026-09-03",
      personaSourceUrl: "persona-source-stub/fhir",
    });

    expect(parsed.success).toBeFalse();
  });
});
