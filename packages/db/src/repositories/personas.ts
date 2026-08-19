import {
  arrayLiteral,
  asJson,
  asOptionalText,
  jsonParameter,
  queryRows,
} from "./rows.ts";

import type { RawRow } from "./rows.ts";
import type {
  CoverageOutcome,
  EventStatus,
  PersonaSourceStatus,
} from "@muster/contracts";
import type { SQL } from "bun";

/**
 * Persona data access: curating a set, recording coverage, and reading the grid.
 *
 * Two rules from the schema show up in the shape of these functions.
 *
 * A persona is its IHI within an event, so adding one twice is a unique violation
 * rather than a second row - the route turns that into a conflict naming the
 * persona that already exists.
 *
 * Coverage is append-only. Nothing here updates or deletes a coverage row, so the
 * grid is the newest row per (persona, enrolment) rather than a column somebody
 * keeps current, which is what makes a regression visible and a restart harmless.
 *
 * The scheduler's two target queries are the interesting ones: they say what is
 * checkable and when it was last checked, and the cadence rule in `@muster/core`
 * decides the rest. Both are one query for the whole pass rather than one per
 * persona, because a pass over a hundred pairs should cost one round trip to find
 * its work.
 *
 * @author John Grimes
 */

/** A persona as stored. */
export type PersonaRow = {
  /** primary key */
  readonly id: string;
  /** the event whose set it belongs to */
  readonly eventId: string;
  /** the resource identifier on the source server */
  readonly patientId: string;
  /** the IHI, asserted under the configured identifier system */
  readonly ihi: string;
  /** the curated demographics as stored */
  readonly display: unknown;
  /** the canonical record on the source server */
  readonly sourceUrl: string;
  /** whether the source still holds the patient */
  readonly sourceStatus: PersonaSourceStatus;
  /** when the source was last read, null when it has not been */
  readonly sourceCheckedAt: Date | null;
  /** when it joined the set */
  readonly createdAt: Date;
};

/** A persona to add. */
export type NewPersona = {
  /** the event whose set it joins */
  readonly eventId: string;
  /** the resource identifier on the source server */
  readonly patientId: string;
  /** the IHI read from the source */
  readonly ihi: string;
  /** the demographics read from the source */
  readonly display: unknown;
  /** the canonical record, resolved when it was added */
  readonly sourceUrl: string;
};

/** The persona and the event it belongs to. */
export type PersonaKey = {
  /** the event */
  readonly eventId: string;
  /** the IHI */
  readonly ihi: string;
};

/** What a source check concluded about a persona. */
export type SourceStatusChange = {
  /** the persona */
  readonly personaId: string;
  /** the flag to store, or null to leave the stored flag alone */
  readonly sourceStatus: PersonaSourceStatus | null;
  /** when the source was read */
  readonly checkedAt: Date;
};

/** One coverage observation as stored. */
export type PersonaCoverageRow = {
  /** primary key */
  readonly id: string;
  /** the persona looked for */
  readonly personaId: string;
  /** the server enrolment it was looked for at */
  readonly enrolmentId: string;
  /** when the search ran */
  readonly checkedAt: Date;
  /** what it found */
  readonly outcome: CoverageOutcome;
  /** why, in words fit for the grid */
  readonly detail: string;
};

/** One coverage observation to record. */
export type NewPersonaCoverage = {
  /** the persona looked for */
  readonly personaId: string;
  /** the server enrolment it was looked for at */
  readonly enrolmentId: string;
  /** when the search ran */
  readonly checkedAt: Date;
  /** what it found */
  readonly outcome: CoverageOutcome;
  /** why */
  readonly detail: string;
};

/** One (persona, server enrolment) pair the scheduler may check. */
export type CoverageTargetRow = {
  /** the persona */
  readonly personaId: string;
  /** its IHI, which is what the server is searched by */
  readonly ihi: string;
  /** the server enrolment */
  readonly enrolmentId: string;
  /** the event both belong to */
  readonly eventId: string;
  /** the event's slug, for the log */
  readonly eventSlug: string;
  /** the event's status, which sets the cadence */
  readonly eventStatus: EventStatus;
  /** what the server is called, for the log */
  readonly systemName: string;
  /** its server profile as stored */
  readonly serverProfile: unknown;
  /** when the pair was last checked, null when it never has been */
  readonly lastCheckedAt: Date | null;
};

/** One persona the scheduler may verify against its source. */
export type SourceTargetRow = {
  /** the persona */
  readonly personaId: string;
  /** the resource identifier on the source */
  readonly patientId: string;
  /** its IHI as curated */
  readonly ihi: string;
  /** the flag currently stored */
  readonly sourceStatus: PersonaSourceStatus;
  /** the event's slug, for the log */
  readonly eventSlug: string;
  /** the event's status, which sets the cadence */
  readonly eventStatus: EventStatus;
  /** the event's configured persona source, null when it has none */
  readonly personaSourceUrl: string | null;
  /** when the source was last read, null when it never has been */
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
 * Maps a persona row.
 *
 * @param row - the row as the driver returned it
 * @returns the persona
 */
const toPersona = (row: RawRow): PersonaRow => ({
  id: String(row["id"]),
  eventId: String(row["event_id"]),
  patientId: String(row["patient_id"]),
  ihi: String(row["ihi"]),
  display: asJson(row["display"]),
  sourceUrl: String(row["source_url"]),
  sourceStatus: row["source_status"] as PersonaSourceStatus,
  sourceCheckedAt: asOptionalDate(row["source_checked_at"]),
  createdAt: row["created_at"] as Date,
});

/**
 * Maps a coverage row.
 *
 * @param row - the row as the driver returned it
 * @returns the observation
 */
const toCoverage = (row: RawRow): PersonaCoverageRow => ({
  id: String(row["id"]),
  personaId: String(row["persona_id"]),
  enrolmentId: String(row["enrolment_id"]),
  checkedAt: row["checked_at"] as Date,
  outcome: row["outcome"] as CoverageOutcome,
  detail: asOptionalText(row["detail"]) ?? "",
});

/**
 * Maps a coverage target row.
 *
 * @param row - the row as the driver returned it
 * @returns the target
 */
const toCoverageTarget = (row: RawRow): CoverageTargetRow => ({
  personaId: String(row["persona_id"]),
  ihi: String(row["ihi"]),
  enrolmentId: String(row["enrolment_id"]),
  eventId: String(row["event_id"]),
  eventSlug: String(row["event_slug"]),
  eventStatus: row["event_status"] as EventStatus,
  systemName: String(row["system_name"]),
  serverProfile: asJson(row["server_profile"]),
  lastCheckedAt: asOptionalDate(row["last_checked_at"]),
});

/**
 * Maps a source target row.
 *
 * @param row - the row as the driver returned it
 * @returns the target
 */
const toSourceTarget = (row: RawRow): SourceTargetRow => ({
  personaId: String(row["persona_id"]),
  patientId: String(row["patient_id"]),
  ihi: String(row["ihi"]),
  sourceStatus: row["source_status"] as PersonaSourceStatus,
  eventSlug: String(row["event_slug"]),
  eventStatus: row["event_status"] as EventStatus,
  personaSourceUrl: asOptionalText(row["persona_source_url"]),
  lastCheckedAt: asOptionalDate(row["source_checked_at"]),
});

/**
 * Adds a persona to an event's set.
 *
 * @param sql - a connection
 * @param persona - the persona as read from the source
 * @returns the stored persona
 * @throws {Error} the driver's unique violation when the event already has a
 *   persona with that IHI, which the route reports as a conflict
 * @example
 * ```ts
 * const row = await insertPersona(sql, {
 *   eventId: event.id,
 *   ...decision.candidate,
 *   sourceUrl: patientReadUrl(event.personaSourceUrl, candidate.patientId),
 * });
 * ```
 */
export const insertPersona = async (
  sql: SQL,
  persona: NewPersona,
): Promise<PersonaRow> => {
  const rows = await queryRows(sql`insert into persona
      (event_id, patient_id, ihi, display, source_url)
    values (${persona.eventId}, ${persona.patientId}, ${persona.ihi},
            ${jsonParameter(persona.display)}::jsonb, ${persona.sourceUrl})
    returning *`);
  return toPersona(rows[0] ?? {});
};

/**
 * Reads one persona by its identifier.
 *
 * @param sql - a connection
 * @param id - the persona
 * @returns the persona, or undefined when there is no such persona
 * @example
 * ```ts
 * const persona = await findPersonaById(sql, context.req.param("id"));
 * ```
 */
export const findPersonaById = async (
  sql: SQL,
  id: string,
): Promise<PersonaRow | undefined> => {
  const rows = await queryRows(sql`select * from persona where id = ${id}`);
  return rows.length === 0 ? undefined : toPersona(rows[0] ?? {});
};

/**
 * Reads one persona by the IHI it is identified by within its event.
 *
 * @param sql - a connection
 * @param key - the event and the IHI
 * @returns the persona, or undefined when the event's set has no such persona
 * @example
 * ```ts
 * const existing = await findPersonaByIhi(sql, { eventId: event.id, ihi });
 * ```
 */
export const findPersonaByIhi = async (
  sql: SQL,
  key: PersonaKey,
): Promise<PersonaRow | undefined> => {
  const rows = await queryRows(sql`select * from persona
    where event_id = ${key.eventId} and ihi = ${key.ihi}`);
  return rows.length === 0 ? undefined : toPersona(rows[0] ?? {});
};

/**
 * Reads an event's persona set.
 *
 * Ordered by when each joined, so the set reads as the admin built it.
 *
 * @param sql - a connection
 * @param eventId - the event
 * @returns the personas, oldest first
 * @example
 * ```ts
 * const personas = await listPersonas(sql, event.id);
 * ```
 */
export const listPersonas = async (
  sql: SQL,
  eventId: string,
): Promise<PersonaRow[]> => {
  const rows = await queryRows(sql`select * from persona
    where event_id = ${eventId}
    order by created_at, ihi`);
  return rows.map(toPersona);
};

/**
 * Records what a source check concluded.
 *
 * A change with no status records only the time: a source that could not be read
 * says nothing about the patient, and the stored flag stays where it was rather
 * than flipping to `missing` because a server was briefly down.
 *
 * @param sql - a connection
 * @param change - the persona, the flag to store and when the source was read
 * @returns the updated persona, or undefined when there is no such persona
 * @example
 * ```ts
 * await updatePersonaSourceStatus(sql, {
 *   personaId: target.personaId,
 *   sourceStatus: presence.status,
 *   checkedAt: at,
 * });
 * ```
 */
export const updatePersonaSourceStatus = async (
  sql: SQL,
  change: SourceStatusChange,
): Promise<PersonaRow | undefined> => {
  const rows = await queryRows(sql`update persona set
      source_status = coalesce(${change.sourceStatus}::persona_source_status,
                               source_status),
      source_checked_at = ${change.checkedAt},
      updated_at = now()
    where id = ${change.personaId}
    returning *`);
  return rows.length === 0 ? undefined : toPersona(rows[0] ?? {});
};

/**
 * Records one coverage observation.
 *
 * @param sql - a connection
 * @param coverage - the observation to record
 * @returns the recorded observation
 * @example
 * ```ts
 * await insertPersonaCoverage(sql, {
 *   personaId: target.personaId,
 *   enrolmentId: target.enrolmentId,
 *   checkedAt: at,
 *   ...evaluateCoverage(probe, { ihi: target.ihi, ihiSystem }),
 * });
 * ```
 */
export const insertPersonaCoverage = async (
  sql: SQL,
  coverage: NewPersonaCoverage,
): Promise<PersonaCoverageRow> => {
  const rows = await queryRows(sql`insert into persona_coverage
      (persona_id, enrolment_id, checked_at, outcome, detail)
    values (${coverage.personaId}, ${coverage.enrolmentId},
            ${coverage.checkedAt}, ${coverage.outcome}::coverage_outcome,
            ${coverage.detail})
    returning *`);
  return toCoverage(rows[0] ?? {});
};

/**
 * Reads the latest coverage of every checked pair in an event.
 *
 * One query for the whole grid: `distinct on` picks the newest row per pair, so a
 * page with ten personas and ten servers costs one round trip rather than a
 * hundred. Pairs nothing has checked are absent rather than guessed, and the page
 * renders them as not yet checked.
 *
 * @param sql - a connection
 * @param eventId - the event
 * @returns the newest observation per (persona, enrolment)
 * @example
 * ```ts
 * const coverage = await listLatestPersonaCoverage(sql, event.id);
 * ```
 */
export const listLatestPersonaCoverage = async (
  sql: SQL,
  eventId: string,
): Promise<PersonaCoverageRow[]> => {
  const rows = await queryRows(sql`select distinct on
             (persona_coverage.persona_id, persona_coverage.enrolment_id)
           persona_coverage.*
    from persona_coverage
    join persona on persona.id = persona_coverage.persona_id
    where persona.event_id = ${eventId}
    order by persona_coverage.persona_id, persona_coverage.enrolment_id,
             persona_coverage.checked_at desc`);
  return rows.map(toCoverage);
};

/**
 * Reads one pair's coverage history.
 *
 * @param sql - a connection
 * @param personaId - the persona
 * @param enrolmentId - the server enrolment
 * @returns the observations, newest first
 * @example
 * ```ts
 * const history = await listPersonaCoverage(sql, personaId, enrolmentId);
 * ```
 */
export const listPersonaCoverage = async (
  sql: SQL,
  personaId: string,
  enrolmentId: string,
): Promise<PersonaCoverageRow[]> => {
  const rows = await queryRows(sql`select * from persona_coverage
    where persona_id = ${personaId} and enrolment_id = ${enrolmentId}
    order by checked_at desc`);
  return rows.map(toCoverage);
};

/**
 * Lists the (persona, server enrolment) pairs the scheduler may check.
 *
 * Server enrolments only, in the persona's own event: a persona is an event's, and
 * coverage of it at a server enrolled in a different event would be a claim
 * nobody made. The event's status travels with each pair because it sets the
 * cadence (SC-004).
 *
 * @param sql - a connection
 * @param statuses - the event statuses to include
 * @returns the pairs, with when each was last checked
 * @example
 * ```ts
 * const targets = await listCoverageTargets(sql, ["open", "draft", "closed"]);
 * ```
 */
export const listCoverageTargets = async (
  sql: SQL,
  statuses: readonly EventStatus[],
): Promise<CoverageTargetRow[]> => {
  if (statuses.length === 0) {
    return [];
  }
  const rows = await queryRows(sql`select persona.id as persona_id, persona.ihi,
           enrolment.id as enrolment_id, event.id as event_id,
           event.slug as event_slug, event.status as event_status,
           system.name as system_name, system.server_profile,
           latest.last_checked_at
    from persona
    join event on event.id = persona.event_id
    join enrolment on enrolment.event_id = persona.event_id
    join system on system.id = enrolment.system_id
    left join (select persona_id, enrolment_id, max(checked_at) as last_checked_at
               from persona_coverage group by persona_id, enrolment_id) latest
      on latest.persona_id = persona.id and latest.enrolment_id = enrolment.id
    where system.server_profile is not null
      and event.status = any(${arrayLiteral(statuses)}::event_status[])
    order by persona.id, enrolment.id`);
  return rows.map(toCoverageTarget);
};

/**
 * Lists the personas the scheduler may verify against their source.
 *
 * A persona whose event has no configured source is included with a null source
 * URL, so the pass can report that rather than silently leaving the persona
 * unverified for ever.
 *
 * @param sql - a connection
 * @param statuses - the event statuses to include
 * @returns the personas, with when each was last read from its source
 * @example
 * ```ts
 * const targets = await listPersonaSourceTargets(sql, ["open"]);
 * ```
 */
export const listPersonaSourceTargets = async (
  sql: SQL,
  statuses: readonly EventStatus[],
): Promise<SourceTargetRow[]> => {
  if (statuses.length === 0) {
    return [];
  }
  const rows = await queryRows(sql`select persona.id as persona_id,
           persona.patient_id, persona.ihi, persona.source_status,
           persona.source_checked_at, event.slug as event_slug,
           event.status as event_status, event.persona_source_url
    from persona
    join event on event.id = persona.event_id
    where event.status = any(${arrayLiteral(statuses)}::event_status[])
    order by persona.id`);
  return rows.map(toSourceTarget);
};
