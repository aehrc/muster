/*
 * Copyright © 2026 Commonwealth Scientific and Industrial Research Organisation
 * (CSIRO) ABN 41 687 119 230. Licensed under the Apache License, Version 2.0.
 */

import { describe, expect, test } from "bun:test";

import {
  advertisedDetails,
  checkVerdict,
  checkVerdictClass,
  checkVerdictMeaning,
  checkVerdictWords,
  describeCheckedAt,
  driftSentence,
  scopeWarningSentence,
  ticketSupport,
  ticketSupportSentence,
} from "./checks.ts";

import type { CheckVerdict } from "./checks.ts";
import type { CheckResult, CheckStatus } from "@muster/contracts";

/**
 * How a check reads on screen.
 *
 * The event view exists to be trusted, and a check is what makes it trustworthy,
 * so the wording is a pure function and is tested rather than eyeballed. Two
 * things matter most. A verdict says which of five states an entry is in, and an
 * entry nothing has checked is its own state rather than being coloured as a pass
 * (FR-017). And a drift sentence names the declared value and the advertised one
 * (FR-018), because a reader who is only told "the token endpoint disagrees" has
 * to go and find both for themselves.
 */

// A check as the API answers it.
const check = (overrides: Partial<CheckResult> = {}): CheckResult => ({
  id: "check-1",
  checkedAt: "2026-08-19T02:00:00.000Z",
  reachable: true,
  failureMode: null,
  detail: null,
  discovery: {
    issuer: "https://auth.example.org",
    authorizationEndpoint: "https://auth.example.org/authorize",
    tokenEndpoint: "https://auth.example.org/token",
    registrationEndpoint: null,
    scopesSupported: ["launch", "patient/Patient.rs"],
    capabilities: ["launch-standalone"],
    permissionTicketTypesSupported: [],
  },
  capability: {
    fhirVersion: "4.0.1",
    software: "Example FHIR 3.2.1",
    implementationUrl: "https://fhir.example.org",
    securityServices: ["SMART-on-FHIR"],
    resourceTypes: ["Patient", "Observation"],
  },
  driftFlags: [],
  ...overrides,
});

// A status wrapping one check.
const status = (
  latest: CheckResult,
  lastSuccessAt: string | null = "2026-08-19T02:00:00.000Z",
): CheckStatus => ({ latest, lastSuccessAt });

/** The instant the wording is computed against. */
const now = new Date("2026-08-19T02:05:00.000Z");

describe("checkVerdict", () => {
  // An entry nothing has checked is not a pass and must not be coloured as one.
  test("calls an unchecked entry unchecked", () => {
    expect(checkVerdict(null)).toBe("unchecked");
  });

  test("calls a reachable entry with no drift reachable", () => {
    expect(checkVerdict(status(check()))).toBe("reachable");
  });

  // Drift is its own verdict: the entry answers, and it does not match itself.
  test("calls a reachable entry with drift drifted", () => {
    expect(
      checkVerdict(
        status(
          check({
            driftFlags: [
              {
                field: "tokenEndpoint",
                declared: "https://auth.example.org/token",
                advertised: "https://auth.example.org/v2/token",
              },
            ],
          }),
        ),
      ),
    ).toBe("drifted");
  });

  test("calls an unreachable entry unreachable", () => {
    expect(
      checkVerdict(
        status(
          check({
            reachable: false,
            failureMode: "timeout",
            detail: "fhir.example.org did not answer within 10000ms",
            discovery: null,
            capability: null,
          }),
          null,
        ),
      ),
    ).toBe("unreachable");
  });

  // A guarded target is Muster's refusal, not the server's failure, and a reader
  // who is going to fix the entry needs to be told which.
  test("calls a guarded target its own verdict", () => {
    expect(
      checkVerdict(
        status(
          check({
            reachable: false,
            failureMode: "guarded",
            detail: "10.1.2.3 is a private address",
            discovery: null,
            capability: null,
          }),
          null,
        ),
      ),
    ).toBe("guarded");
  });
});

describe("the verdict vocabulary", () => {
  // Every verdict has words, a colour and a meaning: a verdict added to the type
  // without wording would render as a blank badge.
  test.each<CheckVerdict>([
    "unchecked",
    "reachable",
    "drifted",
    "unreachable",
    "guarded",
  ])("describes the %s verdict", (verdict) => {
    expect(checkVerdictWords[verdict].length).toBeGreaterThan(0);
    expect(checkVerdictClass[verdict].length).toBeGreaterThan(0);
    expect(checkVerdictMeaning[verdict].length).toBeGreaterThan(0);
  });
});

describe("describeCheckedAt", () => {
  test("says an unchecked entry has never been checked", () => {
    expect(describeCheckedAt(null, now)).toBe("Never checked.");
  });

  test("says how long ago a reachable entry was checked", () => {
    expect(describeCheckedAt(status(check()), now)).toBe(
      "Checked 5 minutes ago.",
    );
  });

  // Acceptance scenario 2: an entry that has stopped answering says when it last
  // did, which is the question the reader actually has.
  test("says when a failing entry was last reached", () => {
    const failing = status(
      check({
        checkedAt: "2026-08-19T02:04:00.000Z",
        reachable: false,
        failureMode: "timeout",
        detail: "no answer",
        discovery: null,
        capability: null,
      }),
      "2026-08-19T01:00:00.000Z",
    );

    expect(describeCheckedAt(failing, now)).toBe(
      "Checked a minute ago, last reached an hour ago.",
    );
  });

  test("says a failing entry has never been reached", () => {
    const failing = status(
      check({
        reachable: false,
        failureMode: "guarded",
        detail: "10.1.2.3 is a private address",
        discovery: null,
        capability: null,
      }),
      null,
    );

    expect(describeCheckedAt(failing, now)).toBe(
      "Checked 5 minutes ago, never reached.",
    );
  });
});

describe("driftSentence", () => {
  // FR-018: both values, in words, with the field named as a person would name it
  // rather than as the schema spells it.
  test("names the field, the declared value and the advertised one", () => {
    expect(
      driftSentence({
        field: "tokenEndpoint",
        declared: "https://auth.example.org/token",
        advertised: "https://auth.example.org/v2/token",
      }),
    ).toBe(
      "Declares the token endpoint as https://auth.example.org/token, but advertises https://auth.example.org/v2/token.",
    );
  });

  test("says so when the server advertises nothing for the field", () => {
    expect(
      driftSentence({
        field: "registrationEndpoint",
        declared: "https://auth.example.org/register",
        advertised: null,
      }),
    ).toBe(
      "Declares the registration endpoint as https://auth.example.org/register, but advertises none.",
    );
  });

  // A field the wording does not know is still rendered with both values: a flag
  // nobody can read would be worse than an ugly one.
  test("falls back to the field name it was given", () => {
    expect(
      driftSentence({ field: "somethingNew", declared: "a", advertised: "b" }),
    ).toBe("Declares somethingNew as a, but advertises b.");
  });
});

describe("advertisedDetails", () => {
  // What a server actually advertises, which is the other half of a check: not
  // only that it answered, but what it said (acceptance scenario 1).
  test("describes the endpoints, scopes and capabilities read from a server", () => {
    const details = advertisedDetails(check());
    const labels = details.map((detail) => detail.label);

    expect(labels).toContain("Authorization endpoint");
    expect(labels).toContain("Token endpoint");
    expect(labels).toContain("Scopes supported");
    expect(labels).toContain("SMART capabilities");
    expect(labels).toContain("FHIR version");
    expect(labels).toContain("Software");
    expect(
      details.find((detail) => detail.label === "Token endpoint")?.value,
    ).toBe("https://auth.example.org/token");
  });

  // Nothing read is nothing shown: a row with a blank against it says less than
  // no row at all.
  test("describes nothing for a check that read no documents", () => {
    expect(
      advertisedDetails(
        check({ reachable: false, discovery: null, capability: null }),
      ),
    ).toEqual([]);
  });
});

describe("scopeWarningSentence", () => {
  // FR-019: the unsupported scopes are named, and so is when that was checked.
  test("names the unsupported scopes and when the server was checked", () => {
    expect(
      scopeWarningSentence(
        {
          unsupportedScopes: ["patient/Observation.rs"],
          advertisedScopes: ["launch", "patient/Patient.rs"],
          checkedAt: "2026-08-19T02:00:00.000Z",
        },
        "MediRecords FHIR",
        now,
      ),
    ).toBe(
      "MediRecords FHIR did not advertise patient/Observation.rs when it was checked 5 minutes ago.",
    );
  });

  test("names several unsupported scopes as a list", () => {
    expect(
      scopeWarningSentence(
        {
          unsupportedScopes: ["patient/Observation.rs", "user/Patient.rs"],
          advertisedScopes: ["launch"],
          checkedAt: "2026-08-19T02:00:00.000Z",
        },
        "MediRecords FHIR",
        now,
      ),
    ).toContain("patient/Observation.rs and user/Patient.rs");
  });
});

describe("permission ticket support", () => {
  // Acceptance scenario 3: whichever ticket types the server advertised are what
  // the entry surfaces, and they came from the check rather than from its owner.
  test("reads the ticket types the latest check observed", () => {
    expect(
      ticketSupport(
        status(
          check({
            discovery: {
              issuer: null,
              authorizationEndpoint: "https://auth.example.org/authorize",
              tokenEndpoint: "https://auth.example.org/token",
              registrationEndpoint: null,
              scopesSupported: [],
              capabilities: [],
              permissionTicketTypesSupported: ["patient-self-access"],
            },
          }),
        ),
      ),
    ).toEqual(["patient-self-access"]);
  });

  // An entry nothing has checked has not said it accepts tickets, and neither has
  // one whose discovery document could not be read.
  test("reports no support for an unchecked entry", () => {
    expect(ticketSupport(null)).toEqual([]);
  });

  test("reports no support when no document was read", () => {
    expect(ticketSupport(status(check({ discovery: null })))).toEqual([]);
  });

  // The sentence names the types, because "supports permission tickets" leaves a
  // member to guess which shape their client should mint.
  test("names the types it accepts", () => {
    expect(ticketSupportSentence(["patient-self-access"])).toBe(
      "Accepts permission tickets of type patient-self-access.",
    );
  });

  test("names several types as a list", () => {
    expect(
      ticketSupportSentence(["patient-self-access", "provider-access"]),
    ).toContain("patient-self-access and provider-access");
  });

  test("says nothing when nothing was advertised", () => {
    expect(ticketSupportSentence([])).toBe("");
  });
});
