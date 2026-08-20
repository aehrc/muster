/*
 * Copyright © 2026 Commonwealth Scientific and Industrial Research Organisation
 * (CSIRO) ABN 41 687 119 230. Licensed under the Apache License, Version 2.0.
 */

import { asJson, jsonParameter, queryRows } from "./rows.ts";

import type { RawRow } from "./rows.ts";
import type { SQL } from "bun";

/**
 * Permission ticket data access.
 *
 * One function, because there is one thing to do: record a mint. Nothing here
 * updates or deletes - a ticket that was minted was minted - and nothing reads the
 * artefact back, because the artefact was never stored. The member who minted it
 * was shown it once; a member who needs another one mints another one, which is
 * both cheaper and safer than making a bearer token retrievable.
 *
 * The claims are stored as given. They are validated against the contract schema by
 * the route before they arrive, so what is in the column is what was signed.
 *
 * @author John Grimes
 */

/** A minted ticket as stored. */
export type TicketRow = {
  /** primary key */
  readonly id: string;
  /** the event it was minted for */
  readonly eventId: string;
  /** the persona it names as its subject */
  readonly personaId: string;
  /** the account that minted it */
  readonly mintedBy: string;
  /** the ticket identifier */
  readonly jti: string;
  /** the key it was signed with */
  readonly keyId: string;
  /** the claims, as signed */
  readonly claims: unknown;
  /** when it stops being valid */
  readonly expiresAt: Date;
  /** when it was minted */
  readonly createdAt: Date;
};

/** A ticket to record. */
export type NewTicket = {
  /** the event it was minted for */
  readonly eventId: string;
  /** the persona it names as its subject */
  readonly personaId: string;
  /** the account minting it */
  readonly mintedBy: string;
  /** the ticket identifier */
  readonly jti: string;
  /** the key it was signed with */
  readonly keyId: string;
  /** the claims, as signed */
  readonly claims: unknown;
  /** when it stops being valid */
  readonly expiresAt: Date;
};

/**
 * Maps a ticket row.
 *
 * @param row - the row as the driver returned it
 * @returns the ticket
 */
const toTicket = (row: RawRow): TicketRow => ({
  id: String(row["id"]),
  eventId: String(row["event_id"]),
  personaId: String(row["persona_id"]),
  mintedBy: String(row["minted_by"]),
  jti: String(row["jti"]),
  keyId: String(row["key_id"]),
  claims: asJson(row["claims"]),
  expiresAt: row["expires_at"] as Date,
  createdAt: row["created_at"] as Date,
});

/**
 * Records a minted ticket.
 *
 * The compact artefact is not a parameter, and there is no column for it: a ticket
 * is a bearer token, so it is shown to the member who minted it once and written
 * nowhere (the constitution).
 *
 * @param sql - a connection
 * @param ticket - the mint to record
 * @returns the recorded ticket
 * @throws {Error} when the ticket identifier is already recorded; classify with
 *   `isUniqueViolation`
 * @example
 * ```ts
 * const record = await insertTicket(sql, {
 *   eventId: event.id,
 *   personaId: persona.id,
 *   mintedBy: account.id,
 *   jti: claims.jti,
 *   keyId: key.kid,
 *   claims,
 *   expiresAt,
 * });
 * ```
 */
export const insertTicket = async (
  sql: SQL,
  ticket: NewTicket,
): Promise<TicketRow> => {
  const rows = await queryRows(sql`insert into ticket
      (event_id, persona_id, minted_by, jti, key_id, claims, expires_at)
    values (${ticket.eventId}, ${ticket.personaId}, ${ticket.mintedBy},
            ${ticket.jti}, ${ticket.keyId},
            ${jsonParameter(ticket.claims)}::jsonb, ${ticket.expiresAt})
    returning *`);
  return toTicket(rows[0] ?? {});
};
