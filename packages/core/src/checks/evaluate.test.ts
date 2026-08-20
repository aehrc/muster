/*
 * Copyright © 2026 Commonwealth Scientific and Industrial Research Organisation
 * (CSIRO) ABN 41 687 119 230. Licensed under the Apache License, Version 2.0.
 */

import { describe, expect, test } from "bun:test";

import {
  capabilityHighlights,
  discoveryHighlights,
  driftFlags,
  evaluateCheck,
  evaluateCheckFailure,
  scopeWarning,
  unsupportedScopes,
} from "./evaluate.ts";

import type { CheckInput, ProbeOutcome } from "./evaluate.ts";
import type { ServerProfile } from "@muster/contracts";

/**
 * Check evaluation, with no network anywhere near it.
 *
 * Four things are pinned down here, and each is a promise the event view makes
 * to a reader. What a server advertises is read out of its own documents rather
 * than guessed. A disagreement between the entry and the server names both
 * values, so a participant can act on it without going and looking (FR-018). A
 * failure is classified as what it was - a timeout is not a refusal, and a
 * guarded address is a refusal Muster made before any request left (FR-020).
 * And a requested scope the server does not support is named, not inferred
 * (FR-019).
 */

/** A server entry declaring both of its SMART endpoints. */
const declared: ServerProfile = {
  fhirBaseUrl: "https://fhir.example.org",
  authorizationMode: "smart",
  registrationMode: "manual",
  authorizationEndpoint: "https://auth.example.org/authorize",
  tokenEndpoint: "https://auth.example.org/token",
  notes: "",
};

/** A server entry declaring nothing beyond its base URL. */
const bareDeclared: ServerProfile = {
  fhirBaseUrl: "https://fhir.example.org",
  authorizationMode: "smart",
  registrationMode: "manual",
  notes: "",
};

/** A SMART configuration document as a conformant server serves it. */
const configurationDocument = {
  issuer: "https://auth.example.org",
  authorization_endpoint: "https://auth.example.org/authorize",
  token_endpoint: "https://auth.example.org/token",
  registration_endpoint: "https://auth.example.org/register",
  scopes_supported: ["launch", "openid", "fhirUser", "patient/Patient.rs"],
  capabilities: ["launch-standalone", "client-public"],
};

/** A capability statement as a conformant server serves it. */
const capabilityStatement = {
  resourceType: "CapabilityStatement",
  status: "active",
  date: "2026-08-01",
  kind: "instance",
  fhirVersion: "4.0.1",
  format: ["json"],
  software: { name: "Example FHIR", version: "3.2.1" },
  implementation: {
    description: "The example server",
    url: "https://fhir.example.org",
  },
  rest: [
    {
      mode: "server",
      security: {
        service: [
          {
            coding: [
              {
                system:
                  "http://terminology.hl7.org/CodeSystem/restful-security-service",
                code: "SMART-on-FHIR",
              },
            ],
          },
        ],
      },
      resource: [{ type: "Patient" }, { type: "Observation" }],
    },
  ],
};

// A probe that returned a document.
const answered = (document: unknown): ProbeOutcome => ({ ok: true, document });

// The input of a check, defaulting to a wholly conformant server.
const input = (overrides: Partial<CheckInput> = {}): CheckInput => ({
  declared,
  discovery: answered(configurationDocument),
  capability: answered(capabilityStatement),
  ...overrides,
});

describe("discoveryHighlights", () => {
  // Acceptance scenario 1: the endpoints, the scopes and the capabilities, which
  // is what an app owner reads off the entry before writing any code.
  test("reads the endpoints, scopes and capabilities a server advertises", () => {
    expect(discoveryHighlights(configurationDocument)).toEqual({
      issuer: "https://auth.example.org",
      authorizationEndpoint: "https://auth.example.org/authorize",
      tokenEndpoint: "https://auth.example.org/token",
      registrationEndpoint: "https://auth.example.org/register",
      scopesSupported: ["launch", "openid", "fhirUser", "patient/Patient.rs"],
      capabilities: ["launch-standalone", "client-public"],
      permissionTicketTypesSupported: [],
    });
  });

  // A server that registers nobody advertises no registration endpoint, and the
  // absence is recorded as an absence rather than as an empty string.
  test("records an absent optional field as null", () => {
    const highlights = discoveryHighlights({
      token_endpoint: "https://auth.example.org/token",
    });

    expect(highlights).toEqual({
      issuer: null,
      authorizationEndpoint: null,
      tokenEndpoint: "https://auth.example.org/token",
      registrationEndpoint: null,
      scopesSupported: [],
      capabilities: [],
      permissionTicketTypesSupported: [],
    });
  });

  // Deny by default: something that is not a discovery document is not read as
  // one, and the caller classifies that as `invalid` rather than as reachable.
  test.each([
    ["a string", '"not a document"'],
    ["null", null],
    ["an array", []],
    [
      "an object with no endpoint at all",
      { issuer: "https://auth.example.org" },
    ],
  ])("refuses %s", (_description, document) => {
    expect(discoveryHighlights(document)).toBeUndefined();
  });

  // A document whose scopes are not all strings is read for the ones that are;
  // the alternative is discarding a whole usable document over one bad entry.
  test("keeps only the string entries of a list", () => {
    const highlights = discoveryHighlights({
      token_endpoint: "https://auth.example.org/token",
      scopes_supported: ["launch", 7, null, "openid"],
      capabilities: "not a list",
    });

    expect(highlights?.scopesSupported).toEqual(["launch", "openid"]);
    expect(highlights?.capabilities).toEqual([]);
  });
});

describe("capabilityHighlights", () => {
  test("reads the version, software, security services and resource types", () => {
    expect(capabilityHighlights(capabilityStatement)).toEqual({
      fhirVersion: "4.0.1",
      software: "Example FHIR 3.2.1",
      implementationUrl: "https://fhir.example.org",
      securityServices: ["SMART-on-FHIR"],
      resourceTypes: ["Patient", "Observation"],
    });
  });

  // The optional halves of the statement are optional, and their absence is not
  // a reason to discard what the statement does say.
  test("reads a statement that names only its version", () => {
    expect(
      capabilityHighlights({
        resourceType: "CapabilityStatement",
        status: "active",
        fhirVersion: "4.0.1",
      }),
    ).toEqual({
      fhirVersion: "4.0.1",
      software: null,
      implementationUrl: null,
      securityServices: [],
      resourceTypes: [],
    });
  });

  // Deny by default again: a resource of another type is not a capability
  // statement, however plausible its contents.
  test.each([
    ["another resource type", { resourceType: "Patient" }],
    ["an OperationOutcome", { resourceType: "OperationOutcome", issue: [] }],
    ["a bare object", { fhirVersion: "4.0.1" }],
    ["a string", "CapabilityStatement"],
  ])("refuses %s", (_description, document) => {
    expect(capabilityHighlights(document)).toBeUndefined();
  });
});

describe("driftFlags", () => {
  // FR-018 and acceptance scenario 3: the flag names both values, because a flag
  // that only said "the token endpoint disagrees" would send the reader looking.
  test("names the declared and the advertised value of a differing endpoint", () => {
    const flags = driftFlags(
      declared,
      {
        issuer: "https://auth.example.org",
        authorizationEndpoint: "https://auth.example.org/authorize",
        tokenEndpoint: "https://auth.example.org/oauth2/token",
        registrationEndpoint: null,
        scopesSupported: [],
        capabilities: [],
        permissionTicketTypesSupported: [],
      },
      null,
    );

    expect(flags).toEqual([
      {
        field: "tokenEndpoint",
        declared: "https://auth.example.org/token",
        advertised: "https://auth.example.org/oauth2/token",
      },
    ]);
  });

  // Agreement is agreement: nothing is flagged when the two match.
  test("flags nothing when the server advertises what the entry declares", () => {
    expect(
      driftFlags(
        declared,
        discoveryHighlights(configurationDocument) ?? null,
        capabilityHighlights(capabilityStatement) ?? null,
      ),
    ).toEqual([]);
  });

  // A trailing slash is not drift. Flagging it would train participants to
  // ignore the flags, which is worse than not having them.
  test("ignores a trailing slash", () => {
    expect(
      driftFlags(
        {
          ...declared,
          tokenEndpoint: "https://auth.example.org/token/",
          fhirBaseUrl: "https://fhir.example.org/",
        },
        discoveryHighlights(configurationDocument) ?? null,
        capabilityHighlights(capabilityStatement) ?? null,
      ),
    ).toEqual([]);
  });

  // A declared endpoint the server does not advertise at all is drift, and the
  // advertised side of the flag says so rather than being left out.
  test("flags a declared endpoint the server advertises nowhere", () => {
    expect(
      driftFlags(
        { ...declared, registrationEndpoint: "https://auth.example.org/dcr" },
        {
          issuer: null,
          authorizationEndpoint: "https://auth.example.org/authorize",
          tokenEndpoint: "https://auth.example.org/token",
          registrationEndpoint: null,
          scopesSupported: [],
          capabilities: [],
          permissionTicketTypesSupported: [],
        },
        null,
      ),
    ).toEqual([
      {
        field: "registrationEndpoint",
        declared: "https://auth.example.org/dcr",
        advertised: null,
      },
    ]);
  });

  // Nothing declared is nothing to disagree with: an entry that names only its
  // base URL is checked for reachability and not nagged about endpoints.
  test("flags nothing about endpoints the entry does not declare", () => {
    expect(
      driftFlags(
        bareDeclared,
        discoveryHighlights(configurationDocument) ?? null,
        capabilityHighlights(capabilityStatement) ?? null,
      ),
    ).toEqual([]);
  });

  // The FHIR base URL is checked against the statement the server serves at it,
  // which is the one place a server states its own address.
  test("flags a base URL the capability statement contradicts", () => {
    expect(
      driftFlags(bareDeclared, null, {
        fhirVersion: "4.0.1",
        software: null,
        implementationUrl: "https://other.example.org/fhir",
        securityServices: [],
        resourceTypes: [],
      }),
    ).toEqual([
      {
        field: "fhirBaseUrl",
        declared: "https://fhir.example.org",
        advertised: "https://other.example.org/fhir",
      },
    ]);
  });

  // An entry claiming no authorization while the server runs SMART is drift the
  // other way round, and an app owner needs to know before writing a launch.
  test("flags an entry declaring open authorization at a SMART server", () => {
    expect(
      driftFlags(
        { ...bareDeclared, authorizationMode: "open" },
        discoveryHighlights(configurationDocument) ?? null,
        null,
      ),
    ).toEqual([
      { field: "authorizationMode", declared: "open", advertised: "smart" },
    ]);
  });
});

describe("evaluateCheck", () => {
  // Acceptance scenario 1: both documents read, reachable, nothing to flag.
  test("reports a conformant server as reachable with both sets of highlights", () => {
    const evaluation = evaluateCheck(input());

    expect(evaluation.reachable).toBe(true);
    expect(evaluation.failureMode).toBeNull();
    expect(evaluation.detail).toBeNull();
    expect(evaluation.discovery?.tokenEndpoint).toBe(
      "https://auth.example.org/token",
    );
    expect(evaluation.capability?.fhirVersion).toBe("4.0.1");
    expect(evaluation.driftFlags).toEqual([]);
  });

  // Acceptance scenario 2, and the distinction the specification insists on: a
  // server that is slow is recorded as a timeout, not as a refusal.
  test("classifies a server that never answers as a timeout", () => {
    const evaluation = evaluateCheck(
      input({
        discovery: {
          ok: false,
          failureMode: "timeout",
          detail: "fhir.example.org did not answer within 10000ms",
        },
        capability: {
          ok: false,
          failureMode: "timeout",
          detail: "fhir.example.org did not answer within 10000ms",
        },
      }),
    );

    expect(evaluation.reachable).toBe(false);
    expect(evaluation.failureMode).toBe("timeout");
    expect(evaluation.detail).toBe(
      "fhir.example.org did not answer within 10000ms",
    );
    expect(evaluation.discovery).toBeNull();
    expect(evaluation.capability).toBeNull();
  });

  // The other half of that distinction: a refused connection is its own mode.
  test("classifies a refused connection as refused, not as a timeout", () => {
    const refused: ProbeOutcome = {
      ok: false,
      failureMode: "refused",
      detail: "Unable to connect",
    };
    const evaluation = evaluateCheck(
      input({ discovery: refused, capability: refused }),
    );

    expect(evaluation.failureMode).toBe("refused");
    expect(evaluation.reachable).toBe(false);
  });

  // Acceptance scenario 5 and FR-020: the guard's refusal is the check's result,
  // carrying the reason, and no highlights, because nothing was ever fetched.
  test("records a guarded address as a refusal naming its reason", () => {
    const guarded: ProbeOutcome = {
      ok: false,
      failureMode: "guarded",
      detail:
        "fhir.internal.example.org resolves to 10.1.2.3, which is a private address",
    };
    const evaluation = evaluateCheck(
      input({ discovery: guarded, capability: guarded }),
    );

    expect(evaluation.reachable).toBe(false);
    expect(evaluation.failureMode).toBe("guarded");
    expect(evaluation.detail).toContain("which is a private address");
    expect(evaluation.discovery).toBeNull();
    expect(evaluation.capability).toBeNull();
  });

  // When the two probes fail differently, the guarded refusal is the one worth
  // reporting: it is the one that says Muster itself declined to make a request.
  test("prefers the guarded classification when the probes disagree", () => {
    const evaluation = evaluateCheck(
      input({
        discovery: {
          ok: false,
          failureMode: "timeout",
          detail: "no answer in time",
        },
        capability: {
          ok: false,
          failureMode: "guarded",
          detail: "169.254.169.254 is a cloud metadata address",
        },
      }),
    );

    expect(evaluation.failureMode).toBe("guarded");
    expect(evaluation.detail).toBe(
      "169.254.169.254 is a cloud metadata address",
    );
  });

  // A server that answers with something that is not a SMART configuration and
  // not a capability statement has been reached and is still not usable.
  test("classifies unreadable documents as invalid", () => {
    const evaluation = evaluateCheck(
      input({
        discovery: answered({ hello: "world" }),
        capability: answered({ resourceType: "OperationOutcome", issue: [] }),
      }),
    );

    expect(evaluation.reachable).toBe(false);
    expect(evaluation.failureMode).toBe("invalid");
    expect(evaluation.detail).toBe(
      "The SMART configuration was not a discovery document, and the capability statement was not a CapabilityStatement.",
    );
  });

  // One probe answering is enough to call the entry reachable - an open server
  // has no SMART configuration to serve - but the other probe's failure is
  // reported rather than swallowed.
  test("stays reachable on one document and still reports the other's failure", () => {
    const evaluation = evaluateCheck(
      input({
        declared: bareDeclared,
        discovery: {
          ok: false,
          failureMode: "invalid",
          detail:
            "https://fhir.example.org/.well-known/smart-configuration answered 404",
        },
      }),
    );

    expect(evaluation.reachable).toBe(true);
    expect(evaluation.failureMode).toBeNull();
    expect(evaluation.detail).toBe(
      "https://fhir.example.org/.well-known/smart-configuration answered 404",
    );
    expect(evaluation.discovery).toBeNull();
    expect(evaluation.capability?.fhirVersion).toBe("4.0.1");
  });

  // Drift is part of the evaluation, not a separate pass, so a check either
  // records the disagreement or there is none to record.
  test("carries the drift flags of the entry it evaluated", () => {
    const evaluation = evaluateCheck(
      input({
        discovery: answered({
          ...configurationDocument,
          token_endpoint: "https://auth.example.org/v2/token",
        }),
      }),
    );

    expect(evaluation.driftFlags).toEqual([
      {
        field: "tokenEndpoint",
        declared: "https://auth.example.org/token",
        advertised: "https://auth.example.org/v2/token",
      },
    ]);
  });
});

describe("evaluateCheckFailure", () => {
  // A target the guard refuses before either probe is even attempted still
  // produces a check: the entry is flagged rather than silently left blank.
  test("builds the evaluation of a refusal that stopped both probes", () => {
    expect(
      evaluateCheckFailure({
        failureMode: "guarded",
        detail: "10.1.2.3 is a private address",
      }),
    ).toEqual({
      reachable: false,
      failureMode: "guarded",
      detail: "10.1.2.3 is a private address",
      discovery: null,
      capability: null,
      driftFlags: [],
    });
  });
});

describe("unsupportedScopes", () => {
  // FR-019: the scopes the server does not support, named.
  test("names the requested scopes the server does not advertise", () => {
    expect(
      unsupportedScopes(
        ["launch", "patient/Patient.rs", "patient/Condition.rs"],
        ["launch", "patient/Patient.rs"],
      ),
    ).toEqual(["patient/Condition.rs"]);
  });

  test("names nothing when every requested scope is advertised", () => {
    expect(
      unsupportedScopes(["launch", "openid"], ["openid", "launch"]),
    ).toEqual([]);
  });

  // A server advertising `patient/*.rs` supports `patient/Patient.rs`, and a
  // warning that said otherwise would be noise participants learn to ignore.
  test("accepts a scope covered by an advertised wildcard", () => {
    expect(
      unsupportedScopes(
        ["patient/Patient.rs", "user/Patient.rs"],
        ["patient/*.rs"],
      ),
    ).toEqual(["user/Patient.rs"]);
  });

  // The interaction letters are a set: `.cruds` covers `.rs`, and `.rs` does not
  // cover `.cruds`.
  test("accepts a scope whose interactions are a subset of an advertised one", () => {
    expect(
      unsupportedScopes(
        ["patient/Observation.rs", "patient/Observation.cud"],
        ["patient/Observation.cruds"],
      ),
    ).toEqual([]);
    expect(
      unsupportedScopes(
        ["patient/Observation.cruds"],
        ["patient/Observation.rs"],
      ),
    ).toEqual(["patient/Observation.cruds"]);
  });

  // A SMART v1 scope is matched literally: `patient/*.read` is not a v2 scope,
  // and pretending to understand it would produce a confident wrong answer.
  test("matches a non-resource scope literally", () => {
    expect(
      unsupportedScopes(["offline_access", "fhirUser"], ["offline_access"]),
    ).toEqual(["fhirUser"]);
  });

  // Nothing advertised is nothing to check against; the caller decides whether
  // an unchecked server warrants a warning, and it does not.
  test("names nothing when the server advertises nothing", () => {
    expect(unsupportedScopes(["patient/Patient.rs"], [])).toEqual([]);
  });
});

describe("scopeWarning", () => {
  // Acceptance scenario 4: the warning names the unsupported scopes, and carries
  // the advertised set and the time it was read so both parties can act on it.
  test("warns with the unsupported scopes, the advertised set and the time", () => {
    expect(
      scopeWarning({
        requested: ["launch", "patient/Condition.rs"],
        advertised: ["launch", "patient/Patient.rs"],
        checkedAt: "2026-08-19T02:00:00.000Z",
      }),
    ).toEqual({
      unsupportedScopes: ["patient/Condition.rs"],
      advertisedScopes: ["launch", "patient/Patient.rs"],
      checkedAt: "2026-08-19T02:00:00.000Z",
    });
  });

  test("says nothing when every requested scope is supported", () => {
    expect(
      scopeWarning({
        requested: ["launch"],
        advertised: ["launch", "openid"],
        checkedAt: "2026-08-19T02:00:00.000Z",
      }),
    ).toBeUndefined();
  });

  // An unchecked server is not a server that refuses the scopes: with nothing
  // advertised there is nothing to warn about, and a guess would be worse.
  test("says nothing when the server has advertised no scopes", () => {
    expect(
      scopeWarning({
        requested: ["patient/Patient.rs"],
        advertised: [],
        checkedAt: "2026-08-19T02:00:00.000Z",
      }),
    ).toBeUndefined();
  });
});
