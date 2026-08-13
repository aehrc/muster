/**
 * Reading and recording the software statements Muster has minted.
 *
 * Two things worth stating.
 *
 * **Nothing updates a row.** A statement is a record of Muster having vouched for
 * something at a time, so a retry appends a new one rather than editing the old. That is
 * also what makes the `jti` uniqueness meaningful: a retried run cannot present the
 * identifier a server has already consumed.
 *
 * **The stored JWS is the artefact, not a copy of it.** FR-027 and scenario 6 require the
 * downloadable statement to be the same artefact Muster presented, and an ES256 signature
 * is randomised - re-signing the same claims produces a different serialisation. So the
 * download route reads this column rather than re-deriving anything.
 *
 * Author: John Grimes
 */

import { desc, eq } from "drizzle-orm";

import { firstRow, requireRow } from "./rows.js";
import { softwareStatement } from "../schema/statements.js";

import type { Executor } from "../executor.js";
import type { SoftwareStatementRow } from "../schema/statements.js";
import type { SoftwareStatementClaims } from "@muster/core";

/** What a mint records. */
export interface NewSoftwareStatement {
  readonly pairingId: string;
  readonly jti: string;
  /** The member who initiated the run. Vouching is always somebody's act. */
  readonly mintedBy: string;
  /** The `kid` of the key it was signed with. */
  readonly keyId: string;
  readonly claims: SoftwareStatementClaims;
  /** The compact JWS, exactly as it will be presented. */
  readonly jws: string;
  readonly expiresAt: Date;
  readonly now: Date;
}

/**
 * Records a minted statement.
 *
 * @param db - The executor.
 * @param input - The claims, the artefact, the key and who caused it.
 * @returns The stored row.
 * @throws {Error} When the identifier is already held - which would mean two statements
 *   sharing a single-use identifier, and is why the column is unique.
 * @example
 * ```ts
 * const stored = await insertSoftwareStatement(db, {
 *   pairingId: row.pairing.id,
 *   jti: claims.jti,
 *   mintedBy: callerId(c),
 *   keyId: signing.kid,
 *   claims,
 *   jws,
 *   expiresAt: new Date(claims.exp * 1000),
 *   now: context.clock(),
 * });
 * ```
 */
export async function insertSoftwareStatement(
  db: Executor,
  input: NewSoftwareStatement,
): Promise<SoftwareStatementRow> {
  return requireRow(
    await db
      .insert(softwareStatement)
      .values({
        pairingId: input.pairingId,
        jti: input.jti,
        mintedBy: input.mintedBy,
        keyId: input.keyId,
        claims: input.claims,
        jws: input.jws,
        expiresAt: input.expiresAt,
        createdAt: input.now,
      })
      .returning(),
    "insert into software_statement",
  );
}

/**
 * The most recent statement minted for a pairing.
 *
 * The most recent rather than all of them, because that is what both callers want: the
 * download route serves the artefact that was presented, and the pairing detail shows the
 * claims that are in force. The earlier ones stay for the record.
 *
 * @param db - The executor.
 * @param pairingId - The pairing.
 * @returns The statement, or `undefined` when none has been minted.
 */
export async function findLatestSoftwareStatement(
  db: Executor,
  pairingId: string,
): Promise<SoftwareStatementRow | undefined> {
  return firstRow(
    await db
      .select()
      .from(softwareStatement)
      .where(eq(softwareStatement.pairingId, pairingId))
      .orderBy(desc(softwareStatement.createdAt))
      .limit(1),
  );
}
