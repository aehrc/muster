import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { auditColumns, surrogateKey } from "./columns.ts";
import { account, event } from "./directory.ts";
import { signingKey } from "./keys.ts";
import { persona } from "./personas.ts";

/**
 * The record of every permission ticket Muster has minted.
 *
 * The data model's `ticket` table, and the column it deliberately does not have is
 * the interesting part: there is no `jws`. A ticket is a bearer artefact - whoever
 * holds it can present it to a data holder as the persona's authorisation - so it
 * is shown to the member who minted it exactly once and is written nowhere (the
 * constitution). The claims are kept, because a thing Muster said about a persona
 * to somebody else's server is not disposable, and they are enough to answer who
 * minted what, for whom, under which constraints and until when.
 *
 * That is the difference from `software_statement`, which does store its artefact:
 * a statement authenticates nobody and is downloadable by design (FR-027), while a
 * ticket authorises access to a record.
 *
 * @author John Grimes
 */

/** One minted permission ticket. */
export const ticket = pgTable(
  "ticket",
  {
    id: surrogateKey(),
    eventId: uuid()
      .notNull()
      .references(() => event.id, { onDelete: "cascade" }),
    personaId: uuid()
      .notNull()
      .references(() => persona.id, { onDelete: "cascade" }),
    mintedBy: uuid()
      .notNull()
      .references(() => account.id),
    // The ticket identifier a data holder de-duplicates on: unique here because
    // it must be unique there.
    jti: text().notNull().unique(),
    // Referenced by identifier rather than by row, because the identifier is what
    // travels in the protected header. The reference is what stops a key being
    // deleted out from under a ticket that is still being verified.
    keyId: text()
      .notNull()
      .references(() => signingKey.kid),
    // The claims as signed, validated against the contract schema before they are
    // written. Not the artefact: see the note above.
    claims: jsonb().notNull(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    ...auditColumns(),
  },
  (table) => [
    // "What has been minted for this event" and "is anything signed with this key
    // still alive" are the only two reads, and these are them.
    index("ticket_event_created_at_idx").on(
      table.eventId,
      table.createdAt.desc(),
    ),
    index("ticket_key_expires_at_idx").on(table.keyId, table.expiresAt.desc()),
  ],
);
