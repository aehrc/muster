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

/** The address of one pairing's page. */
export function pairingUrl(publicUrl: string, pairingId: string): string {
  return `${publicUrl}/pairings/${encodeURIComponent(pairingId)}`;
}

/** Which transition a pairing notice is about. */
export type PairingNoticeKind =
  "requested" | "fulfilled" | "declined" | "failed" | "lapsed";

/** What a pairing notice says, beyond who it is about. */
export interface PairingNotice {
  readonly to: string;
  readonly kind: PairingNoticeKind;
  readonly clientName: string;
  readonly serverName: string;
  readonly eventName: string;
  readonly pairingId: string;
  readonly publicUrl: string;
  /** The identifier the server issued, for a fulfilment. */
  readonly clientId?: string | null;
  /** Why it was declined, for a decline. */
  readonly reason?: string | null;
}

/** The subject and the first paragraph, per transition. */
function pairingWords(notice: PairingNotice): {
  readonly subject: string;
  readonly lines: readonly string[];
} {
  const pair = `${notice.clientName} → ${notice.serverName}`;
  switch (notice.kind) {
    case "requested": {
      return {
        subject: `A pairing request for ${notice.serverName}`,
        lines: [
          `${notice.clientName} has asked to be registered with ${notice.serverName}`,
          `for ${notice.eventName}.`,
          "",
          "The request carries everything needed to register it: client name, launch URL,",
          "redirect URIs, scopes, confidentiality and launch context. Record the client",
          "identifier you issue, or decline with a reason.",
        ],
      };
    }
    case "fulfilled": {
      return {
        subject: `${notice.serverName} has registered ${notice.clientName}`,
        lines: [
          `${pair} is fulfilled for ${notice.eventName}.`,
          "",
          `The issued client identifier is ${notice.clientId ?? "not recorded"}.`,
        ],
      };
    }
    case "declined": {
      return {
        subject: `${notice.serverName} declined ${notice.clientName}`,
        lines: [
          `${pair} was declined for ${notice.eventName}.`,
          "",
          `The reason given: ${notice.reason ?? "none given"}`,
        ],
      };
    }
    case "failed": {
      return {
        subject: `Registration failed for ${notice.clientName}`,
        lines: [
          `${pair} could not be registered automatically for ${notice.eventName}.`,
          "",
          "The pairing is recorded as failed. Its owner can fix the metadata and ask again.",
        ],
      };
    }
    default: {
      return {
        subject: `A pairing lapsed when ${notice.eventName} closed`,
        lines: [
          `${pair} was still waiting for an answer when ${notice.eventName} closed,`,
          "so it is now recorded as lapsed.",
          "",
          "Nothing further can be requested against a closed event, and every record of it",
          "stays readable.",
        ],
      };
    }
  }
}

/**
 * What a pairing's counterparty is told about a transition (FR-014).
 *
 * One function for all five, because they differ in their words and in nothing else that
 * matters: each names the two systems, the event, and the address of the pairing's page. Five
 * near-identical functions would drift, and the half that drifted would be the link.
 *
 * @param notice - Who to tell, which transition, and what it changed.
 * @returns The message, ready for the transport.
 * @example
 * ```ts
 * await context.mail.send(pairingMessage({
 *   to: member.email,
 *   kind: "fulfilled",
 *   clientName: row.client.system.name,
 *   serverName: row.server.system.name,
 *   eventName: row.event.name,
 *   pairingId: row.pairing.id,
 *   publicUrl: context.config.publicUrl,
 *   clientId: row.pairing.clientId,
 * }));
 * ```
 */
export function pairingMessage(notice: PairingNotice): MailMessage {
  const words = pairingWords(notice);
  return {
    to: notice.to,
    subject: words.subject,
    text: [
      ...words.lines,
      "",
      `The pairing, with its whole timeline: ${pairingUrl(notice.publicUrl, notice.pairingId)}`,
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
