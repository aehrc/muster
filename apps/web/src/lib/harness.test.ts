import { describe, expect, test } from "bun:test";

import {
  conformanceSentence,
  evidenceJson,
  harnessPath,
  outcomeClass,
  outcomeWords,
  runOperationOf,
  runTally,
  showsVerifiedBadge,
  verifiedBadgeWords,
} from "./harness.ts";
import { operationMessage } from "./operation.ts";

import type {
  ConformanceStatus,
  HarnessCheck,
  HarnessCheckName,
  HarnessCheckOutcome,
  HarnessRun,
} from "@muster/contracts";

/**
 * How a conformance run reads on screen.
 *
 * The badge is a claim about somebody else's server, so what earns it is decided
 * here as a pure function over the verdict rather than inside a component: only a
 * passing latest run shows one, and a failing run shows none at all rather than a
 * red version of one (FR-030, acceptance scenario 3). An entry nothing has been
 * run against says so, because a blank reads as a pass.
 */

/** The moment every sentence in this suite is written at. */
const now = new Date("2026-08-19T06:00:00.000Z");

// A verdict, as the event view receives it.
const standing = (
  verdict: ConformanceStatus["verdict"],
): ConformanceStatus => ({
  runId: "run-1",
  verdict,
  ranAt: "2026-08-18T04:30:00.000Z",
});

// One check with the outcome given.
const check = (
  name: HarnessCheckName,
  outcome: HarnessCheckOutcome,
): HarnessCheck => ({
  name,
  title: `The ${name} check`,
  outcome,
  detail: `What the server did about ${name}.`,
  request: {
    method: "POST",
    url: "https://stub.example.org/register",
    body: { software_statement: "eyJ.eyJ.[removed]" },
  },
  response: { status: 201, body: { client_id: "stub-1" }, text: null },
});

// A run made of the outcomes given, in order.
const run = (outcomes: readonly HarnessCheckOutcome[]): HarnessRun => ({
  id: "run-1",
  enrolmentId: "enrolment-1",
  ranAt: "2026-08-18T04:30:00.000Z",
  verdict: outcomes.includes("failed") ? "failed" : "passed",
  checks: outcomes.map((outcome, index) =>
    check(
      (
        [
          "validStatement",
          "tamperedSignature",
          "expiredStatement",
          "replayedStatement",
          "metadataFidelity",
          "statementOnly",
        ] as const
      )[index] ?? "validStatement",
      outcome,
    ),
  ),
  cleanup: "Deleted stub-1.",
});

describe("the verified badge", () => {
  // FR-030: a fully passing run earns the badge, with the date it was earned.
  test("shows a dated badge for a passing run", () => {
    const passed = standing("passed");

    expect(showsVerifiedBadge(passed)).toBe(true);
    expect(verifiedBadgeWords(passed)).toContain("DCR verified");
    expect(verifiedBadgeWords(passed)).toContain("18 August 2026");
  });

  // Acceptance scenario 3: no badge is shown for a failing run. Not a failing
  // badge - none.
  test("shows no badge for a failing run", () => {
    expect(showsVerifiedBadge(standing("failed"))).toBe(false);
  });

  test("shows no badge for an entry nothing has been run against", () => {
    expect(showsVerifiedBadge(null)).toBe(false);
  });
});

describe("describing an entry's standing", () => {
  // An entry with no evidence says so rather than being left blank, because a
  // blank reads as a pass.
  test("says when nothing has been run", () => {
    expect(conformanceSentence(null, now)).toContain("has not");
  });

  test("says when a passing run was made", () => {
    const sentence = conformanceSentence(standing("passed"), now);

    expect(sentence).toContain("passed");
    expect(sentence).toContain("yesterday");
  });

  // The failing case says what the failure costs, which is the badge.
  test("says that a failing run carries no badge", () => {
    const sentence = conformanceSentence(standing("failed"), now);

    expect(sentence).toContain("failed");
    expect(sentence).toContain("badge");
  });
});

describe("reporting a run", () => {
  test("tallies what the checks said", () => {
    expect(runTally(run(["passed", "passed", "passed"]))).toBe(
      "3 checks, all passed",
    );
    expect(runTally(run(["passed", "advisory", "failed"]))).toBe(
      "3 checks: 1 passed, 1 advisory, 1 failed",
    );
    expect(runTally(run(["passed", "advisory"]))).toBe(
      "2 checks: 1 passed, 1 advisory",
    );
  });

  // FR-037: the operation the member started reports pending, failed with cause,
  // or succeeded. A run whose verdict is a failure is a failure, even though the
  // request that carried it succeeded.
  test("reports a passing run as a success", () => {
    const operation = runOperationOf(run(["passed", "passed"]));

    expect(operation.state).toBe("succeeded");
    expect(operationMessage(operation)).toContain("all passed");
  });

  test("reports a failing run as a failure naming the failing checks", () => {
    const operation = runOperationOf(run(["passed", "failed"]));

    expect(operation.state).toBe("failed");
    expect(operationMessage(operation)).toContain("tamperedSignature check");
  });

  test("has words and a colour for every outcome", () => {
    for (const outcome of ["passed", "failed", "advisory"] as const) {
      expect(outcomeWords[outcome].length).toBeGreaterThan(0);
      expect(outcomeClass[outcome]).toContain("badge-");
    }
  });
});

describe("showing the evidence", () => {
  // The evidence is what makes the report arguable, so it is shown as it was
  // recorded rather than summarised.
  test("renders a recorded body as indented JSON", () => {
    const rendered = evidenceJson({ client_id: "stub-1" });

    expect(rendered).toContain('"client_id": "stub-1"');
    expect(rendered.split("\n").length).toBeGreaterThan(1);
  });

  test("renders nothing recorded as an empty string", () => {
    expect(evidenceJson(null)).toBe("");
  });
});

describe("the harness screen's address", () => {
  test("is the enrolment's own", () => {
    expect(harnessPath("enrolment-1")).toBe("/enrolments/enrolment-1/harness");
  });
});
