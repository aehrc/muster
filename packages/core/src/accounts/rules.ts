import type { AccountStatus, EventStatus } from "@muster/contracts";

/**
 * Account rules: stub surface.
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
  | "token_expired";

/** A refusal, with wording fit to show the person refused. */
export type Refusal = {
  /** why the decision refused */
  readonly reason: RefusalReason;
  /** what to tell the caller */
  readonly detail: string;
};

/** Whether an action is permitted. */
export type AuthorisationDecision =
  { readonly ok: true } | { readonly ok: false; readonly refusal: Refusal };

/** What an admin may do to an account's status. */
export type StatusAction = "approve" | "revoke";

/** The outcome of a status change. */
export type StatusChangeResult =
  | { readonly ok: true; readonly status: AccountStatus }
  | { readonly ok: false; readonly refusal: Refusal };

/** How long a verification token lives. */
export const verificationTokenLifetimeMs = 0;

/**
 * Decides whether an account may create or edit content.
 *
 * @param _account - the account's status, verification and role
 * @returns the decision
 */
export const authoriseWrite = (
  _account: AccountFacts,
): AuthorisationDecision => ({
  ok: false,
  refusal: { reason: "not_approved", detail: "not implemented" },
});

/**
 * Decides whether an account may act as a track admin.
 *
 * @param _account - the account's status, verification and role
 * @returns the decision
 */
export const authoriseAdmin = (
  _account: AccountFacts,
): AuthorisationDecision => ({
  ok: false,
  refusal: { reason: "not_admin", detail: "not implemented" },
});

/**
 * Decides whether an account may act for an organisation.
 *
 * @param _account - the account's status, verification and role
 * @param _organisationIds - the organisations the account belongs to
 * @param _organisationId - the organisation being acted for
 * @returns the decision
 */
export const authoriseMembership = (
  _account: AccountFacts,
  _organisationIds: readonly string[],
  _organisationId: string,
): AuthorisationDecision => ({
  ok: false,
  refusal: { reason: "not_member", detail: "not implemented" },
});

/**
 * Decides whether an event accepts new records.
 *
 * @param _status - the event's lifecycle status
 * @returns the decision
 */
export const authoriseEventOpen = (
  _status: EventStatus,
): AuthorisationDecision => ({
  ok: false,
  refusal: { reason: "event_not_open", detail: "not implemented" },
});

/**
 * Decides whether a single-use token may be spent.
 *
 * @param _token - the token's expiry and whether it was spent
 * @param _now - the current instant
 * @returns the decision
 */
export const authoriseToken = (
  _token: TokenFacts,
  _now: Date,
): AuthorisationDecision => ({
  ok: false,
  refusal: { reason: "token_expired", detail: "not implemented" },
});

/**
 * Applies an admin's status change to an account.
 *
 * @param _status - the account's current status
 * @param _action - the change the admin asked for
 * @returns the new status, or the refusal
 */
export const applyStatusChange = (
  _status: AccountStatus,
  _action: StatusAction,
): StatusChangeResult => ({
  ok: false,
  refusal: { reason: "illegal_transition", detail: "not implemented" },
});
