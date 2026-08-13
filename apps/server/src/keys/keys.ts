/**
 * Muster's signing keys: made, recovered, rotated and published.
 *
 * This is the trust anchor's identity. Everything Muster vouches for is a signature made
 * here, so five decisions are worth stating, and the last two are constitution principle
 * VI in full.
 *
 * **ES256, and the `kid` is the key's own thumbprint.** RFC 7638 makes the identifier a
 * function of the public key rather than a name somebody chose, so two deployments cannot
 * pick the same one and a rotation cannot accidentally reuse an identifier that an
 * outstanding artefact already names. It also means a vendor can check that the `kid` in a
 * header belongs to the key they verified with.
 *
 * **The private half is stored as an envelope and never as a JWK.** `masterKey.ts` seals it
 * under `MUSTER_MASTER_KEY` (principle IV). It has to be recoverable rather than hashed,
 * because signing tomorrow's statement with a different key would invalidate today's.
 *
 * **The active key is read per issuance, never cached.** A cached key would keep signing
 * after a rotation, which is exactly the case rotation exists to end - and the read is one
 * indexed row against a database this process is already talking to.
 *
 * **Both purposes get a key at startup, including the one nothing signs with yet.** A
 * vendor configuring Muster as a trust anchor reads the JWKS once and expects to find the
 * anchor, not half of it. The tickets key exists from User Story 5 and is minted with from
 * User Story 8.
 *
 * **What the JWKS publishes is decided by the artefacts, not by a status.** A superseded key
 * stays in the document while anything it signed is still unexpired, and leaves when
 * nothing is - which is what FR-024 asks for, and which the repository answers with a join
 * rather than this module keeping a third state in step.
 *
 * Author: John Grimes
 */

import {
  SIGNING_KEY_PURPOSES,
  SOFTWARE_STATEMENT_ALGORITHM,
} from "@muster/core";
import {
  decryptSecret,
  encryptSecret,
  findActiveSigningKey,
  installActiveSigningKey,
  listPublishedSigningKeys,
  rotateSigningKey,
} from "@muster/db";
import {
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
  importJWK,
  SignJWT,
} from "jose";

import type { SigningKeyPurpose } from "@muster/core";
import type { Database, SigningKeyRow } from "@muster/db";
import type { JWK } from "jose";

/** A freshly generated key pair, ready to record. */
export interface GeneratedSigningKey {
  /** The RFC 7638 thumbprint of the public key. */
  readonly kid: string;
  /** The document the JWKS serves, carrying `kid`, `alg` and `use`. */
  readonly publicJwk: Record<string, unknown>;
  /** A `masterKey.ts` envelope over the private JWK. */
  readonly privateJwkEncrypted: string;
}

/** A key recovered from the database, ready to sign with. */
export interface LoadedSigningKey {
  readonly kid: string;
  readonly key: CryptoKey;
}

/** The JWKS document, as the public route serves it. */
export interface PublishedJwks {
  readonly keys: readonly JWK[];
}

/**
 * Generates an ES256 key pair and seals the private half.
 *
 * @param masterKey - `MUSTER_MASTER_KEY`.
 * @returns The identifier, the publishable public JWK, and the sealed private JWK.
 * @throws {EnvelopeError} When the master key is too short to seal anything.
 * @example
 * ```ts
 * const generated = await generateSigningKey(config.masterKey);
 * ```
 */
export async function generateSigningKey(
  masterKey: string,
): Promise<GeneratedSigningKey> {
  // Extractable, because the private half has to be serialisable to survive a restart -
  // which is the whole reason it is encrypted rather than kept in memory.
  const { publicKey, privateKey } = await generateKeyPair(
    SOFTWARE_STATEMENT_ALGORITHM,
    { extractable: true },
  );

  const publicJwk = await exportJWK(publicKey);
  const privateJwk = await exportJWK(privateKey);
  // Computed over the canonical members only, which is what RFC 7638 specifies and what a
  // vendor recomputing it will do.
  const kid = await calculateJwkThumbprint(publicJwk);

  return {
    kid,
    publicJwk: {
      ...publicJwk,
      kid,
      alg: SOFTWARE_STATEMENT_ALGORITHM,
      use: "sig",
    },
    privateJwkEncrypted: await encryptSecret(
      JSON.stringify({
        ...privateJwk,
        kid,
        alg: SOFTWARE_STATEMENT_ALGORITHM,
      }),
      masterKey,
    ),
  };
}

/**
 * Recovers the private half of a stored key.
 *
 * The algorithm comes from this module rather than from the sealed JWK's own `alg`, so a
 * rewritten envelope cannot talk Muster into signing with something weaker.
 *
 * @param row - The stored key.
 * @param masterKey - `MUSTER_MASTER_KEY`.
 * @returns The private key.
 * @throws {EnvelopeError} When the envelope fails authentication - the wrong master key, or
 *   a ciphertext somebody altered.
 * @throws {TypeError} When the sealed JWK is not an asymmetric key.
 */
export async function importSigningKey(
  row: SigningKeyRow,
  masterKey: string,
): Promise<CryptoKey> {
  const jwk = JSON.parse(
    await decryptSecret(row.privateJwkEncrypted, masterKey),
  ) as JWK;
  const key = await importJWK(jwk, SOFTWARE_STATEMENT_ALGORITHM);
  if (!(key instanceof CryptoKey)) {
    throw new TypeError(`signing key ${row.kid} is not an asymmetric key`);
  }
  return key;
}

/**
 * The active key of a purpose, installing one if there is none.
 *
 * Idempotent and safe to race: the database decides which of two simultaneous installs
 * wins, and the loser is handed the winner's key.
 *
 * @param db - The database.
 * @param masterKey - `MUSTER_MASTER_KEY`.
 * @param purpose - Statements or tickets.
 * @param now - The current time.
 * @returns The active key.
 * @example
 * ```ts
 * const key = await ensureActiveSigningKey(db, config.masterKey, "statements", now);
 * ```
 */
export async function ensureActiveSigningKey(
  db: Database,
  masterKey: string,
  purpose: SigningKeyPurpose,
  now: Date,
): Promise<SigningKeyRow> {
  const existing = await findActiveSigningKey(db, purpose);
  if (existing !== undefined) {
    return existing;
  }
  const generated = await generateSigningKey(masterKey);
  const installed = await installActiveSigningKey(db, {
    ...generated,
    purpose,
    now,
  });
  return installed.key;
}

/**
 * Installs an active key for every purpose. Called once at startup.
 *
 * @param db - The database.
 * @param masterKey - `MUSTER_MASTER_KEY`.
 * @param now - The current time.
 * @returns The active key of each purpose.
 * @example
 * ```ts
 * await ensureSigningKeys(handle.db, config.masterKey, new Date());
 * ```
 */
export async function ensureSigningKeys(
  db: Database,
  masterKey: string,
  now: Date,
): Promise<readonly SigningKeyRow[]> {
  const keys: SigningKeyRow[] = [];
  for (const purpose of SIGNING_KEY_PURPOSES) {
    // Sequential rather than concurrent: two inserts against one partial unique index is
    // the case the repository handles, not a case worth provoking at startup.
    keys.push(await ensureActiveSigningKey(db, masterKey, purpose, now));
  }
  return keys;
}

/**
 * The key that signs now, decrypted.
 *
 * @param db - The database.
 * @param masterKey - `MUSTER_MASTER_KEY`.
 * @param purpose - Statements or tickets.
 * @param now - The current time.
 * @returns The identifier and the private key.
 * @throws {EnvelopeError} When the stored key cannot be opened.
 * @example
 * ```ts
 * const signing = await loadSigningKey(db, config.masterKey, "statements", now);
 * const jws = await signClaims(claims, signing);
 * ```
 */
export async function loadSigningKey(
  db: Database,
  masterKey: string,
  purpose: SigningKeyPurpose,
  now: Date,
): Promise<LoadedSigningKey> {
  const row = await ensureActiveSigningKey(db, masterKey, purpose, now);
  return { kid: row.kid, key: await importSigningKey(row, masterKey) };
}

/**
 * Supersedes the active key of a purpose and installs a replacement (FR-024).
 *
 * What it deliberately does not do is withdraw the old key from the JWKS. That happens on
 * its own, when nothing it signed is unexpired any more (principle VI).
 *
 * @param db - The database.
 * @param masterKey - `MUSTER_MASTER_KEY`.
 * @param purpose - Statements or tickets.
 * @param now - The current time.
 * @returns The new active key.
 * @example
 * ```ts
 * await rotateSigningKeyFor(db, config.masterKey, "statements", new Date());
 * ```
 */
export async function rotateSigningKeyFor(
  db: Database,
  masterKey: string,
  purpose: SigningKeyPurpose,
  now: Date,
): Promise<SigningKeyRow> {
  const generated = await generateSigningKey(masterKey);
  return await rotateSigningKey(db, { ...generated, purpose, now });
}

/**
 * Signs a claim set, naming the key in the protected header.
 *
 * `typ: "JWT"` because a software statement is a JWT (RFC 7591 §2.3) and several JOSE
 * stacks refuse a `typ` they do not recognise. The claims are signed exactly as given: no
 * `iat` or `exp` is added here, because deciding those is `@muster/core`'s and adding one
 * silently would put a second opinion about validity into the artefact.
 *
 * @param claims - The claim set, already complete.
 * @param signingKey - The loaded key.
 * @returns The compact JWS.
 * @example
 * ```ts
 * const jws = await signClaims(claims, signing);
 * ```
 */
export async function signClaims(
  claims: Readonly<Record<string, unknown>>,
  signingKey: LoadedSigningKey,
): Promise<string> {
  return await new SignJWT(claims)
    .setProtectedHeader({
      alg: SOFTWARE_STATEMENT_ALGORITHM,
      kid: signingKey.kid,
      typ: "JWT",
    })
    .sign(signingKey.key);
}

/**
 * The JWKS document (FR-024, scenario 5).
 *
 * The stored public JWKs, served verbatim: what a vendor verifies against is byte-for-byte
 * what was recorded when the key was made, with no assembly step in between that could
 * drop a `kid`.
 *
 * @param db - The database.
 * @param now - The current time, which decides which superseded keys are still needed.
 * @returns The document.
 * @example
 * ```ts
 * return c.json(await publishedJwks(context.db, context.clock()));
 * ```
 */
export async function publishedJwks(
  db: Database,
  now: Date,
): Promise<PublishedJwks> {
  const rows = await listPublishedSigningKeys(db, now);
  return { keys: rows.map((row) => row.publicJwk as JWK) };
}
