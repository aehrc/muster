import {
  arrayLiteral,
  asJson,
  asOptionalText,
  jsonParameter,
  queryRows,
} from "./rows.ts";

import type { RawRow } from "./rows.ts";
import type { CheckFailureMode, EventStatus } from "@muster/contracts";
import type { SQL } from "bun";

/**
 * Check data access: recording a check, reading the latest one, and reading the
 * history behind it.
 *
 * Nothing here overwrites anything. A check is an observation, and the table is
 * the record of what was observed, so the badge on an entry is the newest row by
 * check time rather than a column somebody keeps up to date. That is also what
 * makes the scheduler restartable: it holds no state these rows do not.
 *
 * The last successful check travels with the latest one, because that is the
 * question a reader actually has about an entry that has gone quiet - not only
 * "is it down" but "when did it last work" (acceptance scenario 2).
 *
 * @author John Grimes
 */

/** A check as stored. */
export type CheckResultRow = {
  /** primary key */
  readonly id: string;
  /** the server enrolment checked */
  readonly enrolmentId: string;
  /** when the check ran */
  readonly checkedAt: Date;
  /** whether the server was reached */
  readonly reachable: boolean;
  /** why it was not, null when it was */
  readonly failureMode: CheckFailureMode | null;
  /** the reason a probe failed, null when none did */
  readonly detail: string | null;
  /** the discovery highlights as stored */
  readonly discovery: unknown;
  /** the capability highlights as stored */
  readonly capability: unknown;
  /** the disagreements as stored */
  readonly driftFlags: unknown;
};

/** A check to record. */
export type NewCheckResult = {
  /** the server enrolment checked */
  readonly enrolmentId: string;
  /** when the check ran */
  readonly checkedAt: Date;
  /** whether the server was reached */
  readonly reachable: boolean;
  /** why it was not, null when it was */
  readonly failureMode: CheckFailureMode | null;
  /** the reason a probe failed, null when none did */
  readonly detail: string | null;
  /** the discovery highlights, or null */
  readonly discovery: unknown;
  /** the capability highlights, or null */
  readonly capability: unknown;
  /** the disagreements */
  readonly driftFlags: unknown;
};

/** An enrolment's latest check, with when it was last reached. */
export type CheckStatusRow = {
  /** the most recent check */
  readonly latest: CheckResultRow;
  /** when the server was last reached, null when it never has been */
  readonly lastSuccessAt: Date | null;
};

/** Which history to read. */
export type CheckHistoryQuery = {
  /** the enrolment */
  readonly enrolmentId: string;
  /** how many checks to read, newest first */
  readonly limit: number;
};

/** A server enrolment the scheduler may check. */
export type CheckTargetRow = {
  /** the enrolment */
  readonly enrolmentId: string;
  /** the event it belongs to */
  readonly eventId: string;
  /** the event's slug, for the log */
  readonly eventSlug: string;
  /** the event's status, which sets the cadence */
  readonly eventStatus: EventStatus;
  /** the system enrolled */
  readonly systemId: string;
  /** what it is called, for the log */
  readonly systemName: string;
  /** its server profile as stored */
  readonly serverProfile: unknown;
  /** when it was last checked, null when it never has been */
  readonly lastCheckedAt: Date | null;
};

/**
 * Reads a nullable timestamp column.
 *
 * @param value - the column value
 * @returns the instant, or null when the column is null
 */
const asOptionalDate = (value: unknown): Date | null =>
  value instanceof Date ? value : null;

/**
 * Maps a check row.
 *
 * @param row - the row as the driver returned it
 * @returns the check
 */
const toCheckResult = (row: RawRow): CheckResultRow => ({
  id: String(row["id"]),
  enrolmentId: String(row["enrolment_id"]),
  checkedAt: row["checked_at"] as Date,
  reachable: row["reachable"] === true,
  failureMode:
    typeof row["failure_mode"] === "string"
      ? (row["failure_mode"] as CheckFailureMode)
      : null,
  detail: asOptionalText(row["detail"]),
  discovery: asJson(row["discovery"]),
  capability: asJson(row["capability"]),
  driftFlags: asJson(row["drift_flags"]),
});

/**
 * Maps a check row joined to when the server was last reached.
 *
 * @param row - the row as the driver returned it
 * @returns the status
 */
const toCheckStatus = (row: RawRow): CheckStatusRow => ({
  latest: toCheckResult(row),
  lastSuccessAt: asOptionalDate(row["last_success_at"]),
});

/**
 * Maps a scheduler target row.
 *
 * @param row - the row as the driver returned it
 * @returns the target
 */
const toCheckTarget = (row: RawRow): CheckTargetRow => ({
  enrolmentId: String(row["enrolment_id"]),
  eventId: String(row["event_id"]),
  eventSlug: String(row["event_slug"]),
  eventStatus: row["event_status"] as EventStatus,
  systemId: String(row["system_id"]),
  systemName: String(row["system_name"]),
  serverProfile: asJson(row["server_profile"]),
  lastCheckedAt: asOptionalDate(row["last_checked_at"]),
});

/**
 * The select and joins shared by the two check-status queries.
 *
 * `distinct on` picks the newest row per enrolment by check time, and the joined
 * aggregate carries the newest reachable one alongside it, so a badge and its
 * "last worked" are one query rather than two round trips.
 *
 * @param sql - a connection, which builds the fragment
 * @returns the fragment, to be finished with a where clause and an order
 */
const checkStatusQuery = (sql: SQL): unknown =>
  sql`select distinct on (check_result.enrolment_id) check_result.*,
             success.last_success_at
      from check_result
      join enrolment on enrolment.id = check_result.enrolment_id
      left join (select enrolment_id, max(checked_at) as last_success_at
                 from check_result where reachable group by enrolment_id) success
        on success.enrolment_id = check_result.enrolment_id`;

/**
 * Records one check.
 *
 * @param sql - a connection
 * @param result - the check to record
 * @returns the recorded check
 * @example
 * ```ts
 * await insertCheckResult(sql, {
 *   enrolmentId: target.enrolmentId,
 *   checkedAt: now,
 *   ...evaluateCheck({ declared, discovery, capability }),
 * });
 * ```
 */
export const insertCheckResult = async (
  sql: SQL,
  result: NewCheckResult,
): Promise<CheckResultRow> => {
  const rows = await queryRows(sql`insert into check_result
      (enrolment_id, checked_at, reachable, failure_mode, detail, discovery,
       capability, drift_flags)
    values (${result.enrolmentId}, ${result.checkedAt}, ${result.reachable},
            ${result.failureMode}::check_failure_mode, ${result.detail},
            ${jsonParameter(result.discovery)}::jsonb,
            ${jsonParameter(result.capability)}::jsonb,
            ${jsonParameter(result.driftFlags ?? [])}::jsonb)
    returning *`);
  return toCheckResult(rows[0] ?? {});
};

/**
 * Reads one enrolment's check status.
 *
 * @param sql - a connection
 * @param enrolmentId - the enrolment
 * @returns the status, or undefined when nothing has checked it
 * @example
 * ```ts
 * const status = await findCheckStatus(sql, row.enrolmentId);
 * ```
 */
export const findCheckStatus = async (
  sql: SQL,
  enrolmentId: string,
): Promise<CheckStatusRow | undefined> => {
  const rows = await queryRows(sql`${checkStatusQuery(sql)}
    where check_result.enrolment_id = ${enrolmentId}
    order by check_result.enrolment_id, check_result.checked_at desc`);
  return rows.length === 0 ? undefined : toCheckStatus(rows[0] ?? {});
};

/**
 * Reads the check status of every checked enrolment in an event.
 *
 * @param sql - a connection
 * @param eventId - the event
 * @returns one status per checked enrolment
 * @example
 * ```ts
 * const statuses = await listCheckStatuses(sql, event.id);
 * ```
 */
export const listCheckStatuses = async (
  sql: SQL,
  eventId: string,
): Promise<CheckStatusRow[]> => {
  const rows = await queryRows(sql`${checkStatusQuery(sql)}
    where enrolment.event_id = ${eventId}
    order by check_result.enrolment_id, check_result.checked_at desc`);
  return rows.map(toCheckStatus);
};

/**
 * Reads one enrolment's check history.
 *
 * @param sql - a connection
 * @param query - the enrolment and how many checks to read
 * @returns the checks, newest first
 * @example
 * ```ts
 * const history = await listCheckResults(sql, { enrolmentId, limit: 20 });
 * ```
 */
export const listCheckResults = async (
  sql: SQL,
  query: CheckHistoryQuery,
): Promise<CheckResultRow[]> => {
  const rows = await queryRows(sql`select * from check_result
    where enrolment_id = ${query.enrolmentId}
    order by checked_at desc
    limit ${query.limit}`);
  return rows.map(toCheckResult);
};

/**
 * Lists the server enrolments the scheduler may check.
 *
 * Server enrolments only: a client has no address of its own to verify. The
 * event's status travels with each target because it is what sets the cadence -
 * 15 minutes while an event is open, and daily otherwise (SC-004).
 *
 * @param sql - a connection
 * @param statuses - the event statuses to include
 * @returns the targets, with when each was last checked
 * @example
 * ```ts
 * const targets = await listCheckTargets(sql, ["open", "draft", "closed"]);
 * ```
 */
export const listCheckTargets = async (
  sql: SQL,
  statuses: readonly EventStatus[],
): Promise<CheckTargetRow[]> => {
  if (statuses.length === 0) {
    return [];
  }
  const rows = await queryRows(sql`select enrolment.id as enrolment_id,
           enrolment.event_id, event.slug as event_slug,
           event.status as event_status, system.id as system_id,
           system.name as system_name, system.server_profile,
           latest.last_checked_at
    from enrolment
    join system on system.id = enrolment.system_id
    join event on event.id = enrolment.event_id
    left join (select enrolment_id, max(checked_at) as last_checked_at
               from check_result group by enrolment_id) latest
      on latest.enrolment_id = enrolment.id
    where system.server_profile is not null
      and event.status = any(${arrayLiteral(statuses)}::event_status[])
    order by enrolment.id`);
  return rows.map(toCheckTarget);
};
