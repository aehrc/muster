/**
 * Who may change anything, and when a one-shot token is still good.
 *
 * Two decisions live here, both deny-by-default and both consulted from more than one
 * route, which is why they are arithmetic over plain values rather than checks written
 * inline where they happen to be needed.
 *
 * **May this account write?** Only when it has proven control of its address *and* a
 * track admin has approved it *and* nobody has revoked it. Every create, every edit,
 * and later every vouching action asks this one question, so there is one answer and
 * one place a mistake in it would be. The refusal is a reason rather than a boolean
 * because the three cases need different things of the reader: verify your address,
 * wait for an admin, or talk to the organisers.
 *
 * **May this token be redeemed?** Once, before it expires. A verification link is a
 * credential that arrives by email and lives in a mailbox afterwards, so the second
 * use has to fail - and it has to fail distinguishably from an expiry, because the
 * route offers a resend in one case and says "already done" in the other.
 *
 * Pure, per constitution principle II: no clock, no database. The time is passed in.
 *
 * Author: John Grimes
 */

/**
 * An account's standing.
 *
 * The same vocabulary as `accountStatusSchema` in `@muster/contracts`, declared here
 * rather than imported because this package is the domain and may not depend on the
 * package that validates the wire.
 */
export type AccountStatus = "pending" | "approved" | "revoked";

/** What the write rules read off an account. */
export interface AccountStanding {
  readonly status: AccountStatus;
  /** Null until the holder has followed a verification link. */
  readonly emailVerifiedAt: Date | null;
}

/**
 * Why an account may not create or edit content.
 *
 * These are the `error` codes the routes return, so the console can say the right
 * thing without parsing prose.
 */
export type WriteRefusal =
  "email_unverified" | "awaiting_approval" | "revoked_member";

/** A single-use, expiring token, as the token rules read it. */
export interface AccountTokenStanding {
  readonly expiresAt: Date;
  /** Null until the token has been redeemed. Redemption is one-way. */
  readonly usedAt: Date | null;
}

/** Why a token may not be redeemed. */
export type AccountTokenRefusal = "token_used" | "token_expired";

/**
 * How long a verification link lives: 24 hours.
 *
 * The sign-in page tells the reader this number, so the two have to agree - which is
 * why it is a constant here rather than an interval written into the route.
 */
export const VERIFICATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * The transitions an admin may make, as `from -> to`.
 *
 * Exactly the set `data-model.md` names. `pending -> revoked` is deliberately absent:
 * there is no reject action, and a sign-up nobody wants is left pending.
 */
const ALLOWED_STATUS_TRANSITIONS: ReadonlySet<`${AccountStatus}->${AccountStatus}`> =
  new Set([
    "pending->approved",
    "approved->revoked",
    // Re-instatement. Approval is standing, so undoing a revocation restores it rather
    // than starting the account over.
    "revoked->approved",
  ]);

/**
 * Why this account may not write, or `undefined` when it may.
 *
 * The order the cases are tested in is the point. A revoked account is not one
 * verification away from writing, so telling its holder to check their email would
 * send them somewhere useless; and a fresh sign-up is both unverified and unapproved,
 * so it is told about the half it can act on.
 *
 * @param standing - The account's status and whether its address is verified.
 * @returns The refusal code, or `undefined` when the account may create and edit.
 * @example
 * ```ts
 * const refusal = writeRefusal(account);
 * if (refusal !== undefined) {
 *   return jsonError(c, 403, refusal);
 * }
 * ```
 */
export function writeRefusal(
  standing: AccountStanding,
): WriteRefusal | undefined {
  if (standing.status === "revoked") {
    return "revoked_member";
  }
  if (standing.emailVerifiedAt === null) {
    return "email_unverified";
  }
  if (standing.status !== "approved") {
    return "awaiting_approval";
  }
  return undefined;
}

/**
 * Whether this account may create or edit content.
 *
 * @param standing - The account's status and whether its address is verified.
 * @returns `true` when nothing refuses it.
 */
export function canWrite(standing: AccountStanding): boolean {
  return writeRefusal(standing) === undefined;
}

/**
 * Whether an admin may move an account from one status to another.
 *
 * A transition to the status already held is refused rather than treated as a no-op:
 * approving an approved account would overwrite the record of who approved it and when,
 * and send the holder a second notification about something that happened weeks ago.
 *
 * @param from - The status the account holds.
 * @param to - The status the admin asked for.
 * @returns `true` when the transition is one the data model names.
 * @example
 * ```ts
 * canChangeAccountStatus("pending", "approved"); // true
 * canChangeAccountStatus("pending", "revoked"); // false - there is no reject action
 * ```
 */
export function canChangeAccountStatus(
  from: AccountStatus,
  to: AccountStatus,
): boolean {
  return ALLOWED_STATUS_TRANSITIONS.has(`${from}->${to}`);
}

/**
 * Why this token may not be redeemed, or `undefined` when it may.
 *
 * Redemption is reported ahead of expiry: a link that was used and has since expired is
 * a link that already did its job, and saying so is more accurate than offering to
 * resend something the holder does not need.
 *
 * @param token - The token's expiry and whether it has been redeemed.
 * @param now - The current time. Injected: this package may not read the clock.
 * @returns The refusal code, or `undefined` when the token is good.
 * @example
 * ```ts
 * const refusal = accountTokenRefusal(token, clock());
 * if (refusal !== undefined) {
 *   return jsonError(c, 400, refusal, "Request a new verification email.");
 * }
 * ```
 */
export function accountTokenRefusal(
  token: AccountTokenStanding,
  now: Date,
): AccountTokenRefusal | undefined {
  if (token.usedAt !== null) {
    return "token_used";
  }
  // Closed against the holder: a token whose expiry is exactly now has no validity
  // left, and admitting it would make the stated 24 hours an approximation.
  if (now.getTime() >= token.expiresAt.getTime()) {
    return "token_expired";
  }
  return undefined;
}

/**
 * When a verification token issued at a given moment should stop working.
 *
 * @param issuedAt - When the token was minted.
 * @returns The expiry, {@link VERIFICATION_TOKEN_TTL_MS} later.
 */
export function verificationExpiry(issuedAt: Date): Date {
  return new Date(issuedAt.getTime() + VERIFICATION_TOKEN_TTL_MS);
}

/**
 * An email address in the one spelling the directory stores and compares.
 *
 * `account.email` is unique on this folded form, so `Jo.Chen@CSIRO.AU` and
 * `jo.chen@csiro.au` are one account rather than two - and a sign-in typed in a
 * different case still finds it.
 *
 * `toLowerCase` rather than `toLocaleLowerCase`: the folded form is compared inside
 * Postgres as well as here, and a fold that depended on the process's locale would
 * make those two disagree for Turkish dotted capitals.
 *
 * @param email - The address as it was typed.
 * @returns The trimmed, case-folded address.
 * @example
 * ```ts
 * foldEmail("  Jo.Chen@CSIRO.AU "); // "jo.chen@csiro.au"
 * ```
 */
export function foldEmail(email: string): string {
  return email.trim().toLowerCase();
}
