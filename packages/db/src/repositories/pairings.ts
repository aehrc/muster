import {
  arrayLiteral,
  asJson,
  asOptionalText,
  jsonParameter,
  queryRows,
} from "./rows.ts";

import type { RawRow } from "./rows.ts";
import type { EventStatus, PairingState } from "@muster/contracts";
import type { SQL } from "bun";

/**
 * Pairing data access: the pairings of an event, and their timelines.
 *
 * Both organisations read one record, so there is one query that assembles it -
 * the pairing, the event, and each side's enrolment, system and organisation -
 * used by the detail and by the list alike. A pairing the two parties could read
 * differently would defeat the point of tracking it here at all (SC-002).
 *
 * A pairing references enrolments rather than systems, so every join goes through
 * the enrolment: that is what makes "a pairing exists within one event" a fact
 * about the rows rather than a rule someone has to remember.
 *
 * @author John Grimes
 */

/** A pairing as stored. */
export type PairingRow = {
  /** primary key */
  readonly id: string;
  /** the event the pairing belongs to */
  readonly eventId: string;
  /** the client side */
  readonly clientEnrolmentId: string;
  /** the server side */
  readonly serverEnrolmentId: string;
  /** the lifecycle state */
  readonly state: PairingState;
  /** the registration field set as submitted */
  readonly registrationFields: unknown;
  /** the identifier the server issued, null until fulfilled */
  readonly clientId: string | null;
  /** why the server declined, null unless it did */
  readonly declineReason: string | null;
  /** when it was requested */
  readonly createdAt: Date;
  /** when it last changed */
  readonly updatedAt: Date;
};

/** A pairing to create. */
export type NewPairing = {
  /** the event it belongs to */
  readonly eventId: string;
  /** the client side */
  readonly clientEnrolmentId: string;
  /** the server side */
  readonly serverEnrolmentId: string;
  /** the registration field set as submitted */
  readonly registrationFields: unknown;
};

/** The event, client and server one pairing joins. */
export type PairingKey = {
  /** the event */
  readonly eventId: string;
  /** the client enrolment */
  readonly clientEnrolmentId: string;
  /** the server enrolment */
  readonly serverEnrolmentId: string;
};

/** One side of a pairing, as stored. */
export type PairingPartyRow = {
  /** the enrolment */
  readonly enrolmentId: string;
  /** the system enrolled */
  readonly systemId: string;
  /** what the system is called */
  readonly systemName: string;
  /** the organisation that owns it */
  readonly organisationId: string;
  /** what that organisation is called */
  readonly organisationName: string;
};

/** A pairing with everything either party needs to read it. */
export type PairingRecordRow = {
  /** the pairing itself */
  readonly pairing: PairingRow;
  /** the event's slug */
  readonly eventSlug: string;
  /** the event's status */
  readonly eventStatus: EventStatus;
  /** the client side */
  readonly client: PairingPartyRow;
  /** the server side */
  readonly server: PairingPartyRow;
  /** the server system's profile, as stored */
  readonly serverProfile: unknown;
  /** the client system's profile, as stored */
  readonly clientProfile: unknown;
};

/** A change to a pairing's state. */
export type PairingStateChange = {
  /** the pairing */
  readonly id: string;
  /** the state it moves to */
  readonly state: PairingState;
  /** the identifier the server issued */
  readonly clientId?: string;
  /** why the server declined */
  readonly declineReason?: string;
  /** a replacement registration field set */
  readonly registrationFields?: unknown;
};

/** Which pairings of an event to list. */
export type PairingStateQuery = {
  /** the event */
  readonly eventId: string;
  /** the states to include */
  readonly states: readonly PairingState[];
};

/** Whose pairings to list. */
export type PairingListQuery = {
  /** the event */
  readonly eventId: string;
  /** the organisations the caller belongs to */
  readonly organisationIds: readonly string[];
};

/** A timeline entry to append. */
export type NewPairingEvent = {
  /** the pairing */
  readonly pairingId: string;
  /** who acted, null for Muster's own transition */
  readonly actorAccountId: string | null;
  /** the organisation they acted for, null for Muster's own transition */
  readonly actingForOrganisationId: string | null;
  /** the state moved from, null when the pairing was created */
  readonly fromState: PairingState | null;
  /** the state moved to */
  readonly toState: PairingState;
  /** what the transition recorded */
  readonly detail: unknown;
};

/** A timeline entry as stored, with the names a reader needs. */
export type PairingEventRow = {
  /** primary key */
  readonly id: string;
  /** the pairing */
  readonly pairingId: string;
  /** who acted, null for Muster's own transition */
  readonly actorAccountId: string | null;
  /** their name, null for Muster's own transition */
  readonly actorDisplayName: string | null;
  /** the organisation they acted for */
  readonly actingForOrganisationId: string | null;
  /** what that organisation is called */
  readonly actingForOrganisationName: string | null;
  /** the state moved from */
  readonly fromState: PairingState | null;
  /** the state moved to */
  readonly toState: PairingState;
  /** what the transition recorded */
  readonly detail: unknown;
  /** when it happened */
  readonly at: Date;
};

/**
 * Reads a nullable pairing state column.
 *
 * @param value - the column value
 * @returns the state, or null when the column is null
 */
const asState = (value: unknown): PairingState | null =>
  typeof value === "string" ? (value as PairingState) : null;

/**
 * Maps a pairing row.
 *
 * @param row - the row as the driver returned it
 * @returns the pairing
 */
const toPairing = (row: RawRow): PairingRow => ({
  id: String(row["id"]),
  eventId: String(row["event_id"]),
  clientEnrolmentId: String(row["client_enrolment_id"]),
  serverEnrolmentId: String(row["server_enrolment_id"]),
  state: row["state"] as PairingState,
  registrationFields: asJson(row["registration_fields"]),
  clientId: asOptionalText(row["client_id"]),
  declineReason: asOptionalText(row["decline_reason"]),
  createdAt: row["created_at"] as Date,
  updatedAt: row["updated_at"] as Date,
});

/**
 * Maps one side of a joined pairing row.
 *
 * @param row - the row as the driver returned it
 * @param side - which side's columns to read
 * @returns the side
 */
const toParty = (row: RawRow, side: "client" | "server"): PairingPartyRow => ({
  enrolmentId: String(row[`${side}_enrolment_id`]),
  systemId: String(row[`${side}_system_id`]),
  systemName: String(row[`${side}_system_name`]),
  organisationId: String(row[`${side}_organisation_id`]),
  organisationName: String(row[`${side}_organisation_name`]),
});

/**
 * Maps a joined pairing row.
 *
 * @param row - the row as the driver returned it
 * @returns the record both parties read
 */
const toRecord = (row: RawRow): PairingRecordRow => ({
  pairing: toPairing(row),
  eventSlug: String(row["event_slug"]),
  eventStatus: row["event_status"] as EventStatus,
  client: toParty(row, "client"),
  server: toParty(row, "server"),
  serverProfile: asJson(row["server_profile"]),
  clientProfile: asJson(row["client_profile"]),
});

/**
 * Maps a timeline row.
 *
 * @param row - the row as the driver returned it
 * @returns the entry
 */
const toPairingEvent = (row: RawRow): PairingEventRow => ({
  id: String(row["id"]),
  pairingId: String(row["pairing_id"]),
  actorAccountId: asOptionalText(row["actor_account_id"]),
  actorDisplayName: asOptionalText(row["actor_display_name"]),
  actingForOrganisationId: asOptionalText(row["acting_for_organisation_id"]),
  actingForOrganisationName: asOptionalText(
    row["acting_for_organisation_name"],
  ),
  fromState: asState(row["from_state"]),
  toState: row["to_state"] as PairingState,
  detail: asJson(row["detail"]),
  at: row["at"] as Date,
});

/**
 * The select and joins shared by the pairing detail and the pairing list.
 *
 * Both sides are reached through their enrolments, so a pairing carries the
 * systems and organisations that are actually enrolled in its event rather than
 * whatever the systems say about themselves now.
 *
 * @param sql - a connection, which builds the fragment
 * @returns the fragment, to be finished with a where clause
 */
const pairingRecordQuery = (sql: SQL): unknown =>
  sql`select pairing.id, pairing.event_id, pairing.state,
             pairing.registration_fields, pairing.client_id,
             pairing.decline_reason, pairing.created_at, pairing.updated_at,
             event.slug as event_slug, event.status as event_status,
             pairing.client_enrolment_id, client_system.id as client_system_id,
             client_system.name as client_system_name,
             client_system.client_profile as client_profile,
             client_organisation.id as client_organisation_id,
             client_organisation.name as client_organisation_name,
             pairing.server_enrolment_id, server_system.id as server_system_id,
             server_system.name as server_system_name,
             server_system.server_profile as server_profile,
             server_organisation.id as server_organisation_id,
             server_organisation.name as server_organisation_name
      from pairing
      join event on event.id = pairing.event_id
      join enrolment client_enrolment
        on client_enrolment.id = pairing.client_enrolment_id
      join system client_system on client_system.id = client_enrolment.system_id
      join organisation client_organisation
        on client_organisation.id = client_system.organisation_id
      join enrolment server_enrolment
        on server_enrolment.id = pairing.server_enrolment_id
      join system server_system on server_system.id = server_enrolment.system_id
      join organisation server_organisation
        on server_organisation.id = server_system.organisation_id`;

/**
 * The select and joins shared by the two timeline queries.
 *
 * The joins are outer joins because a lapse has no actor and no organisation: the
 * event closing is Muster's own doing.
 *
 * @param sql - a connection, which builds the fragment
 * @returns the fragment, to be finished with a where clause
 */
const pairingEventQuery = (sql: SQL): unknown =>
  sql`select pairing_event.id, pairing_event.pairing_id,
             pairing_event.actor_account_id,
             pairing_event.acting_for_organisation_id,
             pairing_event.from_state, pairing_event.to_state,
             pairing_event.detail, pairing_event.at,
             account.display_name as actor_display_name,
             organisation.name as acting_for_organisation_name
      from pairing_event
      left join account on account.id = pairing_event.actor_account_id
      left join organisation
        on organisation.id = pairing_event.acting_for_organisation_id`;

/**
 * Creates a pairing.
 *
 * @param sql - a connection
 * @param pairing - the event, the two sides, and the field set as submitted
 * @returns the created pairing, in state `requested`
 * @throws {Error} when a pairing already exists for that event, client and
 *   server; classify with `isUniqueViolation`
 * @example
 * ```ts
 * const pairing = await insertPairing(sql, {
 *   eventId: event.id,
 *   clientEnrolmentId,
 *   serverEnrolmentId,
 *   registrationFields,
 * });
 * ```
 */
export const insertPairing = async (
  sql: SQL,
  pairing: NewPairing,
): Promise<PairingRow> => {
  const rows = await queryRows(sql`insert into pairing
      (event_id, client_enrolment_id, server_enrolment_id, registration_fields)
    values (${pairing.eventId}, ${pairing.clientEnrolmentId},
            ${pairing.serverEnrolmentId},
            ${jsonParameter(pairing.registrationFields)}::jsonb)
    returning *`);
  return toPairing(rows[0] ?? {});
};

/**
 * Finds the pairing for one event, client and server.
 *
 * This is what makes a duplicate request answerable with the pairing that already
 * exists rather than with a bare refusal (FR-015).
 *
 * @param sql - a connection
 * @param key - the event, the client enrolment and the server enrolment
 * @returns the pairing, or undefined when there is none
 * @example
 * ```ts
 * const existing = await findPairingByKey(sql, key);
 * ```
 */
export const findPairingByKey = async (
  sql: SQL,
  key: PairingKey,
): Promise<PairingRow | undefined> => {
  const rows = await queryRows(sql`select * from pairing
    where event_id = ${key.eventId}
      and client_enrolment_id = ${key.clientEnrolmentId}
      and server_enrolment_id = ${key.serverEnrolmentId}`);
  return rows.length === 0 ? undefined : toPairing(rows[0] ?? {});
};

/**
 * Reads a pairing with both sides.
 *
 * @param sql - a connection
 * @param id - the pairing
 * @returns the record, or undefined when there is no such pairing
 * @example
 * ```ts
 * const record = await findPairingRecord(sql, context.req.param("id"));
 * ```
 */
export const findPairingRecord = async (
  sql: SQL,
  id: string,
): Promise<PairingRecordRow | undefined> => {
  const rows = await queryRows(
    sql`${pairingRecordQuery(sql)} where pairing.id = ${id}`,
  );
  return rows.length === 0 ? undefined : toRecord(rows[0] ?? {});
};

/**
 * Lists an event's pairings involving any of the given organisations.
 *
 * Both directions: a pairing is listed to the client's organisation and to the
 * server's alike, and once to a member of both (FR-013).
 *
 * @param sql - a connection
 * @param query - the event and the organisations the caller belongs to
 * @returns the records, newest first
 * @example
 * ```ts
 * const records = await listPairingRecordsForOrganisations(sql, {
 *   eventId: event.id,
 *   organisationIds: memberships.map((membership) => membership.organisationId),
 * });
 * ```
 */
export const listPairingRecordsForOrganisations = async (
  sql: SQL,
  query: PairingListQuery,
): Promise<PairingRecordRow[]> => {
  if (query.organisationIds.length === 0) {
    return [];
  }
  const organisations = arrayLiteral(query.organisationIds);
  const rows = await queryRows(sql`${pairingRecordQuery(sql)}
    where pairing.event_id = ${query.eventId}
      and (client_organisation.id = any(${organisations}::uuid[])
           or server_organisation.id = any(${organisations}::uuid[]))
    order by pairing.created_at desc`);
  return rows.map(toRecord);
};

/**
 * Lists an event's pairings in given states.
 *
 * What closing an event needs in order to lapse the pairings that are still open
 * (FR-011), and nothing that has already settled.
 *
 * @param sql - a connection
 * @param query - the event and the states to include
 * @returns the pairings, oldest first
 * @example
 * ```ts
 * const open = await listPairingsInState(sql, {
 *   eventId: event.id,
 *   states: openPairingStates,
 * });
 * ```
 */
export const listPairingsInState = async (
  sql: SQL,
  query: PairingStateQuery,
): Promise<PairingRow[]> => {
  if (query.states.length === 0) {
    return [];
  }
  const rows = await queryRows(sql`select * from pairing
    where event_id = ${query.eventId}
      and state = any(${arrayLiteral(query.states)}::pairing_state[])
    order by created_at`);
  return rows.map(toPairing);
};

/**
 * Moves a pairing to a new state.
 *
 * A value the transition does not carry leaves the stored one alone, so declining
 * a pairing does not erase an identifier and a retry does not erase the reason a
 * previous attempt failed.
 *
 * @param sql - a connection
 * @param change - the pairing, the state it moves to, and what the transition
 *   records
 * @returns the updated pairing, or undefined when there is no such pairing
 * @example
 * ```ts
 * const updated = await updatePairingState(sql, {
 *   id: pairing.id,
 *   state: "fulfilled",
 *   clientId: body.clientId,
 * });
 * ```
 */
export const updatePairingState = async (
  sql: SQL,
  change: PairingStateChange,
): Promise<PairingRow | undefined> => {
  const rows = await queryRows(sql`update pairing set
      state = ${change.state}::pairing_state,
      client_id = coalesce(${change.clientId ?? null}, client_id),
      decline_reason = coalesce(${change.declineReason ?? null}, decline_reason),
      registration_fields = coalesce(
        ${jsonParameter(change.registrationFields)}::jsonb, registration_fields),
      updated_at = now()
    where id = ${change.id}
    returning *`);
  return rows.length === 0 ? undefined : toPairing(rows[0] ?? {});
};

/**
 * Appends a timeline entry.
 *
 * The table takes inserts and nothing else, so this is the only way a transition
 * is ever recorded (FR-013).
 *
 * @param sql - a connection
 * @param entry - the transition to record
 * @returns the appended entry, with the actor's and organisation's names
 * @example
 * ```ts
 * await insertPairingEvent(sql, {
 *   pairingId: pairing.id,
 *   actorAccountId: account.id,
 *   actingForOrganisationId: organisationId,
 *   fromState: "requested",
 *   toState: "fulfilled",
 *   detail: { clientId },
 * });
 * ```
 */
export const insertPairingEvent = async (
  sql: SQL,
  entry: NewPairingEvent,
): Promise<PairingEventRow> => {
  const rows = await queryRows(sql`with appended as (
      insert into pairing_event (pairing_id, actor_account_id,
        acting_for_organisation_id, from_state, to_state, detail)
      values (${entry.pairingId}, ${entry.actorAccountId},
              ${entry.actingForOrganisationId},
              ${entry.fromState}::pairing_state,
              ${entry.toState}::pairing_state,
              ${jsonParameter(entry.detail)}::jsonb)
      returning *
    )
    select appended.*, account.display_name as actor_display_name,
           organisation.name as acting_for_organisation_name
    from appended
    left join account on account.id = appended.actor_account_id
    left join organisation
      on organisation.id = appended.acting_for_organisation_id`);
  return toPairingEvent(rows[0] ?? {});
};

/**
 * Reads a pairing's timeline.
 *
 * Oldest first, and the same for both parties: one history, in the order things
 * happened (acceptance scenario 4).
 *
 * @param sql - a connection
 * @param pairingId - the pairing
 * @returns the entries, oldest first
 * @example
 * ```ts
 * const timeline = await listPairingEvents(sql, pairing.id);
 * ```
 */
export const listPairingEvents = async (
  sql: SQL,
  pairingId: string,
): Promise<PairingEventRow[]> => {
  const rows = await queryRows(sql`${pairingEventQuery(sql)}
    where pairing_event.pairing_id = ${pairingId}
    order by pairing_event.at`);
  return rows.map(toPairingEvent);
};
