import { asJson, jsonParameter, queryRows } from "./rows.ts";

import type { RawRow } from "./rows.ts";
import type { SigningKeyStatus, SigningPurpose } from "@muster/contracts";
import type { SQL } from "bun";

/**
 * Signing key data access: what Muster signs with, and what it still publishes.
 *
 * Two reads matter. The signer asks for the active key of a purpose, which the
 * table guarantees is one row. A verifier asks, through the JWKS route, for every
 * key it might still need: the active keys, plus the superseded keys that signed
 * something which has not yet expired (FR-024). The second is a query rather than
 * a stored flag, because "is anything signed with this key still alive" is a fact
 * about the artefacts and would go stale the moment a statement expired.
 *
 * A private key is written and read as opaque text. It is ciphertext under
 * `MUSTER_MASTER_KEY`, and nothing in this module decrypts it, logs it or returns
 * it anywhere but to the signer that asked.
 *
 * @author John Grimes
 */

/** A signing key as stored. */
export type SigningKeyRow = {
  /** primary key */
  readonly id: string;
  /** the identifier a protected header and the JWKS carry */
  readonly kid: string;
  /** what the key signs */
  readonly purpose: SigningPurpose;
  /** whether it is the key being signed with */
  readonly status: SigningKeyStatus;
  /** the public half, as published */
  readonly publicJwk: unknown;
  /** the private half, as ciphertext under the master key */
  readonly privateJwk: string;
  /** when it was generated */
  readonly createdAt: Date;
};

/** A signing key to record. */
export type NewSigningKey = {
  /** the identifier to publish it under */
  readonly kid: string;
  /** what it signs */
  readonly purpose: SigningPurpose;
  /** the public half */
  readonly publicJwk: unknown;
  /** the private half, already encrypted */
  readonly privateJwk: string;
};

/**
 * Maps a signing key row.
 *
 * @param row - the row as the driver returned it
 * @returns the key
 */
const toSigningKey = (row: RawRow): SigningKeyRow => ({
  id: String(row["id"]),
  kid: String(row["kid"]),
  purpose: row["purpose"] as SigningPurpose,
  status: row["status"] as SigningKeyStatus,
  publicJwk: asJson(row["public_jwk"]),
  privateJwk: String(row["private_jwk"]),
  createdAt: row["created_at"] as Date,
});

/**
 * Records a generated key as the active one for its purpose.
 *
 * @param sql - a connection
 * @param key - the key to record, its private half already encrypted
 * @returns the recorded key
 * @throws {Error} when the purpose already has an active key; classify with
 *   `isUniqueViolation`
 * @example
 * ```ts
 * const key = await insertSigningKey(sql, await generateSigningKey(options));
 * ```
 */
export const insertSigningKey = async (
  sql: SQL,
  key: NewSigningKey,
): Promise<SigningKeyRow> => {
  const rows = await queryRows(sql`insert into signing_key
      (kid, purpose, status, public_jwk, private_jwk)
    values (${key.kid}, ${key.purpose}::signing_purpose, 'active',
            ${jsonParameter(key.publicJwk)}::jsonb, ${key.privateJwk})
    returning *`);
  return toSigningKey(rows[0] ?? {});
};

/**
 * Reads the key a purpose is currently signed with.
 *
 * @param sql - a connection
 * @param purpose - what the key signs
 * @returns the active key, or undefined when the purpose has none yet
 * @example
 * ```ts
 * const key = await findActiveSigningKey(sql, "statements");
 * ```
 */
export const findActiveSigningKey = async (
  sql: SQL,
  purpose: SigningPurpose,
): Promise<SigningKeyRow | undefined> => {
  const rows = await queryRows(sql`select * from signing_key
    where purpose = ${purpose}::signing_purpose and status = 'active'`);
  return rows.length === 0 ? undefined : toSigningKey(rows[0] ?? {});
};

/**
 * Reads one key by the identifier it is published under.
 *
 * @param sql - a connection
 * @param kid - the key identifier
 * @returns the key, or undefined when no such key was ever generated
 * @example
 * ```ts
 * const key = await findSigningKeyByKid(sql, header.kid);
 * ```
 */
export const findSigningKeyByKid = async (
  sql: SQL,
  kid: string,
): Promise<SigningKeyRow | undefined> => {
  const rows = await queryRows(
    sql`select * from signing_key where kid = ${kid}`,
  );
  return rows.length === 0 ? undefined : toSigningKey(rows[0] ?? {});
};

/**
 * Retires a key from signing, keeping it for verifiers.
 *
 * @param sql - a connection
 * @param kid - the key identifier
 * @returns the superseded key, or undefined when there is no such key
 * @example
 * ```ts
 * await supersedeSigningKey(sql, previous.kid);
 * ```
 */
export const supersedeSigningKey = async (
  sql: SQL,
  kid: string,
): Promise<SigningKeyRow | undefined> => {
  const rows = await queryRows(sql`update signing_key
    set status = 'superseded', updated_at = now()
    where kid = ${kid}
    returning *`);
  return rows.length === 0 ? undefined : toSigningKey(rows[0] ?? {});
};

/**
 * Lists every key a verifier may still need.
 *
 * The active keys, and the superseded keys that signed an artefact which has not
 * yet expired. A superseded key that signed nothing, or whose artefacts have all
 * expired, is withdrawn - which is what the profile's first validation rule
 * depends on: a withdrawn key must stop verifying.
 *
 * @param sql - a connection
 * @param now - the moment retention is reckoned from
 * @returns the keys to publish, newest first
 * @example
 * ```ts
 * const keys = await listPublishableSigningKeys(sql, new Date());
 * ```
 */
export const listPublishableSigningKeys = async (
  sql: SQL,
  now: Date,
): Promise<SigningKeyRow[]> => {
  const rows = await queryRows(sql`select * from signing_key
    where status = 'active'
       or exists (select 1 from software_statement
                  where software_statement.key_id = signing_key.kid
                    and software_statement.expires_at > ${now})
    order by created_at desc, kid`);
  return rows.map(toSigningKey);
};
