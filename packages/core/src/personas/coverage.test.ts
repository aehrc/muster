/*
 * Copyright © 2026 Commonwealth Scientific and Industrial Research Organisation
 * (CSIRO) ABN 41 687 119 230. Licensed under the Apache License, Version 2.0.
 */

import { describe, expect, test } from "bun:test";

import {
  authorisePersonaCuration,
  evaluateCoverage,
  evaluateSourcePresence,
  ihiOf,
  patientReadUrl,
  personaCandidates,
  personaFrom,
  personaIdentifierSearchUrl,
  personaSearchUrl,
} from "./coverage.ts";

import type { PersonaProbe } from "./coverage.ts";
import type { AccountFacts } from "../accounts/rules.ts";

/**
 * Persona eligibility and coverage evaluation, with no network anywhere near it.
 *
 * Four rules are pinned down here, and each of them is a promise the persona page
 * makes to somebody.
 *
 * An IHI is required (FR-031). It is the only identifier that matches across two
 * participants who seeded the same patient independently, so a candidate without
 * one is refused and told why rather than added on the strength of a name.
 *
 * A coverage cell says what was observed and nothing more (FR-032). A searchset
 * carrying a patient with the IHI is `found`, an empty searchset is `missing`, and
 * everything else - a server that demands authorization, an address the guard
 * refused, a body that is not a Bundle - is `unverifiable`. Turning any of those
 * into `missing` would accuse a server owner of not holding data they may well
 * hold, on the strength of a request Muster could not make.
 *
 * A persona the source has deleted, or whose IHI has changed under it, is flagged
 * `missing` at source. A source that could not be read is not: an unreachable
 * source is Muster's problem for the minute, not evidence about the patient, and
 * the stored flag is left where it was.
 *
 * Curation is a track admin's job (FR-004) and a closed event's set is closed.
 */

/** The identifier system the programme's IHIs are asserted under. */
const ihiSystem = "http://ns.electronichealth.net.au/id/hi/ihi/1.0";

/** An approved, verified track admin. */
const admin: AccountFacts = {
  status: "approved",
  emailVerifiedAt: new Date("2026-08-01T00:00:00.000Z"),
  isAdmin: true,
};

/** An approved, verified ordinary member. */
const member: AccountFacts = { ...admin, isAdmin: false };

/** A patient on the source carrying an IHI, as AU Core renders one. */
const withIhi = {
  resourceType: "Patient",
  id: "baratz-toni",
  identifier: [
    {
      type: { text: "IHI", coding: [{ code: "NI" }] },
      system: ihiSystem,
      value: "8003608000311662",
    },
    {
      system: "http://ns.electronichealth.net.au/id/medicare-number",
      value: "69518252411",
    },
  ],
  name: [
    { use: "official", family: "BARATZ", given: ["Toni"], prefix: ["Ms"] },
  ],
  gender: "female",
  birthDate: "1978-06-16",
};

/** A patient on the source carrying no IHI at all. */
const withoutIhi = {
  resourceType: "Patient",
  id: "italia-sofia",
  identifier: [
    { system: "http://hl7.org/fhir/sid/passport-ITA", value: "IT1111111" },
  ],
  name: [{ family: "Italia", given: ["Sofia"], prefix: ["Ms"] }],
  gender: "female",
  birthDate: "1989-05-07",
};

/**
 * Wraps resources as a FHIR searchset.
 *
 * @param resources - the resources the search matched
 * @returns the bundle, as a conformant server serves one
 */
const searchset = (resources: readonly unknown[]): unknown => ({
  resourceType: "Bundle",
  type: "searchset",
  total: resources.length,
  entry: resources.map((resource) => ({ resource })),
});

/**
 * A probe that answered.
 *
 * @param document - the body the server answered with
 * @param status - the status it answered with, 200 by default
 * @returns the probe outcome
 */
const answered = (document: unknown, status = 200): PersonaProbe => ({
  ok: true,
  status,
  document,
});

// Eligibility ---------------------------------------------------------------

describe("persona eligibility", () => {
  // FR-031: the IHI is read from the configured system, not from a name or a
  // type coding, so a deployment that changes the system changes what is read.
  test("reads the IHI asserted under the configured system", () => {
    expect(ihiOf(withIhi, ihiSystem)).toBe("8003608000311662");
  });

  test("reads no IHI from a patient whose identifiers are all something else", () => {
    expect(ihiOf(withoutIhi, ihiSystem)).toBeUndefined();
  });

  test("reads no IHI under a different configured system", () => {
    expect(ihiOf(withIhi, "http://example.org/id/other")).toBeUndefined();
  });

  // Acceptance scenario 1: the persona records demographics and the IHI.
  test("accepts a patient carrying an IHI, with its demographics", () => {
    const decision = personaFrom(withIhi, { ihiSystem });
    expect(decision.ok).toBe(true);
    if (!decision.ok) {
      return;
    }
    expect(decision.candidate).toEqual({
      patientId: "baratz-toni",
      ihi: "8003608000311662",
      display: {
        name: "Ms Toni BARATZ",
        birthDate: "1978-06-16",
        gender: "female",
      },
    });
  });

  // Acceptance scenario 2: the reason is stated, not merely a rejection.
  test("refuses a patient with no IHI, naming the system it looked in", () => {
    const decision = personaFrom(withoutIhi, { ihiSystem });
    expect(decision.ok).toBe(false);
    if (decision.ok) {
      return;
    }
    expect(decision.refusal.reason).toBe("no_ihi");
    expect(decision.refusal.detail).toContain(ihiSystem);
  });

  // Deny by default: a document that is not a Patient is not read as one.
  test("refuses a document that is not a Patient", () => {
    const decision = personaFrom(
      { resourceType: "OperationOutcome" },
      { ihiSystem },
    );
    expect(decision.ok).toBe(false);
    if (decision.ok) {
      return;
    }
    expect(decision.refusal.reason).toBe("not_a_patient");
  });

  test("refuses a Patient the source gave no identifier", () => {
    const decision = personaFrom(
      { resourceType: "Patient", id: "bare" },
      { ihiSystem },
    );
    expect(decision.ok).toBe(false);
    if (decision.ok) {
      return;
    }
    expect(decision.refusal.reason).toBe("no_ihi");
  });

  test("refuses a Patient with no identifier of its own", () => {
    const decision = personaFrom({ resourceType: "Patient" }, { ihiSystem });
    expect(decision.ok).toBe(false);
  });

  // A name is rendered from whatever the source gave: `text` when it has one,
  // the parts otherwise, and the resource identifier when it has neither, so a
  // picker never shows a blank row.
  test("renders a name from the text when the source gives one", () => {
    const decision = personaFrom(
      {
        ...withIhi,
        name: [{ text: "Toni Baratz (test)", family: "BARATZ" }],
      },
      { ihiSystem },
    );
    expect(decision.ok && decision.candidate.display.name).toBe(
      "Toni Baratz (test)",
    );
  });

  test("falls back to the patient identifier when the source gives no name", () => {
    const decision = personaFrom({ ...withIhi, name: [] }, { ihiSystem });
    expect(decision.ok && decision.candidate.display.name).toBe(
      "Patient/baratz-toni",
    );
  });

  test("records absent demographics as absent rather than as blanks", () => {
    const decision = personaFrom(
      { resourceType: "Patient", id: "x", identifier: withIhi.identifier },
      { ihiSystem },
    );
    expect(decision.ok && decision.candidate.display.birthDate).toBeNull();
    expect(decision.ok && decision.candidate.display.gender).toBeNull();
  });
});

// The proxied search --------------------------------------------------------

describe("the persona search", () => {
  // The contract: IHI-bearing patients only, and the rest reported with why.
  test("offers the patients carrying an IHI and reports the others", () => {
    const found = personaCandidates(searchset([withIhi, withoutIhi]), {
      ihiSystem,
    });
    expect(found.candidates.map((candidate) => candidate.patientId)).toEqual([
      "baratz-toni",
    ]);
    expect(found.ineligible).toEqual([
      {
        patientId: "italia-sofia",
        detail: expect.stringContaining(ihiSystem),
      },
    ]);
  });

  test("ignores bundle entries that are not patients", () => {
    const found = personaCandidates(
      searchset([{ resourceType: "OperationOutcome" }, withIhi]),
      { ihiSystem },
    );
    expect(found.candidates).toHaveLength(1);
    expect(found.ineligible).toHaveLength(0);
  });

  test("finds nothing in a document that is not a bundle", () => {
    expect(personaCandidates(withIhi, { ihiSystem }).candidates).toEqual([]);
    expect(personaCandidates(null, { ihiSystem }).candidates).toEqual([]);
  });

  test("finds nothing in a bundle with no entries", () => {
    expect(personaCandidates(searchset([]), { ihiSystem }).candidates).toEqual(
      [],
    );
  });

  // The search URL is built here rather than in a route, so the identifier
  // system is the configured one everywhere it is used.
  test("searches by IHI when the query is one", () => {
    expect(
      personaSearchUrl("https://source.example.org/fhir/", {
        query: " 8003608000311662 ",
        ihiSystem,
        limit: 20,
      }),
    ).toBe(
      "https://source.example.org/fhir/Patient?identifier=http%3A%2F%2Fns.electronichealth.net.au%2Fid%2Fhi%2Fihi%2F1.0%7C8003608000311662&_count=20",
    );
  });

  test("searches by name when the query is not an IHI", () => {
    expect(
      personaSearchUrl("https://source.example.org/fhir", {
        query: "baratz",
        ihiSystem,
        limit: 5,
      }),
    ).toBe("https://source.example.org/fhir/Patient?name=baratz&_count=5");
  });

  test("lists the source's patients when the query is empty", () => {
    expect(
      personaSearchUrl("https://source.example.org/fhir", {
        query: "  ",
        ihiSystem,
        limit: 5,
      }),
    ).toBe("https://source.example.org/fhir/Patient?_count=5");
  });

  test("builds the identifier search each enrolled server is asked", () => {
    expect(
      personaIdentifierSearchUrl("https://holder.example.org/fhir/", {
        ihi: "8003608000311662",
        ihiSystem,
      }),
    ).toBe(
      "https://holder.example.org/fhir/Patient?identifier=http%3A%2F%2Fns.electronichealth.net.au%2Fid%2Fhi%2Fihi%2F1.0%7C8003608000311662&_summary=count",
    );
  });

  test("builds the read of one patient on the source", () => {
    expect(
      patientReadUrl("https://source.example.org/fhir/", "baratz-toni"),
    ).toBe("https://source.example.org/fhir/Patient/baratz-toni");
  });
});

// Coverage ------------------------------------------------------------------

describe("coverage evaluation", () => {
  /** The persona every coverage test asks about. */
  const facts = { ihi: "8003608000311662", ihiSystem };

  // Acceptance scenario 3: a patient with the IHI is found.
  test("finds a persona a server answers with", () => {
    const evaluation = evaluateCoverage(answered(searchset([withIhi])), facts);
    expect(evaluation.outcome).toBe("found");
    expect(evaluation.detail).toContain("8003608000311662");
  });

  // A `_summary=count` answer carries a total and no entries, which is what the
  // coverage search asks for: the question is whether one exists, not what it
  // says.
  test("finds a persona from a count-only searchset", () => {
    const evaluation = evaluateCoverage(
      answered({ resourceType: "Bundle", type: "searchset", total: 1 }),
      facts,
    );
    expect(evaluation.outcome).toBe("found");
  });

  test("reports a persona missing when the searchset is empty", () => {
    const evaluation = evaluateCoverage(
      answered({ resourceType: "Bundle", type: "searchset", total: 0 }),
      facts,
    );
    expect(evaluation.outcome).toBe("missing");
  });

  test("reports a persona missing when the bundle has neither total nor entries", () => {
    expect(
      evaluateCoverage(
        answered({ resourceType: "Bundle", type: "searchset" }),
        facts,
      ).outcome,
    ).toBe("missing");
  });

  // A server that answers with somebody else's patient has not answered the
  // question that was asked, so the entry it returned is checked rather than
  // counted.
  test("reports a persona missing when the entries carry a different IHI", () => {
    const other = {
      ...withIhi,
      identifier: [{ system: ihiSystem, value: "8003608000311663" }],
    };
    expect(evaluateCoverage(answered(searchset([other])), facts).outcome).toBe(
      "missing",
    );
  });

  // Acceptance scenario 4: authorization required is unverifiable, not missing.
  test.each([401, 403])(
    "reports coverage unverifiable when the server answers %i",
    (status) => {
      const evaluation = evaluateCoverage(answered({}, status), facts);
      expect(evaluation.outcome).toBe("unverifiable");
      expect(evaluation.detail).toContain("authorization");
    },
  );

  test("reports coverage unverifiable when the server fails", () => {
    const evaluation = evaluateCoverage(
      answered({ resourceType: "OperationOutcome" }, 500),
      facts,
    );
    expect(evaluation.outcome).toBe("unverifiable");
    expect(evaluation.detail).toContain("500");
  });

  test("reports coverage unverifiable when the answer is not a bundle", () => {
    const evaluation = evaluateCoverage(answered(withIhi), facts);
    expect(evaluation.outcome).toBe("unverifiable");
    expect(evaluation.detail).toContain("Bundle");
  });

  // FR-020: the guard's refusal is Muster's own, and it is reported as the
  // reason rather than folded into a verdict about the server.
  test.each(["guarded", "timeout", "refused", "invalid"] as const)(
    "reports coverage unverifiable when the probe failed as %s",
    (failureMode) => {
      const evaluation = evaluateCoverage(
        {
          ok: false,
          failureMode,
          detail: "The address is in a private range.",
        },
        facts,
      );
      expect(evaluation.outcome).toBe("unverifiable");
      expect(evaluation.detail).toBe("The address is in a private range.");
    },
  );
});

// The source flag -----------------------------------------------------------

describe("source presence", () => {
  /** The persona every source test asks about. */
  const facts = {
    ihi: "8003608000311662",
    ihiSystem,
    patientId: "baratz-toni",
  };

  test("reports a persona present when the source still holds it", () => {
    const evaluation = evaluateSourcePresence(answered(withIhi), facts);
    expect(evaluation.status).toBe("present");
  });

  // The edge case: the source deleted the patient.
  test("flags a persona missing when the source no longer holds it", () => {
    const evaluation = evaluateSourcePresence(
      answered({ resourceType: "OperationOutcome" }, 404),
      facts,
    );
    expect(evaluation.status).toBe("missing");
    expect(evaluation.detail).toContain("baratz-toni");
  });

  test("flags a persona missing when the source answers 410 Gone", () => {
    expect(evaluateSourcePresence(answered(null, 410), facts).status).toBe(
      "missing",
    );
  });

  // The edge case's other half: the source changed the patient's IHI, so the
  // persona no longer names anybody the grid can search for.
  test("flags a persona missing when the source changed its IHI", () => {
    const evaluation = evaluateSourcePresence(
      answered({
        ...withIhi,
        identifier: [{ system: ihiSystem, value: "8003608000311663" }],
      }),
      facts,
    );
    expect(evaluation.status).toBe("missing");
    expect(evaluation.detail).toContain("8003608000311662");
  });

  test("flags a persona missing when the source dropped its IHI", () => {
    expect(
      evaluateSourcePresence(answered({ ...withIhi, identifier: [] }), facts)
        .status,
    ).toBe("missing");
  });

  // A source Muster could not read says nothing about the patient, so nothing
  // is claimed and the stored flag is left where it was.
  test("claims nothing when the source could not be read", () => {
    const evaluation = evaluateSourcePresence(
      { ok: false, failureMode: "timeout", detail: "It did not answer." },
      facts,
    );
    expect(evaluation.status).toBeNull();
    expect(evaluation.detail).toBe("It did not answer.");
  });

  test("claims nothing when the source demands authorization", () => {
    expect(evaluateSourcePresence(answered({}, 401), facts).status).toBeNull();
  });

  test("claims nothing when the source answers with something else", () => {
    expect(
      evaluateSourcePresence(answered({ resourceType: "Bundle" }), facts)
        .status,
    ).toBeNull();
  });
});

// Curation rights -----------------------------------------------------------

describe("persona curation rights", () => {
  test("lets a track admin curate a draft event's set", () => {
    expect(
      authorisePersonaCuration({ member: admin, eventStatus: "draft" }).ok,
    ).toBe(true);
  });

  test("lets a track admin curate an open event's set", () => {
    expect(
      authorisePersonaCuration({ member: admin, eventStatus: "open" }).ok,
    ).toBe(true);
  });

  // FR-004: curation is an admin power, distinct from ordinary membership.
  test("refuses an ordinary member", () => {
    const decision = authorisePersonaCuration({
      member,
      eventStatus: "open",
    });
    expect(decision.ok).toBe(false);
    if (decision.ok) {
      return;
    }
    expect(decision.refusal.reason).toBe("not_admin");
  });

  test("refuses an admin whose account is revoked", () => {
    const decision = authorisePersonaCuration({
      member: { ...admin, status: "revoked" },
      eventStatus: "open",
    });
    expect(decision.ok).toBe(false);
    if (decision.ok) {
      return;
    }
    expect(decision.refusal.reason).toBe("revoked");
  });

  // A closed event's records stay readable and stop changing.
  test("refuses curation of a closed event", () => {
    const decision = authorisePersonaCuration({
      member: admin,
      eventStatus: "closed",
    });
    expect(decision.ok).toBe(false);
    if (decision.ok) {
      return;
    }
    expect(decision.refusal.reason).toBe("event_not_open");
  });
});
