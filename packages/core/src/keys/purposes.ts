/**
 * What a Muster signing key is for.
 *
 * Two purposes, and they are separate keys rather than one key used twice. A software
 * statement tells an authorization server "register this client"; a permission ticket
 * tells a data holder "release this patient's data". A vendor who has configured Muster as
 * a registration trust anchor has agreed to the first and not to the second, and one key
 * for both would make agreeing to either agreeing to both.
 *
 * Declared in the pure package because the database's enum, the JWKS route and the ticket
 * playground all name the same two values, and `packages/db` may not be where a domain
 * vocabulary lives.
 *
 * Author: John Grimes
 */

/** What a signing key signs. */
export type SigningKeyPurpose = "statements" | "tickets";

/** Whether a signing key still signs. */
export type SigningKeyStatus = "active" | "superseded";

/**
 * Both purposes, in the order `data-model.md` names them.
 *
 * Iterated at startup so that every purpose has an active key before anything asks for
 * one - including `tickets`, which nothing mints with until User Story 8 and which is
 * published from the start anyway, so a vendor reading the JWKS sees the whole anchor
 * rather than half of it.
 */
export const SIGNING_KEY_PURPOSES: readonly SigningKeyPurpose[] = [
  "statements",
  "tickets",
];
