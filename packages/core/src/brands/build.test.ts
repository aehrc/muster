import { describe, expect, test } from "bun:test";

import { buildBrandsBundle } from "./build.ts";

import type { BrandsBundleFacts } from "./build.ts";
import type { CheckStatus, EnrolledSystem } from "@muster/contracts";
import type { Bundle, Endpoint, Organization } from "fhir/r4";

/**
 * The brands bundle, built with no I/O anywhere near it.
 *
 * The worked example in `exampleBundle.json` is the anchor: it is the bundle
 * these facts produce, and it is the file that was put through the HL7 FHIR
 * validator against
 * `http://hl7.org/fhir/smart-app-launch/StructureDefinition/user-access-brands-bundle`
 * (SMART App Launch 2.2.0, R4), which reported no errors. A test that only
 * asserted the fields this author expected would prove nothing about whether an
 * app can read the result, so the assertion is against a file a real validator
 * has read.
 *
 * The rest of the suite pins the rules the example cannot show on its own: a
 * client is not a brand (FR-022, acceptance scenario 3), every identity is
 * scoped to the event, each brand links to an endpoint that is really in the
 * bundle, an FHIR version is published only when a server has actually
 * advertised one, and no contact detail can travel in a bundle at all (FR-007).
 */

/** The worked example, as validated. */
const exampleBundle = (await Bun.file(
  new URL("exampleBundle.json", import.meta.url),
).json()) as Bundle;

/** The public base URL the example is built against. */
const publicUrl = "https://muster.test";

/** The event the example publishes. */
const eventSlug = "sparked-2026-09";

/** When the builder is told the bundle is being built. */
const generatedAt = new Date("2026-08-18T05:00:00.000Z");

/** What arranging one enrolled system needs. */
type SystemFacts = {
  /** the system's identifier, which keys its brand and its endpoint */
  readonly id: string;
  /** the system's name */
  readonly name: string;
  /** the owning organisation's name */
  readonly organisationName: string;
  /** the system's description, empty when it has none */
  readonly description?: string;
  /** the FHIR base URL, or undefined for a system that is not a server */
  readonly fhirBaseUrl?: string;
  /** when the enrolment's details were last confirmed */
  readonly confirmedAt: string;
  /** the latest check, when something has checked the entry */
  readonly check?: CheckStatus;
};

/**
 * Arranges a check that read a FHIR version out of a capability statement.
 *
 * @param at - when the check ran
 * @param fhirVersion - the version the statement advertised, or null
 * @returns the check status the entry carries
 */
const checkReading = (at: string, fhirVersion: string | null): CheckStatus => ({
  latest: {
    id: `check-${at}`,
    checkedAt: at,
    reachable: true,
    failureMode: null,
    detail: null,
    discovery: null,
    capability:
      fhirVersion === null
        ? null
        : {
            fhirVersion,
            software: null,
            implementationUrl: null,
            securityServices: [],
            resourceTypes: [],
          },
    driftFlags: [],
  },
  lastSuccessAt: at,
});

/**
 * Arranges an enrolled system.
 *
 * @param facts - what the entry says about itself
 * @returns the enrolled system, in the shape the public API renders
 */
const arrange = (facts: SystemFacts): EnrolledSystem => ({
  enrolmentId: `enrolment-${facts.id}`,
  tags: [],
  confirmedAt: facts.confirmedAt,
  system: {
    id: facts.id,
    organisationId: `organisation-${facts.organisationName}`,
    name: facts.name,
    description: facts.description ?? "",
    kinds: facts.fhirBaseUrl === undefined ? ["client"] : ["server"],
    serverProfile:
      facts.fhirBaseUrl === undefined
        ? null
        : {
            fhirBaseUrl: facts.fhirBaseUrl,
            authorizationMode: "smart",
            registrationMode: "manual",
            notes: "",
          },
    clientProfile:
      facts.fhirBaseUrl === undefined
        ? {
            launchUrl: "https://smartforms.test/launch",
            redirectUris: ["https://smartforms.test/callback"],
            scopes: ["launch/patient"],
            confidentiality: "public",
            launchContext: "patient",
            needsIntrospection: false,
          }
        : null,
  },
  organisation: {
    id: `organisation-${facts.organisationName}`,
    name: facts.organisationName,
  },
  check: facts.check ?? null,
});

/** The MediRecords server the worked example's first brand publishes. */
const mediRecords = arrange({
  id: "11111111-1111-4111-8111-111111111111",
  name: "MediRecords FHIR",
  organisationName: "MediRecords",
  description: "The MediRecords sandbox FHIR server.",
  fhirBaseUrl: "https://fhir.medirecords.test/r4",
  confirmedAt: "2026-08-15T01:00:00.000Z",
  check: checkReading("2026-08-17T02:00:00.000Z", "4.0.1"),
});

/** The reference server the worked example's second brand publishes. */
const referenceServer = arrange({
  id: "22222222-2222-4222-8222-222222222222",
  name: "Sparked Reference Server",
  organisationName: "CSIRO",
  fhirBaseUrl: "https://reference.sparked.test/fhir",
  confirmedAt: "2026-08-16T03:00:00.000Z",
  check: checkReading("2026-08-16T04:00:00.000Z", "4.0.1"),
});

/** A client enrolled in the same event, which is not a brand. */
const smartForms = arrange({
  id: "33333333-3333-4333-8333-333333333333",
  name: "Smart Forms",
  organisationName: "CSIRO",
  confirmedAt: "2026-08-16T03:00:00.000Z",
});

/**
 * Builds a bundle from the given systems.
 *
 * @param systems - the systems enrolled in the event
 * @param overrides - anything else to vary
 * @returns the bundle
 */
const build = (
  systems: readonly EnrolledSystem[],
  overrides: Partial<BrandsBundleFacts> = {},
): Bundle =>
  buildBrandsBundle({
    eventSlug,
    systems,
    publicUrl,
    generatedAt,
    ...overrides,
  });

/**
 * Reads the resources of one type out of a bundle.
 *
 * @param bundle - the bundle to read
 * @param resourceType - the type to keep
 * @returns the resources, in bundle order
 */
const resourcesOf = <Resource extends Endpoint | Organization>(
  bundle: Bundle,
  resourceType: Resource["resourceType"],
): Resource[] =>
  (bundle.entry ?? [])
    .map((entry) => entry.resource)
    .filter(
      (resource): resource is Resource =>
        resource?.resourceType === resourceType,
    );

describe("buildBrandsBundle", () => {
  // FR-022, acceptance scenario 2: the bundle a validator has read, entry for
  // entry, rather than the shape this author remembers.
  test("builds the worked example the validator accepted", () => {
    expect(build([mediRecords, referenceServer, smartForms])).toEqual(
      exampleBundle,
    );
  });

  // Acceptance scenario 3, the half that is about kind rather than enrolment: a
  // client has no FHIR endpoint to publish, so it is not a brand.
  test("leaves an enrolled client out of the bundle", () => {
    const bundle = build([smartForms]);

    // FHIR forbids an empty array, so a bundle with nothing in it has no entry.
    expect(bundle.entry).toBeUndefined();
    // Nothing changed, so the bundle is timed at the moment it was built.
    expect(bundle.timestamp).toBe(generatedAt.toISOString());
    // Nothing is published, so nothing is unpublishable: the empty bundle still
    // satisfies the profile and still says so.
    expect(bundle.meta?.profile).toEqual([
      "http://hl7.org/fhir/smart-app-launch/StructureDefinition/user-access-brands-bundle",
    ]);
  });

  // FR-022: the bundle is per event, so every identity in it names the event.
  test("scopes the bundle and its entries to the event", () => {
    const bundle = build([mediRecords], { eventSlug: "lapse-demo-2026" });

    expect(bundle.id).toBe("brands-lapse-demo-2026");
    expect(bundle.entry?.[0]?.fullUrl).toBe(
      `${publicUrl}/api/events/lapse-demo-2026/Organization/${mediRecords.system.id}`,
    );
    expect(
      resourcesOf<Organization>(bundle, "Organization")[0]?.identifier,
    ).toEqual([
      {
        system: "urn:ietf:rfc:3986",
        value: `${publicUrl}/events/lapse-demo-2026/systems/${mediRecords.system.id}`,
      },
    ]);
  });

  // The linkage the profile requires: a brand references its endpoints, and the
  // reference resolves inside the bundle rather than dangling.
  test("links each brand to an endpoint present in the bundle", () => {
    const bundle = build([mediRecords, referenceServer]);
    const identities = new Set(
      (bundle.entry ?? []).map((entry) => entry.fullUrl),
    );

    const brands = resourcesOf<Organization>(bundle, "Organization");
    expect(brands).toHaveLength(2);
    for (const brand of brands) {
      const references = (brand.endpoint ?? []).map((endpoint) =>
        String(endpoint.reference),
      );
      expect(references).toHaveLength(1);
      for (const reference of references) {
        expect(
          identities.has(`${publicUrl}/api/events/${eventSlug}/${reference}`),
        ).toBe(true);
      }
      // The same endpoint is named under the portal it belongs to.
      const portal = (brand.extension ?? []).find(
        (extension) =>
          extension.url ===
          "http://hl7.org/fhir/StructureDefinition/organization-portal",
      );
      expect(
        portal?.extension?.find((part) => part.url === "portalEndpoint")
          ?.valueReference?.reference,
      ).toBe(references[0]);
    }
    expect(
      resourcesOf<Endpoint>(bundle, "Endpoint").map(
        (endpoint) => endpoint.address,
      ),
    ).toEqual([
      "https://fhir.medirecords.test/r4",
      "https://reference.sparked.test/fhir",
    ]);
  });

  // Deny by default applied to a published fact: a server nothing has read a
  // capability statement from does not get a FHIR version invented for it, and
  // the bundle then stops claiming conformance it cannot deliver.
  test("publishes no FHIR version for a server nothing has read one from", () => {
    const unchecked = arrange({
      id: "44444444-4444-4444-8444-444444444444",
      name: "Unchecked FHIR",
      organisationName: "MediRecords",
      fhirBaseUrl: "https://unchecked.test/fhir",
      confirmedAt: "2026-08-16T03:00:00.000Z",
    });

    const bundle = build([unchecked]);

    expect(
      resourcesOf<Endpoint>(bundle, "Endpoint")[0]?.extension,
    ).toBeUndefined();
    expect(bundle.meta?.profile).toBeUndefined();
  });

  // A server may advertise a version the R4 value set the profile binds to does
  // not contain. Publishing it would make the bundle invalid, so it is treated
  // as unknown rather than passed through.
  test("publishes no FHIR version the R4 value set does not contain", () => {
    const release5 = arrange({
      id: "55555555-5555-4555-8555-555555555555",
      name: "R5 FHIR",
      organisationName: "MediRecords",
      fhirBaseUrl: "https://r5.test/fhir",
      confirmedAt: "2026-08-16T03:00:00.000Z",
      check: checkReading("2026-08-17T02:00:00.000Z", "5.0.0"),
    });

    const bundle = build([release5]);

    expect(
      resourcesOf<Endpoint>(bundle, "Endpoint")[0]?.extension,
    ).toBeUndefined();
    expect(bundle.meta?.profile).toBeUndefined();
  });

  // What the timestamp is for: an app caches the bundle and re-fetches when the
  // contents have changed, so it is the most recent change and not the moment of
  // the request.
  test("times the bundle and its resources at the most recent change", () => {
    const bundle = build([mediRecords, referenceServer]);

    expect(bundle.timestamp).toBe("2026-08-17T02:00:00.000Z");
    expect(bundle.meta?.lastUpdated).toBe("2026-08-17T02:00:00.000Z");
    expect(
      resourcesOf<Organization>(bundle, "Organization").map(
        (brand) => brand.meta?.lastUpdated,
      ),
    ).toEqual(["2026-08-17T02:00:00.000Z", "2026-08-16T04:00:00.000Z"]);
  });

  // FR-007: a bundle is an anonymous artefact, and there is no field in it that
  // a contact detail could reach even when the caller was handed some.
  test("carries no contact detail even when the entry has them", () => {
    const withContacts: EnrolledSystem = {
      ...mediRecords,
      contacts: [
        {
          accountId: "account-1",
          displayName: "Server Owner",
          email: "serverowner@example.org",
        },
      ],
    };

    const serialised = JSON.stringify(build([withContacts]));

    expect(serialised).not.toContain("serverowner@example.org");
    expect(serialised).not.toContain("Server Owner");
  });
});
