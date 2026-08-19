import { describeAge, formatDay } from "./format.ts";
import { failed as failedOperation, succeeded } from "./operation.ts";

import type { Operation } from "./operation.ts";
import type {
  ConformanceStatus,
  HarnessCheckOutcome,
  HarnessRun,
} from "@muster/contracts";

/**
 * How a conformance run reads on screen.
 *
 * The badge is a claim Muster makes about somebody else's server, so what earns
 * one is decided here as a pure function over the verdict rather than inside a
 * component: only a passing latest run shows a badge, and a failing run shows
 * none at all rather than a red version of one (FR-030, acceptance scenario 3).
 * An entry nothing has been run against says so, because a blank reads as a pass.
 *
 * A run whose verdict is a failure is reported as a failure even though the HTTP
 * request that carried it succeeded: the operation the member started was "prove
 * this server implements the profile", and that is the thing that has to report
 * pending, failed with cause, or succeeded (FR-037).
 *
 * @author John Grimes
 */

/** What the console calls each check outcome. */
export const outcomeWords: Record<HarnessCheckOutcome, string> = {
  passed: "Passed",
  failed: "Failed",
  advisory: "Advisory",
};

/** How the console colours each check outcome. */
export const outcomeClass: Record<HarnessCheckOutcome, string> = {
  passed: "badge-success",
  failed: "badge-error",
  advisory: "badge-warning",
};

/** What the operation of running the harness is called, for its messages. */
export const runningHarness = "Running the conformance harness";

/**
 * Whether an entry shows the "DCR verified" badge.
 *
 * Only a passing latest run does. A failing run removes the badge rather than
 * replacing it with a worse one, and an entry with no run has nothing to claim.
 *
 * @param conformance - the entry's standing, null when nothing has been run
 * @returns true when the badge is earned
 * @example
 * ```tsx
 * {showsVerifiedBadge(entry.conformance) ? <VerifiedBadge ... /> : null}
 * ```
 */
export const showsVerifiedBadge = (
  conformance: ConformanceStatus | null,
): boolean => conformance !== null && conformance.verdict === "passed";

/**
 * The badge's words, which carry the date the verdict was earned.
 *
 * A badge with no date is the participant table's problem all over again: a claim
 * nobody can tell the age of.
 *
 * @param conformance - the entry's standing
 * @returns the badge's text
 * @example
 * ```ts
 * verifiedBadgeWords(entry.conformance); // "DCR verified 18 August 2026"
 * ```
 */
export const verifiedBadgeWords = (conformance: ConformanceStatus): string =>
  `DCR verified ${formatDay(conformance.ranAt.slice(0, 10))}`;

/**
 * Says what an entry's conformance standing is.
 *
 * @param conformance - the entry's standing, null when nothing has been run
 * @param now - the current instant
 * @returns the sentence to show
 * @example
 * ```tsx
 * <p>{conformanceSentence(entry.conformance, new Date())}</p>
 * ```
 */
export const conformanceSentence = (
  conformance: ConformanceStatus | null,
  now: Date,
): string => {
  if (conformance === null) {
    return "The registration profile has not been run against this entry yet.";
  }
  const when = describeAge(conformance.ranAt, now);
  return conformance.verdict === "passed"
    ? `Every conformance check passed when the profile was run ${when}.`
    : `A conformance check failed when the profile was run ${when}, so this entry carries no verified badge.`;
};

/**
 * Tallies what a run's checks said.
 *
 * @param run - the run
 * @returns the tally, as a phrase
 * @example
 * ```ts
 * runTally(run); // "6 checks: 5 passed, 1 failed"
 * ```
 */
export const runTally = (run: HarnessRun): string => {
  const counted = (outcome: HarnessCheckOutcome): number =>
    run.checks.filter((check) => check.outcome === outcome).length;
  const total = `${String(run.checks.length)} check${run.checks.length === 1 ? "" : "s"}`;
  const parts = (["passed", "advisory", "failed"] as const)
    .filter((outcome) => counted(outcome) > 0)
    .map((outcome) => `${String(counted(outcome))} ${outcome}`);
  return counted("passed") === run.checks.length && run.checks.length > 0
    ? `${total}, all passed`
    : `${total}: ${parts.join(", ")}`;
};

/**
 * Turns a finished run into the operation state the screen reports.
 *
 * A failure names the checks that failed, because "the run failed" with the
 * reasons further down the page is what FR-037 exists to prevent.
 *
 * @param run - the run as the server reported it
 * @returns the operation to render
 * @example
 * ```ts
 * setOperation(runOperationOf(result.data.run));
 * ```
 */
export const runOperationOf = (run: HarnessRun): Operation => {
  if (run.verdict === "passed") {
    return succeeded(runningHarness, `${runTally(run)}.`);
  }
  const failures = run.checks
    .filter((check) => check.outcome === "failed")
    .map((check) => `${check.name} check`);
  return failedOperation(runningHarness, {
    status: 0,
    error: "conformance_failed",
    detail: `${runTally(run)}. The ${failures.join(", the ")} did not pass, so this entry carries no verified badge.`,
  });
};

/**
 * Renders a recorded body as a reader sees it.
 *
 * @param value - the recorded request or response body, null when there was none
 * @returns the indented JSON, or an empty string when nothing was recorded
 * @example
 * ```tsx
 * <pre>{evidenceJson(check.response.body)}</pre>
 * ```
 */
export const evidenceJson = (value: unknown): string =>
  value === null || value === undefined
    ? ""
    : JSON.stringify(value, undefined, 2);

/**
 * The address of an entry's harness screen.
 *
 * @param enrolmentId - the enrolment
 * @returns the path
 * @example
 * ```tsx
 * <Link to={harnessPath(entry.enrolmentId)}>Conformance</Link>
 * ```
 */
export const harnessPath = (enrolmentId: string): string =>
  `/enrolments/${enrolmentId}/harness`;
