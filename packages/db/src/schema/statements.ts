import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { auditColumns, surrogateKey } from "./columns.ts";
import { account } from "./directory.ts";
import { signingKey } from "./keys.ts";
import { pairing } from "./pairings.ts";

/**
 * The record of every software statement Muster has minted.
 *
 * A statement is a thing Muster said about somebody else's client to a third
 * party, so the record of having said it is not disposable: `jti`, the key it was
 * signed with, the claims, and the expiry are all kept, and the row is what makes
 * a rotated key's retention decidable (FR-024).
 *
 * The compact JWS is stored alongside the claims. The data model supposed it could
 * be reproduced from the claims and the key, but an ES256 signature is randomised
 * - re-signing the same claims yields a different token - and FR-027 asks for the
 * identical artefact to be downloadable. It is not a credential: it authenticates
 * nobody, it is single-use at the server, and it says only what Muster already
 * published. The client secret a server returns is the credential in this
 * exchange, and that is never stored anywhere (the constitution).
 *
 * @author John Grimes
 */

/** One minted software statement. */
export const softwareStatement = pgTable(
  "software_statement",
  {
    id: surrogateKey(),
    pairingId: uuid()
      .notNull()
      .references(() => pairing.id, { onDelete: "cascade" }),
    // The statement identifier a server de-duplicates on: unique here because it
    // must be unique there.
    jti: text().notNull().unique(),
    mintedBy: uuid()
      .notNull()
      .references(() => account.id),
    // Referenced by identifier rather than by row, because the identifier is what
    // travels in the protected header. The reference is what stops a key being
    // deleted out from under a statement that is still verifiable.
    keyId: text()
      .notNull()
      .references(() => signingKey.kid),
    claims: jsonb().notNull(),
    // The artefact itself, byte for byte as presented and as downloaded.
    jws: text().notNull(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    ...auditColumns(),
  },
  (table) => [
    // "The statement for this pairing" and "is anything signed with this key
    // still alive" are the only two reads, and these are them.
    index("software_statement_pairing_created_at_idx").on(
      table.pairingId,
      table.createdAt.desc(),
    ),
    index("software_statement_key_expires_at_idx").on(
      table.keyId,
      table.expiresAt.desc(),
    ),
  ],
);
