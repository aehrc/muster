/*
 * Copyright © 2026 Commonwealth Scientific and Industrial Research Organisation
 * (CSIRO) ABN 41 687 119 230. Licensed under the Apache License, Version 2.0.
 */

import { asJson, jsonParameter, queryRows } from "./rows.ts";

import type { RawRow } from "./rows.ts";
import type { SQL } from "bun";

/**
 * Software statement data access.
 *
 * A statement is something Muster said about somebody else's client to a third
 * party, so the row recording it is not disposable: the statement identifier, the
 * key it was signed with, the claims and the expiry are all kept. Nothing here
 * updates or deletes - a vouching that was issued was issued.
 *
 * The compact JWS is stored with the claims because FR-027 asks for the identical
 * artefact to be downloadable and an ES256 signature is randomised, so re-signing
 * the same claims would produce a different token. It is not a credential: it
 * authenticates nobody and says only what Muster already published. The client
 * secret a server returns in exchange for it is the credential, and that is never
 * stored anywhere.
 *
 * @author John Grimes
 */

/** A minted statement as stored. */
export type SoftwareStatementRow = {
  /** primary key */
  readonly id: string;
  /** the pairing it was minted for */
  readonly pairingId: string;
  /** the statement identifier */
  readonly jti: string;
  /** the account that minted it */
  readonly mintedBy: string;
  /** the key it was signed with */
  readonly keyId: string;
  /** the claims, as signed */
  readonly claims: unknown;
  /** the compact JWS, byte for byte as presented */
  readonly jws: string;
  /** when vouching stops */
  readonly expiresAt: Date;
  /** when it was minted */
  readonly createdAt: Date;
};

/** A statement to record. */
export type NewSoftwareStatement = {
  /** the pairing it was minted for */
  readonly pairingId: string;
  /** the statement identifier */
  readonly jti: string;
  /** the account minting it */
  readonly mintedBy: string;
  /** the key it was signed with */
  readonly keyId: string;
  /** the claims, as signed */
  readonly claims: unknown;
  /** the compact JWS */
  readonly jws: string;
  /** when vouching stops */
  readonly expiresAt: Date;
};

/**
 * Maps a statement row.
 *
 * @param row - the row as the driver returned it
 * @returns the statement
 */
const toStatement = (row: RawRow): SoftwareStatementRow => ({
  id: String(row["id"]),
  pairingId: String(row["pairing_id"]),
  jti: String(row["jti"]),
  mintedBy: String(row["minted_by"]),
  keyId: String(row["key_id"]),
  claims: asJson(row["claims"]),
  jws: String(row["jws"]),
  expiresAt: row["expires_at"] as Date,
  createdAt: row["created_at"] as Date,
});

/**
 * Records a minted statement.
 *
 * Recorded before it is presented, so that a statement which was minted is on the
 * record whether the server accepted it or not: a `jti` Muster has issued is spent
 * either way, and an attempt that failed is exactly the thing the app owner needs
 * to be able to look at.
 *
 * @param sql - a connection
 * @param statement - the statement to record
 * @returns the recorded statement
 * @throws {Error} when the statement identifier is already recorded; classify with
 *   `isUniqueViolation`
 * @example
 * ```ts
 * const record = await insertSoftwareStatement(sql, {
 *   pairingId: pairing.id,
 *   jti: claims.jti,
 *   mintedBy: account.id,
 *   keyId: key.kid,
 *   claims,
 *   jws,
 *   expiresAt,
 * });
 * ```
 */
export const insertSoftwareStatement = async (
  sql: SQL,
  statement: NewSoftwareStatement,
): Promise<SoftwareStatementRow> => {
  const rows = await queryRows(sql`insert into software_statement
      (pairing_id, jti, minted_by, key_id, claims, jws, expires_at)
    values (${statement.pairingId}, ${statement.jti}, ${statement.mintedBy},
            ${statement.keyId}, ${jsonParameter(statement.claims)}::jsonb,
            ${statement.jws}, ${statement.expiresAt})
    returning *`);
  return toStatement(rows[0] ?? {});
};

/**
 * Reads the newest statement minted for a pairing.
 *
 * @param sql - a connection
 * @param pairingId - the pairing
 * @returns the statement, or undefined when none has been minted
 * @example
 * ```ts
 * const statement = await findLatestStatementForPairing(sql, pairing.id);
 * ```
 */
export const findLatestStatementForPairing = async (
  sql: SQL,
  pairingId: string,
): Promise<SoftwareStatementRow | undefined> => {
  const rows = await queryRows(sql`select * from software_statement
    where pairing_id = ${pairingId}
    order by created_at desc
    limit 1`);
  return rows.length === 0 ? undefined : toStatement(rows[0] ?? {});
};
