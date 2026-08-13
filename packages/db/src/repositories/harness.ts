/**
 * Reading and recording conformance runs.
 *
 * Two things worth stating.
 *
 * **Nothing is ever updated.** A run is what a server did when asked, at a time, so a second
 * run appends a row. That is also what makes FR-030's second half hold without a flag
 * anywhere: the badge is a question about the newest row, so a failing run removes it by
 * being newer rather than by editing anything.
 *
 * **The badge read is one `distinct on` for a whole event.** The event view asks "is this
 * entry verified?" once per enrolled server, and a query per row is the shape that is fine
 * for one server and embarrassing for an event with forty. The same arrangement as
 * `listCheckStatuses` beside it, for the same reason.
 *
 * Author: John Grimes
 */

import { desc, eq, inArray } from "drizzle-orm";

import { firstRow, requireRow } from "./rows.js";
import { harnessRun } from "../schema/harness.js";

import type { Executor } from "../executor.js";
import type { HarnessRunRow } from "../schema/harness.js";
import type { HarnessCheckView, HarnessVerdict } from "@muster/contracts";

/** What one run records. */
export interface NewHarnessRun {
  readonly enrolmentId: string;
  /** The member who ran it. */
  readonly runBy: string;
  readonly ranAt: Date;
  readonly verdict: HarnessVerdict;
  /** Per-check outcomes with evidence. Already scrubbed of credentials. */
  readonly checks: readonly HarnessCheckView[];
  readonly cleanup: string;
}

/**
 * Records a run.
 *
 * @param db - The executor.
 * @param input - The verdict, the per-check evidence, the cleanup report and the time.
 * @returns The stored row.
 * @throws {Error} When the enrolment or the account does not exist.
 * @example
 * ```ts
 * const run = await insertHarnessRun(db, {
 *   enrolmentId: target.enrolment.id,
 *   runBy: callerId(c),
 *   ranAt: context.clock(),
 *   verdict: harnessVerdict(checks),
 *   checks,
 *   cleanup,
 * });
 * ```
 */
export async function insertHarnessRun(
  db: Executor,
  input: NewHarnessRun,
): Promise<HarnessRunRow> {
  return requireRow(
    await db
      .insert(harnessRun)
      .values({
        enrolmentId: input.enrolmentId,
        runBy: input.runBy,
        ranAt: input.ranAt,
        verdict: input.verdict,
        checks: input.checks,
        cleanup: input.cleanup,
      })
      .returning(),
    "insert into harness_run",
  );
}

/**
 * One run by its identifier.
 *
 * @param db - The executor.
 * @param runId - The run.
 * @returns The run, or `undefined` when no run has that identifier.
 */
export async function findHarnessRun(
  db: Executor,
  runId: string,
): Promise<HarnessRunRow | undefined> {
  return firstRow(
    await db.select().from(harnessRun).where(eq(harnessRun.id, runId)).limit(1),
  );
}

/**
 * One enrolment's runs, newest first.
 *
 * Bounded, because the screen shows a list and a vendor iterating on their implementation
 * makes a great many runs.
 *
 * @param db - The executor.
 * @param enrolmentId - The enrolment.
 * @param limit - How many rows at most.
 * @returns The runs, newest first.
 */
export async function listHarnessRuns(
  db: Executor,
  enrolmentId: string,
  limit = 20,
): Promise<readonly HarnessRunRow[]> {
  return await db
    .select()
    .from(harnessRun)
    .where(eq(harnessRun.enrolmentId, enrolmentId))
    .orderBy(desc(harnessRun.ranAt), desc(harnessRun.createdAt))
    .limit(limit);
}

/**
 * The latest run per enrolment, for however many enrolments (FR-030).
 *
 * The latest and not the latest passing one: the badge is driven by the newest run, so an
 * entry whose last run failed has none even though an earlier one passed.
 *
 * @param db - The executor.
 * @param enrolmentIds - The enrolments to read.
 * @returns A map from enrolment identifier to its newest run, holding only the ones that have
 *   had a run at all.
 * @example
 * ```ts
 * const runs = await listLatestHarnessRuns(db, enrolments.map((row) => row.enrolment.id));
 * ```
 */
export async function listLatestHarnessRuns(
  db: Executor,
  enrolmentIds: readonly string[],
): Promise<ReadonlyMap<string, HarnessRunRow>> {
  if (enrolmentIds.length === 0) {
    // Asked rather than assumed: an `in ()` predicate is a syntax error in Postgres.
    return new Map();
  }
  const rows = await db
    .selectDistinctOn([harnessRun.enrolmentId])
    .from(harnessRun)
    .where(inArray(harnessRun.enrolmentId, [...enrolmentIds]))
    // `created_at` breaks a tie, so "the latest" is never arbitrary: two runs can share a
    // recorded time - a suite that pins the clock, or two runs within one second - and the
    // badge must not depend on which row Postgres happened to keep.
    .orderBy(
      harnessRun.enrolmentId,
      desc(harnessRun.ranAt),
      desc(harnessRun.createdAt),
    );
  return new Map(rows.map((row) => [row.enrolmentId, row]));
}

/**
 * The latest run on one enrolment.
 *
 * @param db - The executor.
 * @param enrolmentId - The enrolment.
 * @returns The newest run, or `undefined` when nothing has run.
 */
export async function findLatestHarnessRun(
  db: Executor,
  enrolmentId: string,
): Promise<HarnessRunRow | undefined> {
  const latest = await listLatestHarnessRuns(db, [enrolmentId]);
  return latest.get(enrolmentId);
}
