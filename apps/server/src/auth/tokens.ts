/**
 * Opaque tokens, and the digests they are stored under.
 *
 * Two things in Muster are bearer credentials a person or a browser presents: a session
 * cookie and a verification link. Both are random, both are stored as digests, and both are
 * therefore built here rather than twice.
 *
 * SHA-256 rather than argon2id for the digest, deliberately. A password is a low-entropy
 * secret a person chose, so hashing it has to be slow enough to make guessing expensive; one
 * of these is 256 bits from a CSPRNG, so there is nothing to guess, and the digest is
 * computed on every authenticated request. Making that slow would buy a denial-of-service
 * surface and no security.
 *
 * Author: John Grimes
 */

import { createHash, randomBytes } from "node:crypto";

/** How many bytes of randomness a token carries. */
const TOKEN_BYTES = 32;

/**
 * Mints an opaque token.
 *
 * @returns 256 bits from the system CSPRNG, base64url encoded so it is safe in a cookie and
 *   in a URL.
 * @example
 * ```ts
 * const token = generateOpaqueToken();
 * await insertAccountToken(db, { tokenHash: hashToken(token), ... });
 * ```
 */
export function generateOpaqueToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

/**
 * The digest a token is stored and looked up under.
 *
 * @param token - The token as it was handed out.
 * @returns Its SHA-256, hex encoded.
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
