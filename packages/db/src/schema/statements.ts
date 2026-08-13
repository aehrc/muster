/**
 * Every software statement Muster has minted.
 *
 * Three columns need their reasons stated, because two of them differ from what
 * `data-model.md` writes and one of them is the replay control.
 *
 * **`jws` is stored, and `data-model.md` says it need not be.** The data model says "the
 * JWS itself is reproducible from claims + key", and for ECDSA that is not true: an ES256
 * signature includes a per-signature random value, so signing the same claims twice
 * produces two different compact serialisations. Both would verify, but FR-027 and
 * scenario 6 require the downloadable statement to be *the same artefact* Muster presented
 * itself - so the artefact is recorded rather than re-derived. It is not a credential the
 * constitution forbids storing: principle IV forbids storing client secrets and forbids
 * writing a statement to a *log*, and the statement is a thing the app owner is entitled
 * to download.
 *
 * **`jti` is unique, and that is the replay control on Muster's side.** The profile makes a
 * statement identifier single-use at the server, and this index is the other half: a
 * retried run mints a new statement with a new identifier rather than presenting the old
 * one again, and the constraint is what makes that a rule instead of a habit.
 *
 * **`key_id` references the key, not just names it.** A statement whose signing key is not
 * in `signing_key` could never be verified, and principle VI turns on being able to ask
 * "does any unexpired artefact still reference this key?" - which is a join, so it is a
 * foreign key.
 *
 * Rows are never deleted. A statement is a record of Muster having vouched for something.
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
import { account } from "./directory.js";
import { signingKey } from "./keys.js";
import { pairing } from "./pairings.js";

import type { SoftwareStatementClaims } from "@muster/core";

/** One minted software statement (FR-023). */
export const softwareStatement = pgTable(
  "software_statement",
  {
    ...primaryId(),
    pairingId: uuid("pairing_id")
      .notNull()
      .references(() => pairing.id),
    /** The statement identifier. Single registration use, per the profile. */
    jti: text("jti").notNull(),
    /** The member who initiated the run. Vouching is always somebody's act. */
    mintedBy: uuid("minted_by")
      .notNull()
      .references(() => account.id),
    keyId: text("key_id")
      .notNull()
      .references(() => signingKey.kid),
    /** The signed claims, for display and audit. */
    claims: jsonb("claims").$type<SoftwareStatementClaims>().notNull(),
    /** The compact JWS, exactly as presented. See the module header. */
    jws: text("jws").notNull(),
    /** The vouching expiry, mirrored out of the claims so it can be queried. */
    expiresAt: instant("expires_at").notNull(),
    ...createdAt(),
  },
  (table) => [
    uniqueIndex("software_statement_jti_unique").on(table.jti),
    // "What was minted for this pairing, most recently?", asked by the pairing detail and
    // by the download route.
    index("software_statement_pairing_id_created_at_idx").on(
      table.pairingId,
      table.createdAt.desc(),
    ),
    // "Does any unexpired artefact still reference this key?" (principle VI).
    index("software_statement_key_id_expires_at_idx").on(
      table.keyId,
      table.expiresAt,
    ),
  ],
);

/** A row of `software_statement` as selected. */
export type SoftwareStatementRow = typeof softwareStatement.$inferSelect;
