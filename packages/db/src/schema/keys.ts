import { sql } from "drizzle-orm";
import { jsonb, pgEnum, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";

import { auditColumns, surrogateKey } from "./columns.ts";

/**
 * The signing keys Muster vouches with.
 *
 * Two rules live in this table rather than in the code that uses it. Exactly one
 * key per purpose is active, stated as a unique index over the active rows: a
 * second active key would make "which key did we sign with" a question with two
 * answers, and a rule enforced only in a function is a rule the next function
 * forgets. And the private half is a text column, never jsonb, because what is
 * stored there is ciphertext under `MUSTER_MASTER_KEY` with a version tag on the
 * front - a shape the database has no business parsing.
 *
 * Superseded rows are kept. They are what lets a statement signed before a
 * rotation still verify (FR-024), and dropping one early is indistinguishable, to
 * a server, from Muster never having signed the statement at all.
 *
 * @author John Grimes
 */

/** What a key signs, per the data model. */
export const signingPurpose = pgEnum("signing_purpose", [
  "statements",
  "tickets",
]);

/** Whether a key is the one being signed with, or one being kept for verifiers. */
export const signingKeyStatus = pgEnum("signing_key_status", [
  "active",
  "superseded",
]);

/** One key pair, published by its identifier. */
export const signingKey = pgTable(
  "signing_key",
  {
    id: surrogateKey(),
    // The identifier a JWS protected header carries and the JWKS publishes.
    kid: text().notNull().unique(),
    purpose: signingPurpose().notNull(),
    status: signingKeyStatus().notNull().default("active"),
    // Served as-is in the JWKS.
    publicJwk: jsonb().notNull(),
    // Ciphertext under the master key, version-tagged. Never logged, never
    // returned, and never read by anything but the signer.
    privateJwk: text().notNull(),
    ...auditColumns(),
  },
  (table) => [
    uniqueIndex("signing_key_one_active_per_purpose")
      .on(table.purpose)
      .where(sql`${table.status} = 'active'`),
  ],
);
