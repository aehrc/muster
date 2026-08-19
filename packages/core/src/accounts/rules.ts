import type { AccountStatus, EventStatus } from "@muster/contracts";

/**
 * Account rules.
 *
 * These decide who may change anything in Muster, and they decide it without a
 * database, a clock or a request: the facts arrive as arguments. Deny by
 * default is the whole point - a right is granted only when every condition is
 * affirmatively true, so a route handler cannot grant one by forgetting to ask.
 *
 * Each refusal carries wording fit to show the person refused, because an
 * account that cannot act needs to know which of the several possible reasons
 * applies to it.
 *
 * @author John Grimes
 */

/** What the rules need to know about an account. */
export type AccountFacts = {
  /** the account's lifecycle status */
  readonly status: AccountStatus;
  /** when the address was verified, null when it has not been */
  readonly emailVerifiedAt: Date | null;
  /** whether the account holds the track admin role */
  readonly isAdmin: boolean;
};

/** What the rules need to know about a single-use token. */
export type TokenFacts = {
  /** when the token stops being usable */
  readonly expiresAt: Date;
  /** when the token was spent, null while unused */
  readonly usedAt: Date | null;
};

/** Why a decision refused. */
export type RefusalReason =
  | "not_approved"
  | "revoked"
  | "not_verified"
  | "not_admin"
  | "not_member"
  | "event_not_open"
  | "illegal_transition"
  | "token_used"
  | "token_expired"
  | "wrong_side"
  | "not_in_event"
  | "registration_not_needed"
  | "duplicate_pairing"
  | "invalid_metadata"
  | "vouching_expired";

/** A refusal, with wording fit to show the person refused. */
export type Refusal = {
  /** why the decision refused */
  readonly reason: RefusalReason;
  /** what to tell the caller */
  readonly detail: string;
};

/** An action refused, with the reason to report. */
export type RefusedDecision = {
  /** the decision refused */
  readonly ok: false;
  /** why, in words fit to show the person refused */
  readonly refusal: Refusal;
};

/** Whether an action is permitted. */
export type AuthorisationDecision = { readonly ok: true } | RefusedDecision;

/** What an admin may do to an account's status. */
export type StatusAction = "approve" | "revoke";

/** The outcome of a status change. */
export type StatusChangeResult =
  | { readonly ok: true; readonly status: AccountStatus }
  | { readonly ok: false; readonly refusal: Refusal };

/** One day, in milliseconds. */
const oneDayMs = 24 * 60 * 60 * 1000;

/**
 * How long a verification token lives.
 *
 * A rule rather than a deployment knob: a day is long enough to find the
 * message in a mail client and short enough that a leaked link is not a
 * standing key to the account.
 */
export const verificationTokenLifetimeMs = oneDayMs;

/** The one decision shared by every granted right. */
export const granted: AuthorisationDecision = { ok: true };

/**
 * Builds a refusal.
 *
 * Shared with the other rule modules in this package, so every refusal in Muster
 * has the same shape and carries wording fit to show the person refused.
 *
 * @param reason - why the decision refused
 * @param detail - what to tell the caller
 * @returns the refusing decision
 * @example
 * ```ts
 * return refuse("wrong_side", "Only the server's organisation can do that.");
 * ```
 */
export const refuse = (
  reason: RefusalReason,
  detail: string,
): RefusedDecision => ({
  ok: false,
  refusal: { reason, detail },
});

/**
 * Decides whether an account may create or edit content.
 *
 * Approval and a verified address are both required, and revocation takes the
 * right away again: this is the check every mutation in Muster passes through
 * (FR-001, FR-002).
 *
 * @param account - the account's status, verification and role
 * @returns the decision, refusing with the first condition that failed
 * @example
 * ```ts
 * const decision = authoriseWrite(account);
 * if (!decision.ok) {
 *   throw new HTTPException(403, { message: decision.refusal.detail });
 * }
 * ```
 */
export const authoriseWrite = (
  account: AccountFacts,
): AuthorisationDecision => {
  if (account.status === "revoked") {
    return refuse(
      "revoked",
      "This membership has been revoked, so it can no longer create or edit content.",
    );
  }
  if (account.status === "pending") {
    return refuse(
      "not_approved",
      "This account is awaiting approval by a track admin before it can create or edit content.",
    );
  }
  if (account.emailVerifiedAt === null) {
    return refuse(
      "not_verified",
      "This email address has not been verified yet; use the verification link that was sent to it.",
    );
  }
  return granted;
};

/**
 * Decides whether an account may act as a track admin.
 *
 * The admin role is distinct from ordinary membership (FR-004) and does not
 * substitute for approval or verification, so the write rights are checked
 * first.
 *
 * @param account - the account's status, verification and role
 * @returns the decision
 * @example
 * ```ts
 * if (!authoriseAdmin(account).ok) {
 *   throw new HTTPException(403, { message: "Admins only" });
 * }
 * ```
 */
export const authoriseAdmin = (
  account: AccountFacts,
): AuthorisationDecision => {
  const write = authoriseWrite(account);
  if (!write.ok) {
    return write;
  }
  return account.isAdmin
    ? granted
    : refuse("not_admin", "This action is for track admins only.");
};

/**
 * Decides whether an account may act for an organisation.
 *
 * Every member of an organisation manages its systems, answers its pairings
 * and sees the contact details addressed to it (FR-005), and no one else does.
 *
 * @param account - the account's status, verification and role
 * @param organisationIds - the organisations the account belongs to
 * @param organisationId - the organisation being acted for
 * @returns the decision
 * @example
 * ```ts
 * const decision = authoriseMembership(account, memberships, system.organisationId);
 * ```
 */
export const authoriseMembership = (
  account: AccountFacts,
  organisationIds: readonly string[],
  organisationId: string,
): AuthorisationDecision => {
  const write = authoriseWrite(account);
  if (!write.ok) {
    return write;
  }
  return organisationIds.includes(organisationId)
    ? granted
    : refuse(
        "not_member",
        "This action is for members of the owning organisation.",
      );
};

/**
 * Decides whether an event accepts new records.
 *
 * A closed event keeps its records readable and takes nothing new (FR-011); a
 * draft event is not open yet, and an event that is not affirmatively open is a
 * refusal rather than a default.
 *
 * @param status - the event's lifecycle status
 * @returns the decision
 * @example
 * ```ts
 * if (!authoriseEventOpen(event.status).ok) {
 *   throw new HTTPException(409, { message: "That event is not open" });
 * }
 * ```
 */
export const authoriseEventOpen = (
  status: EventStatus,
): AuthorisationDecision =>
  status === "open"
    ? granted
    : refuse(
        "event_not_open",
        status === "closed"
          ? "That event is closed, so nothing new can be recorded against it."
          : "That event is still a draft, so nothing can be recorded against it yet.",
      );

/**
 * Decides whether a single-use token may be spent.
 *
 * A verification link used twice, or used after its expiry, fails - the two
 * edge cases the specification calls out. A used token is reported as used even
 * when it has also expired, because that is the more informative answer.
 *
 * @param token - the token's expiry and whether it was spent
 * @param now - the current instant
 * @returns the decision
 * @example
 * ```ts
 * const decision = authoriseToken({ expiresAt, usedAt }, new Date());
 * ```
 */
export const authoriseToken = (
  token: TokenFacts,
  now: Date,
): AuthorisationDecision => {
  if (token.usedAt !== null) {
    return refuse(
      "token_used",
      "That link has already been used; ask for a new one.",
    );
  }
  // The boundary belongs to the holder: a token expiring exactly now is spent.
  if (token.expiresAt.getTime() <= now.getTime()) {
    return refuse("token_expired", "That link has expired; ask for a new one.");
  }
  return granted;
};

/**
 * Applies an admin's status change to an account.
 *
 * The three transitions the data model states, and nothing else: approval,
 * revocation, and re-instatement. Approving an already approved account is
 * refused rather than treated as a no-op, so no one is sent a second approval
 * email and no admin is left wondering whether the click registered.
 *
 * @param status - the account's current status
 * @param action - the change the admin asked for
 * @returns the new status, or the refusal
 * @example
 * ```ts
 * const result = applyStatusChange(account.status, "approve");
 * if (result.ok) {
 *   await setAccountStatus(sql, { accountId, status: result.status });
 * }
 * ```
 */
export const applyStatusChange = (
  status: AccountStatus,
  action: StatusAction,
): StatusChangeResult => {
  if (action === "approve") {
    return status === "approved"
      ? {
          ok: false,
          refusal: {
            reason: "illegal_transition",
            detail: "That account is already approved.",
          },
        }
      : { ok: true, status: "approved" };
  }
  return status === "approved"
    ? { ok: true, status: "revoked" }
    : {
        ok: false,
        refusal: {
          reason: "illegal_transition",
          detail:
            status === "pending"
              ? "That account is not approved, so there is nothing to revoke."
              : "That account is already revoked.",
        },
      };
};
