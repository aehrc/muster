/**
 * Every read and write the verification checks make.
 *
 * The same rules as the rest of this layer hold here - the executor comes first, the time is
 * passed in, nothing decides policy that `@muster/core` could decide purely - and two more
 * are specific to checks.
 *
 * **Nothing is ever updated.** A check is an observation at a time, so a pass appends a row.
 * That is what `data-model.md` means by "history retained": the latest row drives the badge,
 * and the row before it is still there to say when the server last worked.
 *
 * **A status is two rows, read together.** Scenario 2 asks for an unreachable server to be
 * shown with the time of the last successful check, and the latest row cannot carry that -
 * it is the row that failed. So {@link findCheckStatus} and {@link listCheckStatuses} return
 * both, and the callers never have to know that the second one came from a different row.
 *
 * The two `distinct on` queries are how the second part is answered for a whole event at
 * once: one row per enrolment, ordered so that the row Postgres keeps is the newest. The
 * alternative - a lookup per enrolment - is the shape that is fine for one server and
 * embarrassing for an event with forty.
 *
 * Author: John Grimes
 */

import { and, desc, eq, inArray, isNotNull, max } from "drizzle-orm";

import { requireRow } from "./rows.js";
import { checkResult } from "../schema/checks.js";
import { enrolment, event, system } from "../schema/directory.js";

import type { Executor } from "../executor.js";
import type { CheckResultRow } from "../schema/checks.js";
import type {
  CapabilityHighlights,
  DiscoveryHighlights,
  DriftFlag,
  ServerProfile,
} from "@muster/contracts";
import type { CheckFailureMode, EventStatus } from "@muster/core";

/** What one check records. */
export interface NewCheckResult {
  readonly enrolmentId: string;
  readonly checkedAt: Date;
  readonly reachable: boolean;
  /** Null exactly when the check succeeded; the schema holds that as a constraint. */
  readonly failureMode: CheckFailureMode | null;
  readonly detail: string | null;
  readonly discovery: DiscoveryHighlights | null;
  readonly capability: CapabilityHighlights | null;
  readonly driftFlags: readonly DriftFlag[];
}

/** The latest check on an enrolment, and when one last succeeded. */
export interface CheckStatusRow {
  readonly latest: CheckResultRow;
  /** Null when no check has ever succeeded. */
  readonly lastSuccessAt: Date | null;
}

/** One server the scheduler may check. */
export interface CheckTargetRow {
  readonly enrolmentId: string;
  readonly systemId: string;
  readonly systemName: string;
  readonly serverProfile: ServerProfile;
  readonly eventSlug: string;
  /** What the event's status is, which is what decides how often this target is checked. */
  readonly eventStatus: EventStatus;
  /** Null when nothing has checked this enrolment yet, which makes it due immediately. */
  readonly lastCheckedAt: Date | null;
}

/**
 * Records what one check found.
 *
 * @param db - The executor.
 * @param input - The observation, including the time it was made at.
 * @returns The stored row.
 * @throws {Error} When the row contradicts itself - reachable with a failure mode, or
 *   unreachable without one - which the check constraint refuses.
 * @example
 * ```ts
 * await insertCheckResult(db, {
 *   enrolmentId: target.enrolmentId,
 *   checkedAt: now,
 *   ...evaluateCheck({ declared, discovery, capability }),
 * });
 * ```
 */
export async function insertCheckResult(
  db: Executor,
  input: NewCheckResult,
): Promise<CheckResultRow> {
  return requireRow(
    await db
      .insert(checkResult)
      .values({
        enrolmentId: input.enrolmentId,
        checkedAt: input.checkedAt,
        reachable: input.reachable,
        failureMode: input.failureMode,
        detail: input.detail,
        discovery: input.discovery,
        capability: input.capability,
        driftFlags: input.driftFlags,
      })
      .returning(),
    "insert into check_result",
  );
}

/**
 * The latest check per enrolment, for however many enrolments.
 *
 * One `distinct on` rather than a query per enrolment. The order matters as much as the
 * predicate: Postgres keeps the first row of each group, so the descending time is what
 * makes "the latest" the latest.
 */
async function latestPerEnrolment(
  db: Executor,
  enrolmentIds: readonly string[],
): Promise<readonly CheckResultRow[]> {
  return await db
    .selectDistinctOn([checkResult.enrolmentId])
    .from(checkResult)
    .where(inArray(checkResult.enrolmentId, [...enrolmentIds]))
    .orderBy(checkResult.enrolmentId, desc(checkResult.checkedAt));
}

/** When a check last succeeded, per enrolment. */
async function lastSuccessPerEnrolment(
  db: Executor,
  enrolmentIds: readonly string[],
): Promise<ReadonlyMap<string, Date>> {
  const rows = await db
    .select({
      enrolmentId: checkResult.enrolmentId,
      at: max(checkResult.checkedAt),
    })
    .from(checkResult)
    .where(
      and(
        inArray(checkResult.enrolmentId, [...enrolmentIds]),
        eq(checkResult.reachable, true),
      ),
    )
    .groupBy(checkResult.enrolmentId);
  return new Map(
    rows.flatMap((row) => (row.at === null ? [] : [[row.enrolmentId, row.at]])),
  );
}

/**
 * The latest check on each of these enrolments, with the last time one succeeded.
 *
 * An enrolment nobody has checked is absent from the result rather than present with a
 * manufactured failure: a server nobody has looked at has not been found unreachable.
 *
 * @param db - The executor.
 * @param enrolmentIds - The enrolments to read.
 * @returns A map from enrolment identifier to its status, holding only the checked ones.
 * @example
 * ```ts
 * const statuses = await listCheckStatuses(db, enrolments.map((row) => row.enrolment.id));
 * ```
 */
export async function listCheckStatuses(
  db: Executor,
  enrolmentIds: readonly string[],
): Promise<ReadonlyMap<string, CheckStatusRow>> {
  if (enrolmentIds.length === 0) {
    // Asked rather than assumed: an `in ()` predicate is a syntax error in Postgres, and
    // Drizzle's rendering of an empty list is not something to depend on.
    return new Map();
  }
  const [latest, successes] = await Promise.all([
    latestPerEnrolment(db, enrolmentIds),
    lastSuccessPerEnrolment(db, enrolmentIds),
  ]);
  return new Map(
    latest.map((row) => [
      row.enrolmentId,
      { latest: row, lastSuccessAt: successes.get(row.enrolmentId) ?? null },
    ]),
  );
}

/**
 * The latest check on one enrolment, with the last time one succeeded.
 *
 * @param db - The executor.
 * @param enrolmentId - The enrolment to read.
 * @returns The status, or `undefined` when nothing has checked it.
 */
export async function findCheckStatus(
  db: Executor,
  enrolmentId: string,
): Promise<CheckStatusRow | undefined> {
  return (await listCheckStatuses(db, [enrolmentId])).get(enrolmentId);
}

/**
 * One enrolment's check history, newest first.
 *
 * Bounded, because the history of an event that ran for a week at a fifteen-minute cadence
 * is several hundred rows and the system page shows a list.
 *
 * @param db - The executor.
 * @param enrolmentId - The enrolment to read.
 * @param limit - How many rows at most.
 * @returns The checks, newest first.
 */
export async function listCheckHistory(
  db: Executor,
  enrolmentId: string,
  limit = 20,
): Promise<readonly CheckResultRow[]> {
  return await db
    .select()
    .from(checkResult)
    .where(eq(checkResult.enrolmentId, enrolmentId))
    .orderBy(desc(checkResult.checkedAt))
    .limit(limit);
}

/**
 * Every enrolled server, with the event it is in and when it was last checked.
 *
 * Server enrolments only (`data-model.md`): a client has no base URL to fetch, and a target
 * list that included one would write a permanent failure against an entry that is correct.
 * A system that is both a server and a client is a server, so it is here.
 *
 * The last check time comes from a left join rather than a second query, because it is what
 * decides whether the target is due and the scheduler asks about every target at once.
 *
 * @param db - The executor.
 * @returns The targets, ordered oldest-checked first so that a pass interrupted part way
 *   through resumes with the entries that have waited longest.
 * @example
 * ```ts
 * const targets = await listServerCheckTargets(db);
 * ```
 */
export async function listServerCheckTargets(
  db: Executor,
): Promise<readonly CheckTargetRow[]> {
  const lastChecked = db
    .select({
      enrolmentId: checkResult.enrolmentId,
      at: max(checkResult.checkedAt).as("last_checked_at"),
    })
    .from(checkResult)
    .groupBy(checkResult.enrolmentId)
    .as("last_checked");

  const rows = await db
    .select({
      enrolmentId: enrolment.id,
      systemId: system.id,
      systemName: system.name,
      serverProfile: system.serverProfile,
      eventSlug: event.slug,
      eventStatus: event.status,
      lastCheckedAt: lastChecked.at,
    })
    .from(enrolment)
    .innerJoin(system, eq(system.id, enrolment.systemId))
    .innerJoin(event, eq(event.id, enrolment.eventId))
    .leftJoin(lastChecked, eq(lastChecked.enrolmentId, enrolment.id))
    .where(isNotNull(system.serverProfile))
    .orderBy(lastChecked.at);

  return rows.flatMap((row) =>
    // Narrowing rather than asserting: `is not null` in the predicate does not reach the
    // column's type, and a system without a server profile has nothing to check.
    row.serverProfile === null
      ? []
      : [{ ...row, serverProfile: row.serverProfile }],
  );
}
