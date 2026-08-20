/*
 * Copyright © 2026 Commonwealth Scientific and Industrial Research Organisation
 * (CSIRO) ABN 41 687 119 230. Licensed under the Apache License, Version 2.0.
 */

import { serverProfileSchema } from "@muster/contracts";
import { describe, expect, test } from "bun:test";

import {
  allowlistedHost,
  authoriseParticipantEndpoints,
  authoriseServerProfileEndpoints,
} from "./endpoints.ts";

/**
 * The endpoint scheme rule.
 *
 * A participant's endpoint is https, because Muster posts signed artefacts to it
 * and reads security-relevant documents from it. The one relaxation is the
 * subject of most of these tests: a host named in `MUSTER_OUTBOUND_ALLOWLIST`
 * may be reached over http, which is what makes a local stack demonstrable
 * without a certificate. Everywhere else - which is every deployment, since the
 * allowlist is empty in one - an http endpoint is refused.
 */

/** The stack's stub, as the compose file names it. */
const stubAllowlist = ["register-stub:9090", "data-holder-stub"];

describe("allowlistedHost", () => {
  // A `host:port` entry is the whole authority, so it matches that port only.
  test("matches a host and port entry on that port", () => {
    expect(
      allowlistedHost("http://register-stub:9090/register", stubAllowlist),
    ).toBeTrue();
  });

  test("does not match a host and port entry on another port", () => {
    expect(
      allowlistedHost("http://register-stub:9091/register", stubAllowlist),
    ).toBeFalse();
  });

  // A bare host entry is the host, whatever port it is reached on.
  test("matches a bare host entry on any port", () => {
    expect(
      allowlistedHost("http://data-holder-stub:9091/token", stubAllowlist),
    ).toBeTrue();
    expect(
      allowlistedHost("http://data-holder-stub/token", stubAllowlist),
    ).toBeTrue();
  });

  // Host names are case-insensitive, and an entry typed in either case matches.
  test("matches regardless of case", () => {
    expect(
      allowlistedHost("http://Register-Stub:9090/", ["REGISTER-STUB:9090"]),
    ).toBeTrue();
  });

  test("matches nothing when the allowlist is empty", () => {
    expect(allowlistedHost("http://register-stub:9090/", [])).toBeFalse();
  });

  // `register-stub:9090` parses - as a URL with the scheme `register-stub:` and no
  // host at all - so what makes it match nothing is the empty host rather than a
  // parse failure. Both are refusals, and both are worth pinning.
  test("matches nothing for a value with no host", () => {
    expect(allowlistedHost("register-stub:9090", stubAllowlist)).toBeFalse();
  });

  test("matches nothing for a value that is not a URL at all", () => {
    expect(allowlistedHost("not a url", stubAllowlist)).toBeFalse();
  });
});

describe("authoriseServerProfileEndpoints", () => {
  /** A profile with every endpoint a server can declare. */
  const profile = {
    fhirBaseUrl: "https://fhir.example.org",
    authorizationEndpoint: "https://auth.example.org/authorize",
    tokenEndpoint: "https://auth.example.org/token",
    registrationEndpoint: "https://auth.example.org/register",
  };

  test("permits a profile whose endpoints are all https", () => {
    expect(authoriseServerProfileEndpoints(profile, []).ok).toBeTrue();
  });

  test.each([
    "fhirBaseUrl",
    "authorizationEndpoint",
    "tokenEndpoint",
    "registrationEndpoint",
  ] as const)("checks %s", (field) => {
    const decision = authoriseServerProfileEndpoints(
      { ...profile, [field]: "http://fhir.example.org" },
      [],
    );

    expect(decision.ok).toBeFalse();
    if (!decision.ok) {
      expect(decision.refusal.detail).toContain(field);
    }
  });

  // A system with no server side has no endpoints to check.
  test.each([null, undefined])("permits %p", (absent) => {
    expect(authoriseServerProfileEndpoints(absent, []).ok).toBeTrue();
  });

  // The tripwire: the fields this rule checks are the fields the contract says a
  // server profile has, minus the ones that are not addresses. A profile that
  // gains an address fails here, which is the reminder to check it as well.
  test("checks every endpoint the contract defines", () => {
    const declared = Object.keys(serverProfileSchema.shape);

    expect(declared.toSorted()).toEqual(
      [
        "authorizationEndpoint",
        "authorizationMode",
        "fhirBaseUrl",
        "notes",
        "registrationEndpoint",
        "registrationMode",
        "tokenEndpoint",
      ].toSorted(),
    );
  });
});

describe("authoriseParticipantEndpoints", () => {
  test("permits https endpoints with an empty allowlist", () => {
    const decision = authoriseParticipantEndpoints(
      {
        fhirBaseUrl: "https://fhir.example.org",
        registrationEndpoint: "https://auth.example.org/register",
      },
      [],
    );

    expect(decision.ok).toBeTrue();
  });

  // The default everywhere, and the whole deployment case.
  test("refuses an http endpoint when no allowlist names its host", () => {
    const decision = authoriseParticipantEndpoints(
      { fhirBaseUrl: "http://fhir.example.org" },
      ["register-stub:9090"],
    );

    expect(decision.ok).toBeFalse();
    if (decision.ok) {
      return;
    }
    expect(decision.refusal.reason).toBe("insecure_endpoint");
    // The field, the value and the way to permit it deliberately: a refusal that
    // named none of the three would leave the member guessing.
    expect(decision.refusal.detail).toContain("fhirBaseUrl");
    expect(decision.refusal.detail).toContain("http://fhir.example.org");
    expect(decision.refusal.detail).toContain("MUSTER_OUTBOUND_ALLOWLIST");
  });

  test("permits an http endpoint whose host is allowlisted", () => {
    const decision = authoriseParticipantEndpoints(
      {
        fhirBaseUrl: "http://data-holder-stub:9091/fhir",
        registrationEndpoint: "http://register-stub:9090/register",
      },
      stubAllowlist,
    );

    expect(decision.ok).toBeTrue();
  });

  // One allowlisted endpoint does not carry the others.
  test("refuses the endpoint that is not allowlisted", () => {
    const decision = authoriseParticipantEndpoints(
      {
        fhirBaseUrl: "http://register-stub:9090/fhir",
        tokenEndpoint: "http://elsewhere.example.org/token",
      },
      stubAllowlist,
    );

    expect(decision.ok).toBeFalse();
    if (!decision.ok) {
      expect(decision.refusal.detail).toContain("tokenEndpoint");
    }
  });

  // Absent optional endpoints are not the rule's business.
  test("ignores endpoints that are absent", () => {
    const decision = authoriseParticipantEndpoints(
      {
        fhirBaseUrl: "https://fhir.example.org",
        tokenEndpoint: undefined,
        registrationEndpoint: null,
      },
      [],
    );

    expect(decision.ok).toBeTrue();
  });

  // Deny by default: an unparseable value is refused rather than passed on to
  // whatever parses next.
  test("refuses a value that is not a URL", () => {
    const decision = authoriseParticipantEndpoints(
      { fhirBaseUrl: "fhir.example.org" },
      [],
    );

    expect(decision.ok).toBeFalse();
    if (!decision.ok) {
      expect(decision.refusal.reason).toBe("insecure_endpoint");
    }
  });

  // A scheme that is neither http nor https is refused whatever the allowlist
  // says: the allowlist relaxes the transport, not the protocol.
  test("refuses a scheme that is not http or https", () => {
    const decision = authoriseParticipantEndpoints(
      { fhirBaseUrl: "ftp://register-stub:9090/fhir" },
      stubAllowlist,
    );

    expect(decision.ok).toBeFalse();
  });
});
