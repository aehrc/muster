/**
 * Every permission ticket Muster has minted - and deliberately not the tickets themselves.
 *
 * Three columns need their reasons stated, and the first is the whole difference between
 * this table and `software_statement` beside it.
 *
 * **There is no column for the compact JWT, and there must not be.** `data-model.md` writes
 * it plainly - "the compact JWT is displayed at mint time, reproducible, not stored" - and
 * constitution principle IV is why. A software statement is an artefact its owner presents
 * to a registration endpoint to create a client; a permission ticket is a bearer credential
 * that releases a patient's health record to whoever holds it. Storing the second would put
 * a live credential in a database whose whole purpose is to be publicly readable in parts.
 * So the row records *that a ticket was minted, by whom, for whom, and under what
 * constraints* (FR-033), and the artefact exists only in the response that returned it.
 *
 * The consequence is accepted rather than worked around: a member who navigates away has
 * lost the ticket and mints another. That is the same bargain the client secret makes in
 * `dcr.routes.ts`, for the same reason.
 *
 * **`jti` is unique, across every ticket rather than per event.** A data holder that keeps a
 * replay cache keys it on the identifier alone, and an identifier that repeated across two
 * events would be two tickets a conformant holder could not tell apart.
 *
 * **`key_id` references the key, not just names it.** Principle VI turns on being able to
 * ask "does any unexpired artefact still reference this key?", which is a join - so it is a
 * foreign key, and `listPublishedSigningKeys` reads this table as well as the statements.
 *
 * Rows are never deleted. A ticket is a record of Muster having authorised access to a
 * persona's record.
 *
 * Author: John Grimes
 */

import {
  index,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { createdAt, instant, primaryId } from "./columns.js";
import { account, event } from "./directory.js";
import { signingKey } from "./keys.js";
import { persona } from "./personas.js";

import type { PermissionTicketClaims } from "@muster/core";

/** One minted permission ticket (FR-033). */
export const ticket = pgTable(
  "ticket",
  {
    ...primaryId(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => event.id),
    /** The persona whose IHI the ticket's subject is bound to. */
    personaId: uuid("persona_id")
      .notNull()
      .references(() => persona.id),
    /** The member who minted it. Authorising access is always somebody's act. */
    mintedBy: uuid("minted_by")
      .notNull()
      .references(() => account.id),
    jti: text("jti").notNull(),
    keyId: text("key_id")
      .notNull()
      .references(() => signingKey.kid),
    /** The signed claims: the type, the subject binding and the scope constraints. */
    claims: jsonb("claims").$type<PermissionTicketClaims>().notNull(),
    /** The expiry, mirrored out of the claims so it can be queried. */
    expiresAt: instant("expires_at").notNull(),
    ...createdAt(),
  },
  (table) => [
    uniqueIndex("ticket_jti_unique").on(table.jti),
    // "What has been minted for this event, most recently?"
    index("ticket_event_id_created_at_idx").on(
      table.eventId,
      table.createdAt.desc(),
    ),
    // "Does any unexpired artefact still reference this key?" (principle VI).
    index("ticket_key_id_expires_at_idx").on(table.keyId, table.expiresAt),
  ],
);

/** A row of `ticket` as selected. */
export type TicketRow = typeof ticket.$inferSelect;
