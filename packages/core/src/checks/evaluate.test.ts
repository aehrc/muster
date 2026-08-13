/**
 * What a verification check concludes, judged without a network.
 *
 * Everything User Story 3 promises a reader is decided here: whether a server answered,
 * why it did not, what it advertises, where that disagrees with what its owner declared,
 * and which of a client's scopes it will not honour. Each of those is a claim shown on a
 * public page, so each is decided by a pure function over documents and refusals rather
 * than inside the scheduler that fetched them.
 *
 * Four requirements sit on this module. FR-017: record reachability, fetch time and
 * advertised capabilities from the SMART configuration *and* the CapabilityStatement.
 * FR-018: name both values when a declared detail and an advertised one disagree.
 * FR-019: name the scopes a server does not advertise. FR-020, read from the other end: a
 * refusal by the guard is `guarded`, and it is distinct from a server that was slow
 * (`timeout`) and from one that refused the connection (`refused`) - the spec's own edge
 * case.
 *
 * Author: John Grimes
 */

import { describe, expect, it } from "bun:test";

import {
  capabilityStatementUrl,
  checkFailureMode,
  detectDrift,
  evaluateCheck,
  extractCapabilityHighlights,
  extractDiscoveryHighlights,
  smartConfigurationUrl,
  unsupportedScopes,
} from "./evaluate.js";

import type {
  CheckEvaluationInput,
  DeclaredServerDetails,
  DiscoveryHighlights,
  OutboundFailureReason,
} from "./evaluate.js";

/** A smart-configuration as a reasonably complete server serves one. */
const SMART_CONFIGURATION = {
  issuer: "https://fhir.example.com",
  jwks_uri: "https://fhir.example.com/.well-known/jwks.json",
  authorization_endpoint: "https://fhir.example.com/auth/authorize",
  token_endpoint: "https://fhir.example.com/auth/token",
  registration_endpoint: "https://fhir.example.com/auth/register",
  introspection_endpoint: "https://fhir.example.com/auth/introspect",
  grant_types_supported: ["authorization_code", "client_credentials"],
  scopes_supported: ["launch", "openid", "fhirUser", "patient/*.rs"],
  capabilities: ["launch-standalone", "permission-v2", "client-public"],
  smart_permission_ticket_types_supported: ["patient-self-access"],
  code_challenge_methods_supported: ["S256"],
};

/** A CapabilityStatement with the SMART oauth-uris extension. */
const CAPABILITY_STATEMENT = {
  resourceType: "CapabilityStatement",
  status: "active",
  date: "2026-08-01",
  kind: "instance",
  fhirVersion: "4.0.1",
  format: ["json"],
  software: { name: "Beda EMR", version: "3.2.1" },
  implementation: {
    description: "Beda EMR FHIR endpoint",
    url: "https://fhir.example.com",
  },
  rest: [
    {
      mode: "server",
      security: {
        extension: [
          {
            url: "http://fhir-registry.smarthealthit.org/StructureDefinition/oauth-uris",
            extension: [
              {
                url: "authorize",
                valueUri: "https://fhir.example.com/auth/authorize",
              },
              { url: "token", valueUri: "https://fhir.example.com/auth/token" },
              {
                url: "register",
                valueUri: "https://fhir.example.com/auth/register",
              },
            ],
          },
        ],
      },
      resource: [
        { type: "Patient" },
        { type: "Observation" },
        { type: "QuestionnaireResponse" },
      ],
    },
  ],
};

/** What the fixture server's owner declared, agreeing with the documents above. */
const DECLARED: DeclaredServerDetails = {
  fhirBaseUrl: "https://fhir.example.com",
  authorizationMode: "smart",
  authorizationEndpoint: "https://fhir.example.com/auth/authorize",
  tokenEndpoint: "https://fhir.example.com/auth/token",
  registrationEndpoint: "https://fhir.example.com/auth/register",
};

/** A successful fetch of a document. */
function answered(document: unknown, status = 200) {
  return { ok: true as const, status, body: JSON.stringify(document) };
}

/** A refusal from the guard. */
function refused(reason: OutboundFailureReason, description = "refused") {
  return { ok: false as const, reason, description };
}

/** Both documents fetched successfully, with declared details that agree. */
function healthyInput(
  overrides: Partial<CheckEvaluationInput> = {},
): CheckEvaluationInput {
  return {
    declared: DECLARED,
    discovery: answered(SMART_CONFIGURATION),
    capability: answered(CAPABILITY_STATEMENT),
    ...overrides,
  };
}

describe("the well-known addresses", () => {
  it("appends the SMART configuration path to the FHIR base URL", () => {
    expect(smartConfigurationUrl("https://fhir.example.com/r4")).toBe(
      "https://fhir.example.com/r4/.well-known/smart-configuration",
    );
  });

  it("appends the CapabilityStatement path to the FHIR base URL", () => {
    expect(capabilityStatementUrl("https://fhir.example.com/r4")).toBe(
      "https://fhir.example.com/r4/metadata",
    );
  });

  it("does not double a trailing slash", () => {
    // A participant who typed the base URL with a trailing slash gets the same two
    // addresses as one who did not; `//metadata` is a different path on some servers.
    expect(smartConfigurationUrl("https://fhir.example.com/r4/")).toBe(
      "https://fhir.example.com/r4/.well-known/smart-configuration",
    );
    expect(capabilityStatementUrl("https://fhir.example.com/r4/")).toBe(
      "https://fhir.example.com/r4/metadata",
    );
  });
});

describe("checkFailureMode", () => {
  it("reports a slow server as a timeout, distinctly from a dead one", () => {
    // The spec's own edge case: "checks time out and record unreachable (timeout)
    // distinctly from connection refusal". They are different problems for the owner.
    expect(checkFailureMode("timeout")).toBe("timeout");
    expect(checkFailureMode("refused")).toBe("refused");
  });

  it("reports every guard refusal as guarded", () => {
    // FR-020 and scenario 5: the address was refused and no request was made, so the
    // entry is flagged rather than the server blamed.
    for (const reason of [
      "not-a-url",
      "insecure-scheme",
      "userinfo",
      "blocked-address",
      "redirect-not-followed",
      "too-many-redirects",
    ] as const) {
      expect(checkFailureMode(reason)).toBe("guarded");
    }
  });

  it("reports a name that does not resolve as refused rather than guarded", () => {
    // `guarded` says "your address is private or internal", which would be a false
    // accusation against a typo. Nothing to reach is the same class of problem as a
    // connection that failed.
    expect(checkFailureMode("unresolvable")).toBe("refused");
  });

  it("reports an oversized response as invalid", () => {
    expect(checkFailureMode("too-large")).toBe("invalid");
  });
});

describe("extractDiscoveryHighlights", () => {
  it("takes every highlight the event view and system detail show", () => {
    const highlights = extractDiscoveryHighlights(
      JSON.stringify(SMART_CONFIGURATION),
    );

    expect(highlights).toEqual({
      issuer: "https://fhir.example.com",
      authorizationEndpoint: "https://fhir.example.com/auth/authorize",
      tokenEndpoint: "https://fhir.example.com/auth/token",
      registrationEndpoint: "https://fhir.example.com/auth/register",
      introspectionEndpoint: "https://fhir.example.com/auth/introspect",
      jwksUri: "https://fhir.example.com/.well-known/jwks.json",
      scopesSupported: ["launch", "openid", "fhirUser", "patient/*.rs"],
      capabilities: ["launch-standalone", "permission-v2", "client-public"],
      grantTypesSupported: ["authorization_code", "client_credentials"],
      permissionTicketTypesSupported: ["patient-self-access"],
    } satisfies DiscoveryHighlights);
  });

  it("captures the permission ticket types a server advertises", () => {
    // Read now and surfaced by User Story 8 (FR-034). Capturing it here means the ticket
    // playground reads a recorded fact rather than re-fetching every server.
    const highlights = extractDiscoveryHighlights(
      JSON.stringify({
        token_endpoint: "https://fhir.example.com/token",
        smart_permission_ticket_types_supported: [
          "patient-self-access",
          "care-team-access",
        ],
      }),
    );

    expect(highlights?.permissionTicketTypesSupported).toEqual([
      "patient-self-access",
      "care-team-access",
    ]);
  });

  it("reports an absent field as null and an absent list as empty", () => {
    // Absent is not the same claim as empty, but a reader needs one shape. Null for a
    // single value and an empty list for a list is the shape the pages render.
    const highlights = extractDiscoveryHighlights(
      JSON.stringify({ token_endpoint: "https://fhir.example.com/token" }),
    );

    expect(highlights?.tokenEndpoint).toBe("https://fhir.example.com/token");
    expect(highlights?.authorizationEndpoint).toBeNull();
    expect(highlights?.scopesSupported).toEqual([]);
    expect(highlights?.permissionTicketTypesSupported).toEqual([]);
  });

  it("ignores a value of the wrong type rather than recording it", () => {
    // A server that answers `scopes_supported: "launch openid"` has broken the contract.
    // Recording the string as a one-element list would then feed a scope warning that
    // named every scope the client asked for.
    const highlights = extractDiscoveryHighlights(
      JSON.stringify({
        token_endpoint: 42,
        scopes_supported: "launch openid",
        capabilities: [1, "launch-standalone", null],
      }),
    );

    expect(highlights?.tokenEndpoint).toBeNull();
    expect(highlights?.scopesSupported).toEqual([]);
    expect(highlights?.capabilities).toEqual(["launch-standalone"]);
  });

  it("refuses anything that is not a JSON object", () => {
    expect(extractDiscoveryHighlights("<html>not json</html>")).toBeUndefined();
    expect(extractDiscoveryHighlights("[]")).toBeUndefined();
    expect(extractDiscoveryHighlights("null")).toBeUndefined();
    expect(extractDiscoveryHighlights("")).toBeUndefined();
  });
});

describe("extractCapabilityHighlights", () => {
  it("takes the software, the version and the resource types", () => {
    const highlights = extractCapabilityHighlights(
      JSON.stringify(CAPABILITY_STATEMENT),
    );

    expect(highlights).toEqual({
      fhirVersion: "4.0.1",
      softwareName: "Beda EMR",
      softwareVersion: "3.2.1",
      implementationUrl: "https://fhir.example.com",
      resourceTypes: ["Observation", "Patient", "QuestionnaireResponse"],
      smartAuthorizationEndpoint: "https://fhir.example.com/auth/authorize",
      smartTokenEndpoint: "https://fhir.example.com/auth/token",
      smartRegisterEndpoint: "https://fhir.example.com/auth/register",
    });
  });

  it("reports the resource types in a stable order", () => {
    // Sorted, so that two checks of an unchanged server produce identical records and a
    // reader comparing them sees no difference where there is none.
    const highlights = extractCapabilityHighlights(
      JSON.stringify({
        resourceType: "CapabilityStatement",
        rest: [{ mode: "server", resource: [{ type: "Patient" }] }],
      }),
    );

    expect(highlights?.resourceTypes).toEqual(["Patient"]);
  });

  it("records nothing about SMART when the oauth-uris extension is absent", () => {
    const highlights = extractCapabilityHighlights(
      JSON.stringify({
        resourceType: "CapabilityStatement",
        fhirVersion: "4.0.1",
        rest: [{ mode: "server" }],
      }),
    );

    expect(highlights?.smartAuthorizationEndpoint).toBeNull();
    expect(highlights?.smartTokenEndpoint).toBeNull();
    expect(highlights?.smartRegisterEndpoint).toBeNull();
    expect(highlights?.resourceTypes).toEqual([]);
  });

  it("refuses a document that is not a CapabilityStatement", () => {
    // A server that answers an OperationOutcome at `/metadata` has not told us what it
    // supports, and recording an empty highlight set would say it supports nothing.
    expect(
      extractCapabilityHighlights(
        JSON.stringify({ resourceType: "OperationOutcome", issue: [] }),
      ),
    ).toBeUndefined();
    expect(extractCapabilityHighlights("not json")).toBeUndefined();
  });
});

describe("detectDrift", () => {
  const discovery = extractDiscoveryHighlights(
    JSON.stringify(SMART_CONFIGURATION),
  )!;
  const capability = extractCapabilityHighlights(
    JSON.stringify(CAPABILITY_STATEMENT),
  )!;

  it("finds nothing when the declaration matches what is advertised", () => {
    expect(detectDrift(DECLARED, discovery, capability)).toEqual([]);
  });

  it("names both values when a declared token endpoint differs (FR-018)", () => {
    // Quickstart scenario 5 step 1, and the wireframe's own example. Both values,
    // because "there is drift" is not something an owner can act on.
    const flags = detectDrift(
      { ...DECLARED, tokenEndpoint: "https://fhir.example.com/oauth/token" },
      discovery,
      capability,
    );

    expect(flags).toEqual([
      {
        field: "tokenEndpoint",
        declared: "https://fhir.example.com/oauth/token",
        advertised: "https://fhir.example.com/auth/token",
      },
    ]);
  });

  it("names a declared authorization endpoint that differs (spec scenario 3)", () => {
    const flags = detectDrift(
      {
        ...DECLARED,
        authorizationEndpoint: "https://fhir.example.com/oauth/authorize",
      },
      discovery,
      capability,
    );

    expect(flags).toEqual([
      {
        field: "authorizationEndpoint",
        declared: "https://fhir.example.com/oauth/authorize",
        advertised: "https://fhir.example.com/auth/authorize",
      },
    ]);
  });

  it("names a registration endpoint that differs from the advertised one", () => {
    // The one that matters most for User Story 5: a statement presented to an endpoint
    // the server does not advertise is a registration attempt against nothing.
    const flags = detectDrift(
      {
        ...DECLARED,
        registrationEndpoint: "https://fhir.example.com/dcr",
      },
      discovery,
      capability,
    );

    expect(flags).toEqual([
      {
        field: "registrationEndpoint",
        declared: "https://fhir.example.com/dcr",
        advertised: "https://fhir.example.com/auth/register",
      },
    ]);
  });

  it("names a FHIR base URL that differs from the CapabilityStatement's own", () => {
    // The CapabilityStatement's `implementation.url` is the server's statement of where
    // it lives, so a directory entry pointing somewhere else is pointing at a proxy, a
    // stale address, or the wrong server (FR-017: both documents are fetched).
    const flags = detectDrift(
      { ...DECLARED, fhirBaseUrl: "https://old.example.com/r4" },
      discovery,
      capability,
    );

    expect(flags).toEqual([
      {
        field: "fhirBaseUrl",
        declared: "https://old.example.com/r4",
        advertised: "https://fhir.example.com",
      },
    ]);
  });

  it("names an authorization mode declared open by a server advertising SMART", () => {
    // An entry saying "no authorization needed" in front of a server with a token
    // endpoint sends every app owner down the wrong path.
    const flags = detectDrift(
      {
        fhirBaseUrl: "https://fhir.example.com",
        authorizationMode: "open",
      },
      discovery,
      capability,
    );

    expect(flags).toEqual([
      { field: "authorizationMode", declared: "open", advertised: "smart" },
    ]);
  });

  it("does not flag an open server that advertises no token endpoint", () => {
    const openDiscovery = extractDiscoveryHighlights("{}") ?? null;
    expect(
      detectDrift(
        { fhirBaseUrl: "https://fhir.example.com", authorizationMode: "open" },
        openDiscovery,
        null,
      ),
    ).toEqual([]);
  });

  it("stays silent about anything the server did not advertise", () => {
    // Absence is not disagreement. A server that serves no smart-configuration has said
    // nothing about its token endpoint, and flagging that would put a drift badge on
    // every entry whose server happens to be an open FHIR endpoint.
    expect(detectDrift(DECLARED, null, null)).toEqual([]);
  });

  it("stays silent about anything the owner did not declare", () => {
    const flags = detectDrift(
      {
        fhirBaseUrl: "https://fhir.example.com",
        authorizationMode: "smart",
        authorizationEndpoint: null,
        tokenEndpoint: null,
        registrationEndpoint: null,
      },
      discovery,
      capability,
    );

    expect(flags).toEqual([]);
  });

  it("treats two spellings of one URL as agreement", () => {
    // A trailing slash and an upper-case host are the same address. A drift flag whose
    // two values look identical to a reader is worse than no flag: it teaches them to
    // ignore the ones that matter.
    expect(
      detectDrift(
        { ...DECLARED, tokenEndpoint: "https://FHIR.example.com/auth/token/" },
        discovery,
        capability,
      ),
    ).toEqual([]);
  });

  it("reports every disagreement, in a stable order", () => {
    const flags = detectDrift(
      {
        fhirBaseUrl: "https://old.example.com/r4",
        authorizationMode: "open",
        authorizationEndpoint: "https://old.example.com/authorize",
        tokenEndpoint: "https://old.example.com/token",
        registrationEndpoint: "https://old.example.com/register",
      },
      discovery,
      capability,
    );

    expect(flags.map((flag) => flag.field)).toEqual([
      "fhirBaseUrl",
      "authorizationMode",
      "authorizationEndpoint",
      "tokenEndpoint",
      "registrationEndpoint",
    ]);
  });
});

describe("unsupportedScopes", () => {
  it("names the scopes a server does not advertise (FR-019)", () => {
    // The wireframe's own example: one scope out of six, named.
    expect(
      unsupportedScopes(
        [
          "launch",
          "openid",
          "fhirUser",
          "patient/QuestionnaireResponse.crus",
        ],
        ["launch", "openid", "fhirUser", "patient/Patient.rs"],
      ),
    ).toEqual(["patient/QuestionnaireResponse.crus"]);
  });

  it("finds nothing when every requested scope is advertised", () => {
    expect(
      unsupportedScopes(["launch", "openid"], ["launch", "openid", "fhirUser"]),
    ).toEqual([]);
  });

  it("makes no claim when the server has advertised no scopes", () => {
    // Nothing has been checked, or the server serves no smart-configuration. A warning
    // naming every scope the client asked for would be a claim rather than an absence.
    expect(unsupportedScopes(["launch", "openid"], null)).toEqual([]);
    expect(unsupportedScopes(["launch", "openid"], [])).toEqual([]);
  });

  it("honours a wildcard resource in an advertised scope", () => {
    // A server advertising `patient/*.rs` supports reading any resource in the patient
    // compartment. Naming `patient/Observation.rs` as unsupported would be a false
    // warning, which at a connectathon costs somebody an afternoon.
    expect(
      unsupportedScopes(
        ["patient/Observation.rs", "patient/Patient.r"],
        ["patient/*.rs"],
      ),
    ).toEqual([]);
  });

  it("names a scope asking for more than the wildcard grants", () => {
    expect(
      unsupportedScopes(["patient/Observation.cruds"], ["patient/*.rs"]),
    ).toEqual(["patient/Observation.cruds"]);
  });

  it("does not let one compartment cover another", () => {
    expect(unsupportedScopes(["user/Patient.rs"], ["patient/*.rs"])).toEqual([
      "user/Patient.rs",
    ]);
  });

  it("reads the version 1 permission spellings as their version 2 equivalents", () => {
    // SMART 2.0's own mapping: `.read` is `.rs`, `.write` is `.cud`, `.*` is `.cruds`.
    // A server still advertising v1 scopes supports the v2 spelling of the same thing.
    expect(unsupportedScopes(["patient/Patient.rs"], ["patient/*.read"])).toEqual(
      [],
    );
    expect(unsupportedScopes(["patient/Patient.cud"], ["patient/*.write"])).toEqual(
      [],
    );
    expect(
      unsupportedScopes(["patient/Patient.cruds"], ["patient/*.*"]),
    ).toEqual([]);
    expect(unsupportedScopes(["patient/Patient.c"], ["patient/*.read"])).toEqual([
      "patient/Patient.c",
    ]);
  });

  it("names a scope once however many times it was asked for", () => {
    expect(
      unsupportedScopes(["system/*.rs", "system/*.rs"], ["launch"]),
    ).toEqual(["system/*.rs"]);
  });
});

describe("evaluateCheck", () => {
  it("reports a reachable server with both documents and no failure", () => {
    const evaluation = evaluateCheck(healthyInput());

    expect(evaluation.reachable).toBe(true);
    expect(evaluation.failureMode).toBeNull();
    expect(evaluation.detail).toBeNull();
    expect(evaluation.discovery?.tokenEndpoint).toBe(
      "https://fhir.example.com/auth/token",
    );
    expect(evaluation.capability?.softwareName).toBe("Beda EMR");
    expect(evaluation.driftFlags).toEqual([]);
  });

  it("flags the drift it found on a reachable server (scenario 3)", () => {
    const evaluation = evaluateCheck(
      healthyInput({
        declared: {
          ...DECLARED,
          tokenEndpoint: "https://fhir.example.com/oauth/token",
        },
      }),
    );

    expect(evaluation.reachable).toBe(true);
    expect(evaluation.driftFlags).toEqual([
      {
        field: "tokenEndpoint",
        declared: "https://fhir.example.com/oauth/token",
        advertised: "https://fhir.example.com/auth/token",
      },
    ]);
  });

  it("counts a server that serves only a CapabilityStatement as reachable", () => {
    // An open FHIR endpoint has no smart-configuration to serve, and it is not
    // unreachable. The detail says which document was missing, so the reader is not
    // left guessing why the endpoints are blank.
    const evaluation = evaluateCheck(
      healthyInput({
        declared: {
          fhirBaseUrl: "https://fhir.example.com",
          authorizationMode: "open",
        },
        discovery: answered({ error: "not found" }, 404),
      }),
    );

    expect(evaluation.reachable).toBe(true);
    expect(evaluation.failureMode).toBeNull();
    expect(evaluation.discovery).toBeNull();
    expect(evaluation.capability).not.toBeNull();
    expect(evaluation.detail).toContain("404");
  });

  it("records a guarded address without blaming the server (scenario 5)", () => {
    const evaluation = evaluateCheck(
      healthyInput({
        discovery: refused(
          "blocked-address",
          "10.0.0.4 is not a publicly routable address",
        ),
        capability: refused(
          "blocked-address",
          "10.0.0.4 is not a publicly routable address",
        ),
      }),
    );

    expect(evaluation.reachable).toBe(false);
    expect(evaluation.failureMode).toBe("guarded");
    expect(evaluation.detail).toContain("publicly routable");
    expect(evaluation.discovery).toBeNull();
    expect(evaluation.capability).toBeNull();
    expect(evaluation.driftFlags).toEqual([]);
  });

  it("distinguishes a slow server from one that refused the connection", () => {
    const slow = evaluateCheck(
      healthyInput({
        discovery: refused("timeout", "did not answer in time"),
        capability: refused("timeout", "did not answer in time"),
      }),
    );
    const dead = evaluateCheck(
      healthyInput({
        discovery: refused("refused", "connection refused"),
        capability: refused("refused", "connection refused"),
      }),
    );

    expect(slow.failureMode).toBe("timeout");
    expect(dead.failureMode).toBe("refused");
  });

  it("prefers the most specific cause when the two fetches disagree", () => {
    // A guarded address is the thing to say: it means Muster sent nothing and the entry
    // is what needs fixing, which no amount of detail about the other fetch changes.
    const evaluation = evaluateCheck(
      healthyInput({
        discovery: refused("timeout", "did not answer in time"),
        capability: refused("blocked-address", "not publicly routable"),
      }),
    );

    expect(evaluation.failureMode).toBe("guarded");
  });

  it("reports a server that answered with nothing usable as invalid", () => {
    const evaluation = evaluateCheck(
      healthyInput({
        discovery: answered({ error: "gone" }, 500),
        capability: { ok: true, status: 200, body: "<html>login</html>" },
      }),
    );

    expect(evaluation.reachable).toBe(false);
    expect(evaluation.failureMode).toBe("invalid");
    expect(evaluation.detail).toContain("500");
  });

  it("does not flag drift against a server it could not reach", () => {
    // Nothing was advertised, so nothing disagrees. A drift flag here would blame the
    // owner for the check having failed.
    const evaluation = evaluateCheck(
      healthyInput({
        declared: { ...DECLARED, tokenEndpoint: "https://elsewhere/token" },
        discovery: refused("timeout"),
        capability: refused("timeout"),
      }),
    );

    expect(evaluation.driftFlags).toEqual([]);
  });
});
