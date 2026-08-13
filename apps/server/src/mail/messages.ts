/**
 * The notifications Muster sends, as text.
 *
 * Separated from the routes that send them so that what a participant reads is reviewable in
 * one place, and so a test can assert the link a message carries without asserting the route
 * that produced it.
 *
 * Every link derives from `MUSTER_PUBLIC_URL`, per the constitution. A verification link
 * built from a request header would be built from something an attacker can set.
 *
 * A verification link is a credential. The console transport prints these to the log
 * deliberately - that is how a developer and the compose stack read one (quickstart scenario
 * 1) - and the SMTP transport does not, which is the whole reason they are two transports
 * rather than one with a flag. See `./transport.ts`.
 *
 * Author: John Grimes
 */

import type { MailMessage } from "./transport.js";

/** The address a verification link points at. */
export function verificationUrl(publicUrl: string, token: string): string {
  return `${publicUrl}/verify?token=${encodeURIComponent(token)}`;
}

/**
 * "Verify your address."
 *
 * @returns The message, ready for the transport.
 * @example
 * ```ts
 * await context.mail.send(verificationMessage({
 *   to: account.email,
 *   displayName: account.displayName,
 *   publicUrl: context.config.publicUrl,
 *   token,
 * }));
 * ```
 */
export function verificationMessage(options: {
  readonly to: string;
  readonly displayName: string;
  readonly publicUrl: string;
  readonly token: string;
}): MailMessage {
  return {
    to: options.to,
    subject: "Verify your Muster account",
    text: [
      `Hello ${options.displayName},`,
      "",
      "Confirm this address to finish creating your Muster account:",
      "",
      verificationUrl(options.publicUrl, options.token),
      "",
      "The link works once and expires after 24 hours. If it has expired, ask for",
      "another from the sign-in page.",
      "",
      "Your account then waits for a track admin to approve it. You will be emailed",
      "when that happens.",
    ].join("\n"),
  };
}

/**
 * "An account is waiting for you."
 *
 * Sent to the admins when an account finishes verifying its address, rather than when it
 * signs up (FR-003). Before verification the address may not belong to the person who typed
 * it, and an approval queue full of unverified sign-ups is one nobody reads.
 */
export function awaitingApprovalMessage(options: {
  readonly to: string;
  readonly displayName: string;
  readonly email: string;
  readonly publicUrl: string;
}): MailMessage {
  return {
    to: options.to,
    subject: "A Muster account is awaiting approval",
    text: [
      `${options.displayName} <${options.email}> has verified their address and is`,
      "waiting for approval.",
      "",
      `Approve or leave them pending: ${options.publicUrl}/admin/members`,
    ].join("\n"),
  };
}

/** "You have been approved." */
export function approvedMessage(options: {
  readonly to: string;
  readonly displayName: string;
  readonly publicUrl: string;
}): MailMessage {
  return {
    to: options.to,
    subject: "Your Muster account has been approved",
    text: [
      `Hello ${options.displayName},`,
      "",
      "A track admin has approved your Muster account. You can now create an",
      "organisation, describe its systems and enrol them in an event.",
      "",
      "Membership is standing: it carries across events, so there is nothing to renew.",
      "",
      options.publicUrl,
    ].join("\n"),
  };
}

/** "Your membership has been revoked." */
export function revokedMessage(options: {
  readonly to: string;
  readonly displayName: string;
  readonly publicUrl: string;
}): MailMessage {
  return {
    to: options.to,
    subject: "Your Muster membership has been revoked",
    text: [
      `Hello ${options.displayName},`,
      "",
      "A track admin has revoked your Muster membership. You can still read the",
      "directory - all of it is public - but you can no longer create or edit",
      "entries, and any pairing you had open is now answered by your organisation's",
      "other members.",
      "",
      "If this is unexpected, reply to the track organisers.",
      "",
      options.publicUrl,
    ].join("\n"),
  };
}
