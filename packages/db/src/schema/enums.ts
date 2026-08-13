/**
 * Postgres enum types for the directory's closed value sets.
 *
 * Real database enums rather than check-constrained text, so that adding a value is a
 * visible migration rather than a string that starts appearing in rows. Each of them
 * mirrors a union in `@muster/core` and a Zod enum in `@muster/contracts`; a mismatch
 * between the three would surface as a cast failure inside a route rather than here,
 * which is why `schema.test.ts` compares them.
 *
 * Author: John Grimes
 */

import { pgEnum } from "drizzle-orm/pg-core";

/** An account's standing: pending until an admin approves it, revocable after. */
export const accountStatusEnum = pgEnum("account_status", [
  "pending",
  "approved",
  "revoked",
]);

/** An event's lifecycle. Closing stops enrolment, pairing and minting. */
export const eventStatusEnum = pgEnum("event_status", [
  "draft",
  "open",
  "closed",
]);

/**
 * Where a pairing has got to (FR-013).
 *
 * Exactly the five states `data-model.md` names, in its order. A sixth would be an `ALTER TYPE`
 * on a table the server is reading, which is the visibility a real enum buys.
 */
export const pairingStateEnum = pgEnum("pairing_state", [
  "requested",
  "fulfilled",
  "declined",
  "failed",
  "lapsed",
]);

/**
 * Why a verification check produced no usable result.
 *
 * The absence of a value is the fifth case: a check that succeeded carries no failure mode
 * at all, which `data-model.md` writes as `null`. `timeout` and `refused` are deliberately
 * separate - a slow server and a dead one are different problems for its owner (spec edge
 * case) - and `guarded` means the outbound guard refused the address, so no request was
 * made (FR-020, scenario 5).
 */
export const checkFailureModeEnum = pgEnum("check_failure_mode", [
  "timeout",
  "refused",
  "guarded",
  "invalid",
]);

/**
 * What a signing key signs.
 *
 * Two purposes, sharing the machinery and nothing else: an authorization server told to
 * trust Muster's registration key would otherwise be trusting whatever the ticket
 * playground signs as well. `tickets` is created and published from User Story 5 even
 * though nothing mints with it until User Story 8, because a vendor implementing against
 * the JWKS should not have to wait for a second key to appear.
 */
export const signingKeyPurposeEnum = pgEnum("signing_key_purpose", [
  "statements",
  "tickets",
]);

/**
 * Whether a signing key still signs.
 *
 * There is no `retired`. A superseded key stays published until no unexpired artefact
 * references it (principle VI), and that is a question about artefacts rather than a third
 * state a rotation would have to remember to move it into.
 */
export const signingKeyStatusEnum = pgEnum("signing_key_status", [
  "active",
  "superseded",
]);

/**
 * What a one-shot account token is for.
 *
 * `password_reset` is declared and unused. `data-model.md` names both purposes, and
 * declaring the value now costs nothing, while adding it later is an `ALTER TYPE` on a
 * table the server is reading.
 */
export const accountTokenPurposeEnum = pgEnum("account_token_purpose", [
  "email_verification",
  "password_reset",
]);
