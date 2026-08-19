import { asJson, asOptionalText, jsonParameter, queryRows } from "./rows.ts";

import type { RawRow } from "./rows.ts";
import type { HarnessVerdict } from "@muster/contracts";
import type { SQL } from "bun";

/**
 * Conformance run data access: recording a run, and reading the runs behind a
 * badge.
 *
 * Nothing here updates or deletes. A run is an observation of somebody's server
 * at a moment, so the badge on an entry is the newest row rather than a column
 * somebody keeps up to date - which is what makes a regression visible instead of
 * silent (FR-030), and what makes the history worth keeping.
 *
 * The report is stored as it is served, already redacted by
 * `packages/core/src/harness/checks.ts`: a statement without its signature, and
 * `[redacted]` where the server returned a credential. Nothing in this module has
 * to know that, which is the point - the redaction is not a thing a caller can
 * forget here, because by the time a run reaches here it has already happened.
 *
 * @author John Grimes
 */

/** A conformance run as stored. */
export type HarnessRunRow = {
  /** primary key */
  readonly id: string;
  /** the server enrolment the run was against */
  readonly enrolmentId: string;
  /** the account that ran it */
  readonly runBy: string;
  /** how it turned out */
  readonly verdict: HarnessVerdict;
  /** the per-check report, with its evidence, as stored */
  readonly checks: unknown;
  /** what became of the throwaway clients it registered */
  readonly cleanup: string;
  /** when it ran */
  readonly createdAt: Date;
};

/** A run to record. */
export type NewHarnessRun = {
  /** the server enrolment the run was against */
  readonly enrolmentId: string;
  /** the account that ran it */
  readonly runBy: string;
  /** how it turned out */
  readonly verdict: HarnessVerdict;
  /** the per-check report, already redacted */
  readonly checks: unknown;
  /** what became of the throwaway clients it registered */
  readonly cleanup: string;
};

/** Which runs to read. */
export type HarnessRunQuery = {
  /** the enrolment */
  readonly enrolmentId: string;
  /** how many runs to read, newest first */
  readonly limit: number;
};

/**
 * Maps a run row.
 *
 * @param row - the row as the driver returned it
 * @returns the run
 */
const toHarnessRun = (row: RawRow): HarnessRunRow => ({
  id: String(row["id"]),
  enrolmentId: String(row["enrolment_id"]),
  runBy: String(row["run_by"]),
  verdict: row["verdict"] as HarnessVerdict,
  checks: asJson(row["checks"]),
  cleanup: asOptionalText(row["cleanup"]) ?? "",
  createdAt: row["created_at"] as Date,
});

/**
 * Records one conformance run.
 *
 * @param sql - a connection
 * @param run - the run to record
 * @returns the recorded run
 * @example
 * ```ts
 * const run = await insertHarnessRun(sql, {
 *   enrolmentId,
 *   runBy: account.id,
 *   verdict: harnessVerdict(checks),
 *   checks,
 *   cleanup: describeCleanup(attempts),
 * });
 * ```
 */
export const insertHarnessRun = async (
  sql: SQL,
  run: NewHarnessRun,
): Promise<HarnessRunRow> => {
  const rows = await queryRows(sql`insert into harness_run
      (enrolment_id, run_by, verdict, checks, cleanup)
    values (${run.enrolmentId}, ${run.runBy}, ${run.verdict}::harness_verdict,
            ${jsonParameter(run.checks ?? [])}::jsonb, ${run.cleanup})
    returning *`);
  return toHarnessRun(rows[0] ?? {});
};

/**
 * Reads one run by its identifier.
 *
 * The report route is public, so this is what an anonymous caller reads: a
 * shareable report that needs a sign-in is not evidence (SC-005).
 *
 * @param sql - a connection
 * @param id - the run
 * @returns the run, or undefined when there is no such run
 * @example
 * ```ts
 * const run = await findHarnessRun(sql, context.req.param("id"));
 * ```
 */
export const findHarnessRun = async (
  sql: SQL,
  id: string,
): Promise<HarnessRunRow | undefined> => {
  const rows = await queryRows(sql`select * from harness_run where id = ${id}`);
  return rows.length === 0 ? undefined : toHarnessRun(rows[0] ?? {});
};

/**
 * Reads one enrolment's runs, newest first.
 *
 * @param sql - a connection
 * @param query - the enrolment and how many runs to read
 * @returns the runs, newest first
 * @example
 * ```ts
 * const runs = await listHarnessRuns(sql, { enrolmentId, limit: 20 });
 * ```
 */
export const listHarnessRuns = async (
  sql: SQL,
  query: HarnessRunQuery,
): Promise<HarnessRunRow[]> => {
  const rows = await queryRows(sql`select * from harness_run
    where enrolment_id = ${query.enrolmentId}
    order by created_at desc
    limit ${query.limit}`);
  return rows.map(toHarnessRun);
};

/**
 * Reads the latest run of every entry in an event.
 *
 * One query for the whole event view, because the badge is on every card and a
 * query per card would be a query per card.
 *
 * @param sql - a connection
 * @param eventId - the event
 * @returns the newest run per enrolment that has one
 * @example
 * ```ts
 * const runs = await listLatestHarnessRuns(sql, event.id);
 * ```
 */
export const listLatestHarnessRuns = async (
  sql: SQL,
  eventId: string,
): Promise<HarnessRunRow[]> => {
  const rows = await queryRows(sql`select distinct on (harness_run.enrolment_id)
           harness_run.*
    from harness_run
    join enrolment on enrolment.id = harness_run.enrolment_id
    where enrolment.event_id = ${eventId}
    order by harness_run.enrolment_id, harness_run.created_at desc`);
  return rows.map(toHarnessRun);
};

/**
 * Reads the latest run of one entry.
 *
 * @param sql - a connection
 * @param enrolmentId - the enrolment
 * @returns the newest run, or undefined when nothing has been run against it
 * @example
 * ```ts
 * const latest = await findLatestHarnessRun(sql, row.enrolmentId);
 * ```
 */
export const findLatestHarnessRun = async (
  sql: SQL,
  enrolmentId: string,
): Promise<HarnessRunRow | undefined> => {
  const runs = await listHarnessRuns(sql, { enrolmentId, limit: 1 });
  return runs[0];
};
