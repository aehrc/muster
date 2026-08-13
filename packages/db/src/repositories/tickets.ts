/**
 * Recording the permission tickets Muster has minted.
 *
 * The shape of the write is the point: it takes the claims and never the artefact. There is
 * no parameter for the compact JWT because there is no column for it - see
 * `../schema/tickets.ts` and constitution principle IV - so a caller cannot store one by
 * accident, and a reviewer reading this file can see that in the type. The read hands back
 * the same thing: what was authorised, never the credential that authorised it.
 *
 * Nothing updates a row. A ticket is a record of Muster having authorised access at a time.
 *
 * Author: John Grimes
 */

import { desc, eq } from "drizzle-orm";

import { requireRow } from "./rows.js";
import { ticket } from "../schema/tickets.js";

import type { Executor } from "../executor.js";
import type { TicketRow } from "../schema/tickets.js";
import type { PermissionTicketClaims } from "@muster/core";

/** What a mint records. Note what is absent: the artefact itself. */
export interface NewTicket {
  readonly eventId: string;
  readonly personaId: string;
  /** The member who minted it. */
  readonly mintedBy: string;
  readonly jti: string;
  /** The `kid` of the key it was signed with. */
  readonly keyId: string;
  readonly claims: PermissionTicketClaims;
  readonly expiresAt: Date;
  readonly now: Date;
}

/**
 * Records a minted ticket.
 *
 * @param db - The executor.
 * @param input - The claims, the key, the persona and who caused it.
 * @returns The stored row.
 * @throws {Error} When the identifier is already held, which would mean two tickets sharing
 *   one identifier - and a replay cache at a data holder cannot tell those apart.
 * @example
 * ```ts
 * const stored = await insertTicket(db, {
 *   eventId: event.id,
 *   personaId: persona.id,
 *   mintedBy: callerId(c),
 *   jti: claims.jti,
 *   keyId: signing.kid,
 *   claims,
 *   expiresAt: new Date(claims.exp * 1000),
 *   now: context.clock(),
 * });
 * ```
 */
export async function insertTicket(
  db: Executor,
  input: NewTicket,
): Promise<TicketRow> {
  return requireRow(
    await db
      .insert(ticket)
      .values({
        eventId: input.eventId,
        personaId: input.personaId,
        mintedBy: input.mintedBy,
        jti: input.jti,
        keyId: input.keyId,
        claims: input.claims,
        expiresAt: input.expiresAt,
        createdAt: input.now,
      })
      .returning(),
    "insert into ticket",
  );
}

/**
 * The tickets minted for one event, most recent first.
 *
 * The record of what was authorised, which is what FR-033 asks to be kept - never the
 * artefacts, which are not stored and could not be returned from here if a caller asked.
 *
 * @param db - The executor.
 * @param eventId - The event.
 * @returns The rows, newest first.
 * @example
 * ```ts
 * const minted = await listEventTickets(db, event.id);
 * ```
 */
export async function listEventTickets(
  db: Executor,
  eventId: string,
): Promise<readonly TicketRow[]> {
  return await db
    .select()
    .from(ticket)
    .where(eq(ticket.eventId, eventId))
    .orderBy(desc(ticket.createdAt));
}
