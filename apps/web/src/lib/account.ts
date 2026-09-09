/*
 * Copyright © 2026 Commonwealth Scientific and Industrial Research Organisation
 * (CSIRO) ABN 41 687 119 230. Licensed under the Apache License, Version 2.0.
 */

import {
  authoriseAdmin,
  authoriseMembership,
  authoriseWrite,
} from "@muster/core";

import type { AccountView, SessionView } from "@muster/contracts";
import type { AccountFacts, RefusalReason } from "@muster/core";

/**
 * Where the signed-in account stands, and what the console lets it try.
 *
 * The rules are not restated here: `@muster/core` is pure and I/O-free, so the
 * console asks the same functions the server asks, and the two cannot disagree
 * about whether a pending account may create an organisation. What this module
 * adds is the heading a person reads - the refusal wording from the rules is
 * already fit to show, and it is used verbatim as the detail.
 *
 * The console never relies on this for security. The server refuses regardless;
 * this is so a member is told which condition they fail before they fill in a
 * form that cannot be submitted.
 *
 * @author John Grimes
 */

/** How the console describes an account's standing. */
export type AccountStanding = {
  /** whether the account may create or edit content */
  readonly canWrite: boolean;
  /** whether the account may act as a track admin */
  readonly canAdminister: boolean;
  /** how to colour the notice */
  readonly tone: "info" | "warning" | "error" | "success";
  /** the short statement of where the account stands */
  readonly headline: string;
  /** what to do about it */
  readonly detail: string;
};

/**
 * A stand-in for the instant an address was verified.
 *
 * The wire shape carries whether the address is verified, not when: the rules
 * only ask whether the instant is present, so any instant answers the question
 * the console is asking.
 */
const verifiedAt = new Date(0);

/** The heading shown for each way the write rules can refuse. */
const headlineForRefusal: Record<RefusalReason, string> = {
  not_approved: "Awaiting approval",
  revoked: "Membership revoked",
  not_verified: "Address not verified",
  not_admin: "Not a track admin",
  not_member: "Not a member",
  event_not_open: "Event not open",
  illegal_transition: "Already done",
  token_used: "Link already used",
  token_expired: "Link expired",
  already_verified: "Address already verified",
  wrong_side: "Not your side of the pairing",
  not_in_event: "Not enrolled in this event",
  registration_not_needed: "No registration needed",
  duplicate_pairing: "Already requested",
  manual_registration: "Registered by hand",
  trusted_registration: "Registered by Muster",
  invalid_metadata: "Details cannot be vouched for",
  vouching_expired: "Vouching window has passed",
  no_ihi: "No IHI on the source record",
  not_a_patient: "Not a patient record",
  duplicate_persona: "Already a persona",
  insecure_endpoint: "Endpoint is not https",
};

/**
 * How each refusal should be coloured: revocation is final, the rest are not.
 *
 * @param reason - why the rules refused
 * @returns the tone to render the notice in
 */
const toneForRefusal = (reason: RefusalReason): AccountStanding["tone"] =>
  reason === "revoked" ? "error" : "warning";

/**
 * Reads what the rules need to know about an account.
 *
 * @param account - the account as the console received it
 * @returns the facts the rules decide on
 */
const factsFor = (account: AccountView): AccountFacts => ({
  status: account.status,
  emailVerifiedAt: account.emailVerified ? verifiedAt : null,
  isAdmin: account.isAdmin,
});

/**
 * Reads an account's standing.
 *
 * @param session - the signed-in session, or null when anonymous
 * @returns the standing: what the account may do, and what to tell it
 * @example
 * ```ts
 * const standing = standingFor(session);
 * if (!standing.canWrite) {
 *   return <AccountStateNotice standing={standing} />;
 * }
 * ```
 */
export const standingFor = (session: SessionView | null): AccountStanding => {
  if (session === null) {
    return {
      canWrite: false,
      canAdminister: false,
      tone: "info",
      headline: "Not signed in",
      detail:
        "The directory is readable without an account. Sign in to see contact details and to manage your organisation's systems.",
    };
  }

  const facts = factsFor(session.account);
  const write = authoriseWrite(facts);
  if (!write.ok) {
    return {
      canWrite: false,
      canAdminister: false,
      tone: toneForRefusal(write.refusal.reason),
      headline: headlineForRefusal[write.refusal.reason],
      detail: write.refusal.detail,
    };
  }

  const administers = authoriseAdmin(facts).ok;
  return {
    canWrite: true,
    canAdminister: administers,
    tone: "success",
    headline: administers ? "Approved track admin" : "Approved member",
    detail: administers
      ? "You can manage events and approve accounts, as well as your own organisations."
      : "Your membership is standing: it persists across events. You can create organisations, describe systems and enrol them.",
  };
};

/**
 * Decides whether the account may act for an organisation.
 *
 * @param session - the signed-in session, or null when anonymous
 * @param organisationId - the organisation being acted for
 * @returns true when the account is an approved member of it
 * @example
 * ```ts
 * const editable = mayActFor(session, system.organisationId);
 * ```
 */
export const mayActFor = (
  session: SessionView | null,
  organisationId: string,
): boolean =>
  session !== null &&
  authoriseMembership(
    factsFor(session.account),
    session.memberships.map((membership) => membership.organisationId),
    organisationId,
  ).ok;
