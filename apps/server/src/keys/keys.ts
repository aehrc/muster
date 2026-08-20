/*
 * Copyright © 2026 Commonwealth Scientific and Industrial Research Organisation
 * (CSIRO) ABN 41 687 119 230. Licensed under the Apache License, Version 2.0.
 */

import { publicJwkSchema } from "@muster/contracts";
import {
  decryptUnderMasterKey,
  encryptUnderMasterKey,
  findActiveSigningKey,
  findSigningKeyByKid,
  insertSigningKey,
  isUniqueViolation,
  listPublishableSigningKeys,
  supersedeSigningKey,
} from "@muster/db";
import {
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
  importJWK,
  SignJWT,
} from "jose";

import type { Jwks, PublicJwk, SigningPurpose } from "@muster/contracts";
import type { NewSigningKey, SigningKeyRow } from "@muster/db";
import type { SQL } from "bun";
import type { CryptoKey, JWK } from "jose";

/**
 * The signing keys Muster vouches with: generating them, reading them back, and
 * deciding which of them the world still needs to see.
 *
 * Muster is a trust anchor, so these keys are the whole basis on which a
 * stranger's server believes anything Muster says. Three rules follow from that,
 * and all three are enforced here rather than left to callers.
 *
 * A private key exists in the clear only in memory. It is generated, immediately
 * encrypted under `MUSTER_MASTER_KEY`, and written as ciphertext with a version
 * tag; reading it back is the only decryption in the codebase, and the plaintext
 * never reaches a log, a response or an error message.
 *
 * One key per purpose signs at a time, and the database says so. `ensureActiveSigningKey`
 * is safe to call from anywhere and at any time: two callers racing produce one
 * key, because the loser of the race is the unique index's refusal and it answers
 * with the winner's key rather than failing.
 *
 * Rotation retires rather than replaces. A superseded key stays published while
 * anything signed with it is still valid (FR-024), which is what lets a key be
 * rotated in the middle of an event without breaking the statements already in
 * flight.
 *
 * @author John Grimes
 */

/** The algorithm every Muster artefact is signed with, per the profile. */
const signingAlgorithm = "ES256";

/** Which key, and the master key it is encrypted under. */
export type SigningKeyOptions = {
  /** what the key signs */
  readonly purpose: SigningPurpose;
  /** the deployment's master key */
  readonly masterKey: string;
};

/** A key ready to sign with. */
export type SigningKey = {
  /** the identifier to put in the protected header */
  readonly kid: string;
  /** what it signs */
  readonly purpose: SigningPurpose;
  /** the private half, imported for signing */
  readonly privateKey: CryptoKey;
};

/**
 * Generates a key pair, encrypting the private half before it goes anywhere.
 *
 * The identifier is the public key's JWK thumbprint (RFC 7638), so it is derived
 * from the key rather than assigned: two keys cannot collide, and an implementer
 * can check that a `kid` belongs to the key it names.
 *
 * @param options - the purpose and the master key
 * @returns the key, ready to record, with its private half already ciphertext
 * @example
 * ```ts
 * const generated = await generateSigningKey({ purpose: "statements", masterKey });
 * ```
 */
export const generateSigningKey = async (
  options: SigningKeyOptions,
): Promise<NewSigningKey> => {
  const pair = await generateKeyPair(signingAlgorithm, { extractable: true });
  const publicJwk = await exportJWK(pair.publicKey);
  const kid = await calculateJwkThumbprint(publicJwk);
  const privateJwk = await exportJWK(pair.privateKey);
  return {
    kid,
    purpose: options.purpose,
    publicJwk: {
      ...publicJwk,
      alg: signingAlgorithm,
      use: "sig",
      kid,
      muster_purpose: options.purpose,
    },
    privateJwk: encryptUnderMasterKey(
      options.masterKey,
      JSON.stringify({ ...privateJwk, alg: signingAlgorithm, kid }),
    ),
  };
};

/**
 * Reads the active key of a purpose, generating it the first time.
 *
 * @param sql - a connection
 * @param options - the purpose and the master key
 * @returns the active key
 * @throws {Error} when the key can be neither found nor generated
 * @example
 * ```ts
 * await ensureActiveSigningKey(sql, { purpose: "statements", masterKey });
 * ```
 */
export const ensureActiveSigningKey = async (
  sql: SQL,
  options: SigningKeyOptions,
): Promise<SigningKeyRow> => {
  const existing = await findActiveSigningKey(sql, options.purpose);
  if (existing !== undefined) {
    return existing;
  }
  try {
    return await insertSigningKey(sql, await generateSigningKey(options));
  } catch (cause) {
    if (!isUniqueViolation(cause)) {
      throw cause;
    }
    // Another caller got there first; the constraint is what told us, and its
    // key is as good as the one this call would have made.
    const winner = await findActiveSigningKey(sql, options.purpose);
    if (winner === undefined) {
      throw cause;
    }
    return winner;
  }
};

/**
 * Retires the active key of a purpose and activates a new one.
 *
 * In that order, so there is never a moment with two active keys; the window in
 * which there is none is the width of one statement, and a signer that arrives
 * inside it generates the replacement itself.
 *
 * @param sql - a connection
 * @param options - the purpose and the master key
 * @returns the new active key
 * @throws {Error} when the new key cannot be recorded
 * @example
 * ```ts
 * const key = await rotateSigningKey(sql, { purpose: "statements", masterKey });
 * ```
 */
export const rotateSigningKey = async (
  sql: SQL,
  options: SigningKeyOptions,
): Promise<SigningKeyRow> => {
  const current = await findActiveSigningKey(sql, options.purpose);
  if (current !== undefined) {
    await supersedeSigningKey(sql, current.kid);
  }
  return insertSigningKey(sql, await generateSigningKey(options));
};

/**
 * Reads the active key of a purpose, imported and ready to sign with.
 *
 * @param sql - a connection
 * @param options - the purpose and the master key
 * @returns the key to sign with
 * @throws {Error} when the purpose has no key, or its ciphertext cannot be read
 *   under the configured master key
 * @example
 * ```ts
 * const key = await activeSigningKey(sql, { purpose: "statements", masterKey });
 * const jws = await signJws(key, claims);
 * ```
 */
export const activeSigningKey = async (
  sql: SQL,
  options: SigningKeyOptions,
): Promise<SigningKey> => {
  const row = await ensureActiveSigningKey(sql, options);
  return importSigningKey(row, options.masterKey);
};

/**
 * Reads one key by its identifier, imported and ready to sign with.
 *
 * Signing with a superseded key is deliberately possible: the conformance harness
 * needs a statement whose key the target server cannot know about, and reaching
 * for a key by identifier is how it gets one.
 *
 * @param sql - a connection
 * @param kid - the key identifier
 * @param masterKey - the deployment's master key
 * @returns the key, or undefined when there is no such key
 * @throws {Error} when the ciphertext cannot be read under the given master key
 * @example
 * ```ts
 * const key = await signingKeyByKid(sql, statement.keyId, config.masterKey);
 * ```
 */
export const signingKeyByKid = async (
  sql: SQL,
  kid: string,
  masterKey: string,
): Promise<SigningKey | undefined> => {
  const row = await findSigningKeyByKid(sql, kid);
  return row === undefined ? undefined : importSigningKey(row, masterKey);
};

/**
 * Decrypts and imports a stored key.
 *
 * @param row - the key as stored
 * @param masterKey - the deployment's master key
 * @returns the key to sign with
 * @throws {Error} when the ciphertext cannot be read, or is not an ES256 key
 */
const importSigningKey = async (
  row: SigningKeyRow,
  masterKey: string,
): Promise<SigningKey> => {
  const jwk: unknown = JSON.parse(
    decryptUnderMasterKey(masterKey, row.privateJwk),
  );
  const imported = await importJWK(jwk as JWK, signingAlgorithm);
  if (typeof imported === "object" && "type" in imported) {
    return { kid: row.kid, purpose: row.purpose, privateKey: imported };
  }
  // importJWK answers a key object for an asymmetric key and bytes for a
  // symmetric one; bytes here would mean the stored key is not what it claims.
  throw new Error(
    `The stored key ${row.kid} is not an ${signingAlgorithm} key.`,
  );
};

/**
 * Builds the JWKS: every key a verifier may still need.
 *
 * Each published key is parsed against the contract schema on the way out, so the
 * document a vendor reads is the document the contract describes or the request
 * fails - a malformed key served silently would be a verification failure that
 * looks like a signature problem.
 *
 * @param sql - a connection
 * @param now - the moment retention is reckoned from
 * @returns the key set to publish
 * @throws {Error} when a stored public key does not satisfy the contract
 * @example
 * ```ts
 * const jwks = await publishedJwks(sql, new Date());
 * ```
 */
export const publishedJwks = async (sql: SQL, now: Date): Promise<Jwks> => {
  const rows = await listPublishableSigningKeys(sql, now);
  return {
    keys: rows.map((row): PublicJwk => publicJwkSchema.parse(row.publicJwk)),
  };
};

/**
 * Signs claims as a compact JWS, with the key's identifier in the header.
 *
 * The `kid` is what the profile tells a server to match on, and `typ` is `JWT`
 * because the claims are a claim set rather than arbitrary bytes.
 *
 * @param key - the key to sign with
 * @param claims - the claims to sign, already built and already authorised
 * @returns the compact JWS
 * @throws {Error} when signing fails
 * @example
 * ```ts
 * const jws = await signJws(key, result.claims);
 * ```
 */
export const signJws = async (
  key: SigningKey,
  claims: Record<string, unknown>,
): Promise<string> =>
  new SignJWT(claims)
    .setProtectedHeader({ alg: signingAlgorithm, kid: key.kid, typ: "JWT" })
    .sign(key.privateKey);
