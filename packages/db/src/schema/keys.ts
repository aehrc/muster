/**
 * Muster's signing keys: the trust anchor's whole identity, at rest.
 *
 * Everything Muster vouches for is a signature made with one of these rows, so three
 * invariants are held by the schema rather than by a route remembering them.
 *
 * **Exactly one active key per purpose.** `data-model.md` says so, and a partial unique
 * index on `purpose` where the status is `active` is what makes it true rather than
 * intended. Without it, a half-finished rotation leaves two active keys and which one
 * signs depends on the order a query happens to return - so half the statements minted
 * that afternoon carry a `kid` nobody expected. Muster runs as one instance and rotation
 * happens inside one transaction that supersedes before it inserts, so the index costs
 * nothing and removes the whole class.
 *
 * **A key is never deleted, only superseded.** Principle VI: rotating a key must not
 * invalidate outstanding statements or tickets, and the only way for a superseded key to
 * keep verifying them is for the row to still be there to be published.
 *
 * **The private half's column name says what is in it.** `private_jwk_encrypted`, not
 * `private_jwk`, because a column named for the plaintext is a column somebody eventually
 * writes plaintext into. What is in it is a `masterKey.ts` envelope: `v1.<iv>.<ciphertext>`,
 * which is the version tag `data-model.md` asks for.
 *
 * The two purposes - statements and tickets - share the machinery and share nothing else.
 * A ticket is a different assertion to a different audience, and an authorization server
 * that had been told to trust Muster's registration key would otherwise also be trusting
 * whatever the ticket playground signs.
 *
 * Author: John Grimes
 */

import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";

import { instant, primaryId, timestamps } from "./columns.js";
import { signingKeyPurposeEnum, signingKeyStatusEnum } from "./enums.js";

/**
 * One ES256 key pair, with the public half as it is published.
 *
 * `public_jwk` is stored as the document the JWKS serves rather than as its components,
 * so what a vendor verifies against is byte-for-byte what was recorded when the key was
 * made - there is no assembly step between the two that could drop `kid` or change `alg`.
 */
export const signingKey = pgTable(
  "signing_key",
  {
    ...primaryId(),
    /**
     * The JWK thumbprint (RFC 7638). Named in every artefact this key signs.
     *
     * A table constraint rather than a unique index, because `software_statement.key_id`
     * references it and Postgres will not accept a reference to a column whose uniqueness
     * arrives later in the same migration.
     */
    kid: text("kid").notNull().unique("signing_key_kid_unique"),
    purpose: signingKeyPurposeEnum("purpose").notNull(),
    status: signingKeyStatusEnum("status").notNull().default("active"),
    /** Served verbatim from the JWKS. Carries `kid`, `alg` and `use`. */
    publicJwk: jsonb("public_jwk").$type<Record<string, unknown>>().notNull(),
    /** A `masterKey.ts` envelope over the private JWK. Never logged, never returned. */
    privateJwkEncrypted: text("private_jwk_encrypted").notNull(),
    /** When it stopped signing. Null while active. */
    supersededAt: instant("superseded_at"),
    ...timestamps(),
  },
  (table) => [
    // The invariant from `data-model.md`, as a constraint. Partial: any number of
    // superseded keys may exist per purpose, and must.
    uniqueIndex("signing_key_one_active_per_purpose")
      .on(table.purpose)
      .where(sql`status = 'active'`),
    // "Which key signs now?", asked once per mint, and "what does the JWKS publish?",
    // asked by every vendor.
    index("signing_key_purpose_status_idx").on(table.purpose, table.status),
  ],
);

/** A row of `signing_key` as selected. */
export type SigningKeyRow = typeof signingKey.$inferSelect;
