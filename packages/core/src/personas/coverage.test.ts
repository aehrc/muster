/**
 * What makes a patient a persona, and what a server's answer about one proves.
 *
 * Two judgements live here and both are the whole of a requirement.
 *
 * **Eligibility is deny-by-default (FR-031, scenario 2).** A persona is the subject anchor
 * the ticket playground binds a ticket to, and it binds by IHI - so a persona without one
 * is a persona nothing can be minted for. A candidate that carries no IHI is refused *and
 * told why*, because an admin looking at a patient they can see on the source server needs
 * to know what is wrong with it rather than watching it vanish from the results.
 *
 * **Absence has to be earned (FR-032, scenario 4).** `missing` is a claim that a server
 * does not hold the patient, and the only answer that supports it is a searchset that came
 * back empty. A server that refused the search, timed out, answered 500, or answered with
 * something that is not a searchset has said nothing about the patient - so every one of
 * those is `unverifiable`. The case the requirement singles out is authorization: a 401 is
 * not evidence of absence, and a grid that recorded it as one would send a vendor looking
 * for data they had already loaded.
 *
 * Every case is a pure function over a body and a status, per constitution principle II -
 * the fetching, the clock and the persistence are the scheduler's, in `apps/server`.
 *
 * Author: John Grimes
 */

import { describe, expect, it } from "bun:test";

import {
  assessPersonaCandidate,
  evaluateCoverage,
  ihiSearchUrl,
  parsePatientSearch,
  patientResourceUrl,
  personaSearchUrl,
  sourceStatusFor,
} from "./coverage.js";

import type { CheckFetch } from "../checks/evaluate.js";
import type { Patient } from "fhir/r4";

/** The IHI namespace this deployment is configured with (AU Base's `au-ihi`). */
const IHI_SYSTEM = "http://ns.electronichealth.net.au/id/hi/ihi/1.0";

/** The quickstart's persona. */
const CHARLOTTE_IHI = "8003608500314687";

/** A test source server, public-looking so nothing here depends on the guard. */
const SOURCE = "https://smile.sparked-fhir.com/aucore/fhir/DEFAULT";

/**
 * A Patient carrying an IHI.
 *
 * @param overrides - What to change about it.
 * @returns The resource, as a source server would serve it.
 */
function patientWithIhi(overrides: Partial<Patient> = {}): Patient {
  return {
    resourceType: "Patient",
    id: "charlotte-morris",
    identifier: [
      {
        type: {
          coding: [
            {
              system: "http://terminology.hl7.org/CodeSystem/v2-0203",
              code: "NI",
            },
          ],
        },
        system: IHI_SYSTEM,
        value: CHARLOTTE_IHI,
      },
    ],
    name: [{ family: "Morris", given: ["Charlotte"] }],
    birthDate: "1985-03-12",
    ...overrides,
  };
}

/** A successful fetch of a body, as the guard reports one. */
function answered(body: unknown, status = 200): CheckFetch {
  return {
    ok: true,
    status,
    body: typeof body === "string" ? body : JSON.stringify(body),
  };
}

/**
 * A searchset holding these resources.
 *
 * @param resources - What the server matched.
 * @param total - The reported total, defaulting to the number of resources.
 * @returns The Bundle.
 */
function searchset(resources: readonly unknown[], total?: number): unknown {
  return {
    resourceType: "Bundle",
    type: "searchset",
    total: total ?? resources.length,
    entry: resources.map((resource) => ({ resource })),
  };
}

describe("assessPersonaCandidate", () => {
  it("accepts a patient carrying an IHI, recording demographics, IHI and its id (FR-031)", () => {
    // Scenario 1: the persona joins the set with demographics, IHI and canonical link -
    // and the identifier is what the canonical link is built from.
    const assessment = assessPersonaCandidate(patientWithIhi(), IHI_SYSTEM);

    expect(assessment.eligible).toBe(true);
    expect(assessment.eligible ? assessment.candidate : undefined).toEqual({
      patientId: "charlotte-morris",
      display: { name: "Charlotte Morris", birthDate: "1985-03-12" },
      ihi: CHARLOTTE_IHI,
    });
  });

  it("refuses a patient with no IHI and says so (FR-031, scenario 2)", () => {
    // A Medicare card number is an identifier, and it is not the one a ticket binds a
    // subject by. The refusal has to name what was missing.
    const assessment = assessPersonaCandidate(
      patientWithIhi({
        identifier: [
          {
            system: "http://ns.electronichealth.net.au/id/medicare-number",
            value: "32788511952",
          },
        ],
      }),
      IHI_SYSTEM,
    );

    expect(assessment.eligible).toBe(false);
    expect(assessment.eligible ? undefined : assessment.reason).toBe("no-ihi");
    // The system, because "no IHI" against a patient whose page shows an identifier is
    // not something an admin can act on without knowing which namespace was looked for.
    expect(assessment.eligible ? "" : assessment.detail).toContain(IHI_SYSTEM);
  });

  it("keeps the refused patient's demographics, so the console can name it", () => {
    // Scenario 2 is a sentence about a specific patient an admin is looking at. A refusal
    // that carried no name would leave them unable to tell which result it was about.
    const assessment = assessPersonaCandidate(
      patientWithIhi({ identifier: [] }),
      IHI_SYSTEM,
    );

    expect(assessment.eligible ? undefined : assessment.display).toEqual({
      name: "Charlotte Morris",
      birthDate: "1985-03-12",
    });
    expect(assessment.eligible ? undefined : assessment.patientId).toBe(
      "charlotte-morris",
    );
  });

  it("refuses a patient carrying no identifier element at all", () => {
    const assessment = assessPersonaCandidate(
      { resourceType: "Patient", id: "nobody" },
      IHI_SYSTEM,
    );

    expect(assessment.eligible ? undefined : assessment.reason).toBe("no-ihi");
  });

  it("refuses an IHI-shaped identifier whose value is empty", () => {
    // An identifier with the right system and no value names nobody. Accepting it would
    // put a persona in the set that no search could ever match.
    const assessment = assessPersonaCandidate(
      patientWithIhi({ identifier: [{ system: IHI_SYSTEM, value: "" }] }),
      IHI_SYSTEM,
    );

    expect(assessment.eligible ? undefined : assessment.reason).toBe("no-ihi");
  });

  it("ignores an identifier in a different namespace with an IHI-shaped value", () => {
    // The pair is the identifier. A sixteen-digit medical record number is not an IHI
    // because it looks like one.
    const assessment = assessPersonaCandidate(
      patientWithIhi({
        identifier: [
          { system: "http://example.org/mrn", value: CHARLOTTE_IHI },
        ],
      }),
      IHI_SYSTEM,
    );

    expect(assessment.eligible ? undefined : assessment.reason).toBe("no-ihi");
  });

  it("refuses a resource that is not a Patient", () => {
    // A searchset may carry an OperationOutcome beside its matches, and an admin should
    // not be offered one as a persona.
    const assessment = assessPersonaCandidate(
      { resourceType: "OperationOutcome", issue: [] },
      IHI_SYSTEM,
    );

    expect(assessment.eligible ? undefined : assessment.reason).toBe(
      "not-a-patient",
    );
  });

  it("refuses a Patient with no id, because there would be nothing to link to", () => {
    const assessment = assessPersonaCandidate(
      patientWithIhi({ id: undefined }),
      IHI_SYSTEM,
    );

    expect(assessment.eligible ? undefined : assessment.reason).toBe("no-id");
  });

  it("refuses a Patient whose id is not a FHIR id", () => {
    // The identifier is concatenated into an address on somebody else's server. A value
    // carrying a path segment would point a later read somewhere the source never named.
    const assessment = assessPersonaCandidate(
      patientWithIhi({ id: "../../metadata" }),
      IHI_SYSTEM,
    );

    expect(assessment.eligible ? undefined : assessment.reason).toBe("no-id");
  });

  it("falls back to the name's text when it has no parts", () => {
    const assessment = assessPersonaCandidate(
      patientWithIhi({ name: [{ text: "Charlotte Morris (test)" }] }),
      IHI_SYSTEM,
    );

    expect(assessment.eligible ? assessment.candidate.display.name : "").toBe(
      "Charlotte Morris (test)",
    );
  });

  it("names an unnamed patient rather than showing an empty card", () => {
    // A blank card in the search results is indistinguishable from a rendering failure.
    const assessment = assessPersonaCandidate(
      patientWithIhi({ name: undefined, birthDate: undefined }),
      IHI_SYSTEM,
    );

    expect(
      assessment.eligible ? assessment.candidate.display : undefined,
    ).toEqual({
      name: "Unnamed patient",
      birthDate: null,
    });
  });
});

describe("parsePatientSearch", () => {
  it("returns the resources a searchset matched", () => {
    const resources = parsePatientSearch(
      JSON.stringify(
        searchset([patientWithIhi(), patientWithIhi({ id: "two" })]),
      ),
    );

    expect(resources?.length).toBe(2);
  });

  it("returns an empty list for a searchset that matched nothing", () => {
    // Distinct from `undefined`: "the server answered, and found nobody" is the one answer
    // that supports a claim of absence.
    expect(parsePatientSearch(JSON.stringify(searchset([], 0)))).toEqual([]);
  });

  it("returns undefined for a body that is not a Bundle", () => {
    // An OperationOutcome at a search address has told us nothing, and an empty list would
    // read as "found nobody".
    expect(
      parsePatientSearch(
        JSON.stringify({ resourceType: "OperationOutcome", issue: [] }),
      ),
    ).toBeUndefined();
  });

  it("returns undefined for a body that is not JSON", () => {
    // A single-page application's catch-all answering with HTML is the usual way this
    // happens: a 200 that means nothing.
    expect(
      parsePatientSearch("<!doctype html><title>Not here</title>"),
    ).toBeUndefined();
  });
});

describe("personaSearchUrl and patientResourceUrl", () => {
  it("searches the source server's patients by name", () => {
    const url = new URL(personaSearchUrl(SOURCE, "Morris"));

    expect(url.pathname.endsWith("/Patient")).toBe(true);
    expect(url.searchParams.get("name")).toBe("Morris");
  });

  it("bounds the result set, so one search cannot return a whole test server", () => {
    expect(
      Number(new URL(personaSearchUrl(SOURCE, "a")).searchParams.get("_count")),
    ).toBeLessThanOrEqual(50);
  });

  it("does not double the separator on a base URL with a trailing slash", () => {
    expect(personaSearchUrl(`${SOURCE}/`, "Morris")).toBe(
      personaSearchUrl(SOURCE, "Morris"),
    );
  });

  it("escapes a query that would otherwise add a parameter", () => {
    // The query is typed by an admin, and a value carrying an ampersand must not become a
    // second search parameter on somebody else's server.
    const url = new URL(personaSearchUrl(SOURCE, "Morris&_count=9999"));

    expect(url.searchParams.get("name")).toBe("Morris&_count=9999");
    expect(Number(url.searchParams.get("_count"))).toBeLessThanOrEqual(50);
  });

  it("addresses one patient's canonical record", () => {
    expect(patientResourceUrl(SOURCE, "charlotte-morris")).toBe(
      `${SOURCE}/Patient/charlotte-morris`,
    );
  });

  it("escapes an identifier that would otherwise change the path", () => {
    // Belt and braces: `fhirIdSchema` refuses this at the edge, and the address builder
    // must not be the thing that makes it dangerous if it ever gets past.
    expect(patientResourceUrl(SOURCE, "../metadata")).not.toContain("/../");
  });
});

describe("ihiSearchUrl", () => {
  it("searches a server for a patient with the persona's IHI (FR-032)", () => {
    const url = new URL(
      ihiSearchUrl("https://fhir.example.org/r4", IHI_SYSTEM, CHARLOTTE_IHI),
    );

    expect(url.pathname.endsWith("/Patient")).toBe(true);
    // The token form: an identifier is a system and a value, and a search by value alone
    // would match a medical record number that happened to have the same digits.
    expect(url.searchParams.get("identifier")).toBe(
      `${IHI_SYSTEM}|${CHARLOTTE_IHI}`,
    );
  });

  it("does not double the separator on a base URL with a trailing slash", () => {
    expect(
      ihiSearchUrl("https://fhir.example.org/r4/", IHI_SYSTEM, CHARLOTTE_IHI),
    ).toBe(
      ihiSearchUrl("https://fhir.example.org/r4", IHI_SYSTEM, CHARLOTTE_IHI),
    );
  });
});

describe("evaluateCoverage", () => {
  /** Evaluates one answer about Charlotte. */
  function judge(fetched: CheckFetch) {
    return evaluateCoverage({
      fetched,
      ihi: CHARLOTTE_IHI,
      ihiSystem: IHI_SYSTEM,
    });
  }

  it("reports found when the server returned a patient with that IHI (scenario 3)", () => {
    const evaluation = judge(answered(searchset([patientWithIhi()])));

    expect(evaluation.outcome).toBe("found");
    // Nothing to explain: the grid's tick is the whole answer.
    expect(evaluation.detail).toBeNull();
  });

  it("reports found when the matching patient is not the first entry", () => {
    const evaluation = judge(
      answered(
        searchset([
          { resourceType: "OperationOutcome", issue: [] },
          patientWithIhi(),
        ]),
      ),
    );

    expect(evaluation.outcome).toBe("found");
  });

  it("reports missing for a searchset that matched nobody", () => {
    // The one answer that supports a claim of absence: the server was asked, it answered,
    // and it holds no patient with that IHI.
    const evaluation = judge(answered(searchset([], 0)));

    expect(evaluation.outcome).toBe("missing");
    expect(evaluation.detail).not.toBeNull();
  });

  it("marks a server that requires authorization unverifiable, not missing (FR-032, scenario 4)", () => {
    // The point of the requirement. An authorization failure is not evidence of absence,
    // and a grid that said "missing" here would send a vendor looking for data they have
    // already loaded.
    const evaluation = judge(
      answered({ resourceType: "OperationOutcome" }, 401),
    );

    expect(evaluation.outcome).toBe("unverifiable");
    expect(evaluation.detail).toContain("authorization");
  });

  it("marks a 403 unverifiable for the same reason", () => {
    const evaluation = judge(
      answered({ resourceType: "OperationOutcome" }, 403),
    );

    expect(evaluation.outcome).toBe("unverifiable");
    expect(evaluation.detail).toContain("authorization");
  });

  it("marks any other error status unverifiable, naming it", () => {
    for (const status of [404, 429, 500, 503]) {
      const evaluation = judge(
        answered({ resourceType: "OperationOutcome" }, status),
      );

      expect(evaluation.outcome).toBe("unverifiable");
      expect(evaluation.detail).toContain(String(status));
    }
  });

  it("marks a 200 that is not a searchset unverifiable", () => {
    // A server that answers a search with an OperationOutcome has not said the patient is
    // absent; it has said it did not do the search.
    const evaluation = judge(
      answered({ resourceType: "OperationOutcome", issue: [] }),
    );

    expect(evaluation.outcome).toBe("unverifiable");
  });

  it("marks a 200 whose body is not JSON unverifiable", () => {
    expect(judge(answered("<!doctype html>")).outcome).toBe("unverifiable");
  });

  it("marks a searchset whose patients do not carry the IHI unverifiable", () => {
    // A server that ignores an identifier search and returns its patients anyway has not
    // answered the question. Calling that `missing` would be a claim about a server that
    // may well hold the patient; calling it `found` would be worse.
    const evaluation = judge(
      answered(searchset([patientWithIhi({ identifier: [] })])),
    );

    expect(evaluation.outcome).toBe("unverifiable");
    expect(evaluation.detail).toContain("IHI");
  });

  it("marks a guarded address unverifiable and says no request was made", () => {
    // Principle III: the entry is what needs fixing, and no answer about the patient
    // exists at all.
    const evaluation = judge({
      ok: false,
      reason: "blocked-address",
      description:
        "fhir.internal resolves to 10.0.0.4, which is not publicly routable",
    });

    expect(evaluation.outcome).toBe("unverifiable");
    expect(evaluation.detail).toContain("10.0.0.4");
  });

  it("marks a timeout unverifiable, distinctly from a refused connection", () => {
    const timedOut = judge({
      ok: false,
      reason: "timeout",
      description: "https://slow.example.org/r4/Patient did not answer in time",
    });
    const refused = judge({
      ok: false,
      reason: "refused",
      description: "https://dead.example.org/r4/Patient could not be reached",
    });

    expect(timedOut.outcome).toBe("unverifiable");
    expect(refused.outcome).toBe("unverifiable");
    expect(timedOut.detail).not.toBe(refused.detail);
  });

  it("never reports missing for anything but an empty searchset (FR-032)", () => {
    // The whole of the requirement, asserted as an invariant rather than case by case: an
    // answer that is not a clean empty searchset cannot produce a claim of absence.
    const answers: readonly CheckFetch[] = [
      answered({ resourceType: "OperationOutcome" }, 401),
      answered({ resourceType: "OperationOutcome" }, 403),
      answered({ resourceType: "OperationOutcome" }, 500),
      answered("not json"),
      answered({ resourceType: "OperationOutcome", issue: [] }),
      answered(searchset([patientWithIhi({ identifier: [] })])),
      { ok: false, reason: "timeout", description: "no answer" },
      { ok: false, reason: "blocked-address", description: "private" },
      { ok: false, reason: "refused", description: "nothing there" },
    ];

    expect(answers.map((answer) => judge(answer).outcome)).toEqual(
      answers.map(() => "unverifiable"),
    );
  });
});

describe("sourceStatusFor", () => {
  it("flags a persona whose patient the source no longer holds (FR-032 edge case)", () => {
    // The spec's own edge case: the source server deletes or changes a curated patient, and
    // admins see it flagged on the event management view.
    expect(sourceStatusFor("missing")).toBe("missing");
  });

  it("records a persona the source still holds as present", () => {
    expect(sourceStatusFor("found")).toBe("present");
  });

  it("leaves the status alone when the source could not be read", () => {
    // Null, not `missing`. A source server that was down for a minute has not deleted
    // anybody, and flagging every persona because of it would teach admins to ignore the
    // flag that matters.
    expect(sourceStatusFor("unverifiable")).toBeNull();
  });
});
