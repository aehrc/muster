/*
 * Copyright © 2026 Commonwealth Scientific and Industrial Research Organisation
 * (CSIRO) ABN 41 687 119 230. Licensed under the Apache License, Version 2.0.
 */

import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";

/**
 * Encryption at rest for the one secret Muster has to be able to read back.
 *
 * Signing keys are the exception to "store a hash, never the secret": Muster has
 * to sign with them, so it has to be able to read them. They are therefore held
 * as ciphertext under `MUSTER_MASTER_KEY`, and a leaked database on its own
 * yields nothing signable.
 *
 * Every ciphertext carries a version tag, which is what makes the scheme
 * replaceable: a future scheme writes `v2`, keeps reading `v1`, and re-encrypts
 * as it goes. A tag neither scheme knows is refused rather than guessed at -
 * deny by default applies to encoding as much as to authorisation, because
 * guessing at a key's encoding is how a key gets destroyed.
 *
 * AES-256-GCM with a fresh 96-bit nonce for every encryption, and the cipher key
 * derived from the master key with HKDF so that the master key's own length and
 * encoding do not have to be a cipher key's. GCM authenticates: a tampered
 * ciphertext fails rather than decrypting to something else.
 *
 * @author John Grimes
 */

/** The version tag written on new ciphertext. */
export const currentCiphertextVersion = "v1";

/** Bytes in the derived cipher key: AES-256. */
const cipherKeyLength = 32;

/** Bytes in a GCM nonce, as the mode specifies. */
const nonceLength = 12;

/** Bytes in a GCM authentication tag. */
const tagLength = 16;

/**
 * The salt and label the cipher key is derived with.
 *
 * Fixed rather than random: the derivation has to be repeatable from the master
 * key alone, and its purpose is to turn an arbitrary passphrase into a uniform
 * 256-bit key, not to slow down guessing at a high-entropy secret. The label
 * carries the version, so a later scheme derives a different key even from the
 * same master key.
 */
const derivationSalt = "muster";

/** What the derived key is for; part of the HKDF info string. */
const derivationInfo = `signing key encryption ${currentCiphertextVersion}`;

/**
 * Derives the cipher key from the deployment's master key.
 *
 * @param masterKey - the deployment's master key
 * @returns the 256-bit cipher key
 */
const cipherKey = (masterKey: string): Buffer =>
  Buffer.from(
    hkdfSync(
      "sha256",
      masterKey,
      derivationSalt,
      derivationInfo,
      cipherKeyLength,
    ),
  );

/**
 * Reads the version tag off a ciphertext.
 *
 * @param ciphertext - the stored ciphertext
 * @returns the version tag, or undefined when the value is not tagged at all
 * @example
 * ```ts
 * ciphertextVersion(row.privateJwk); // "v1"
 * ```
 */
export const ciphertextVersion = (ciphertext: string): string | undefined => {
  const parts = ciphertext.split(".");
  return parts.length === 3 && parts[0] !== undefined && parts[0] !== ""
    ? parts[0]
    : undefined;
};

/**
 * Encrypts a secret under the master key.
 *
 * @param masterKey - the deployment's master key
 * @param plaintext - the secret to store
 * @returns the tagged ciphertext to store
 * @example
 * ```ts
 * const stored = encryptUnderMasterKey(config.masterKey, JSON.stringify(jwk));
 * ```
 */
export const encryptUnderMasterKey = (
  masterKey: string,
  plaintext: string,
): string => {
  const nonce = randomBytes(nonceLength);
  const cipher = createCipheriv("aes-256-gcm", cipherKey(masterKey), nonce);
  const body = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return [
    currentCiphertextVersion,
    nonce.toString("base64url"),
    body.toString("base64url"),
  ].join(".");
};

/**
 * Decrypts a secret stored under the master key.
 *
 * @param masterKey - the deployment's master key
 * @param ciphertext - the tagged ciphertext as stored
 * @returns the secret
 * @throws {Error} when the value is not tagged ciphertext, when its version is
 *   one this scheme does not know, or when the key is wrong or the ciphertext has
 *   been tampered with
 * @example
 * ```ts
 * const jwk = JSON.parse(decryptUnderMasterKey(config.masterKey, row.privateJwk));
 * ```
 */
export const decryptUnderMasterKey = (
  masterKey: string,
  ciphertext: string,
): string => {
  const [version, nonce, body] = ciphertext.split(".");
  if (version === undefined || nonce === undefined || body === undefined) {
    throw new Error(
      "This value is not master-key ciphertext: it carries no version tag.",
    );
  }
  if (version !== currentCiphertextVersion) {
    throw new Error(
      `This ciphertext is tagged ${version}, which this build cannot read.`,
    );
  }
  const bytes = Buffer.from(body, "base64url");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    cipherKey(masterKey),
    Buffer.from(nonce, "base64url"),
  );
  decipher.setAuthTag(bytes.subarray(bytes.length - tagLength));
  return (
    decipher.update(
      bytes.subarray(0, bytes.length - tagLength),
      undefined,
      "utf8",
    ) + decipher.final("utf8")
  );
};
