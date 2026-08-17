import { publicUrlFor } from "../config.ts";

import type { MusterConfig } from "../config.ts";
import type { MailMessage } from "./transport.ts";

/**
 * The messages Muster sends.
 *
 * They are built here, away from the routes, because every one of them is a
 * pure function of the configuration and the account: the same inputs always
 * render the same message, which is what lets the suites assert on the exact
 * text a participant would receive.
 *
 * Every link derives from `MUSTER_PUBLIC_URL`; nothing hardcodes a host. No
 * message ever carries a password.
 *
 * @author John Grimes
 */

/** Who an admin notification is about. */
type AccountIdentity = {
  /** the name shown to other members */
  readonly displayName: string;
  /** the address */
  readonly email: string;
};

/**
 * The message that proves control of an address.
 *
 * @param config - the configuration the public URL derives from
 * @param recipient - the address being proved
 * @param token - the single-use verification token
 * @returns the message to send
 * @example
 * ```ts
 * await mail.send(verificationMessage(config, account.email, token));
 * ```
 */
export const verificationMessage = (
  config: MusterConfig,
  recipient: string,
  token: string,
): MailMessage => ({
  to: [recipient],
  subject: "Verify your Muster address",
  text: [
    "Someone signed up to Muster, the connectathon participant directory, with this address.",
    "",
    `Confirm it by opening ${publicUrlFor(config, `/verify?token=${token}`)}`,
    "",
    "The link works once and expires within a day. If this was not you, ignore this message.",
  ].join("\n"),
});

/**
 * The message telling the admins that someone is waiting (FR-003).
 *
 * @param config - the configuration the public URL derives from
 * @param recipients - the admins to tell
 * @param account - the name and address of the account waiting
 * @returns the message to send
 */
export const awaitingApprovalMessage = (
  config: MusterConfig,
  recipients: readonly string[],
  account: AccountIdentity,
): MailMessage => ({
  to: recipients,
  subject: "A Muster account is awaiting approval",
  text: [
    `${account.displayName} (${account.email}) has signed up and is awaiting approval.`,
    "",
    `Review the queue at ${publicUrlFor(config, "/admin/members")}`,
  ].join("\n"),
});

/**
 * The message telling a member they have been approved (FR-003).
 *
 * @param config - the configuration the public URL derives from
 * @param recipient - the member's address
 * @returns the message to send
 */
export const approvalMessage = (
  config: MusterConfig,
  recipient: string,
): MailMessage => ({
  to: [recipient],
  subject: "Your Muster membership is approved",
  text: [
    "A track admin has approved your Muster membership. It persists across events.",
    "",
    `Create your organisation and enrol your systems at ${publicUrlFor(config, "/")}`,
  ].join("\n"),
});

/**
 * The message telling a member their membership has been revoked (FR-003).
 *
 * @param config - the configuration the public URL derives from
 * @param recipient - the member's address
 * @returns the message to send
 */
export const revocationMessage = (
  config: MusterConfig,
  recipient: string,
): MailMessage => ({
  to: [recipient],
  subject: "Your Muster membership has been revoked",
  text: [
    "A track admin has revoked your Muster membership. You can still read the directory,",
    "but you can no longer create or edit content, and Muster will not vouch for your clients.",
    "",
    `Ask the track organisers if you think this is a mistake: ${publicUrlFor(config, "/")}`,
  ].join("\n"),
});

/**
 * The message telling an organisation it has a new member.
 *
 * @param config - the configuration the public URL derives from
 * @param recipient - the invited member's address
 * @param organisationName - the organisation they now belong to
 * @returns the message to send
 */
export const invitationMessage = (
  config: MusterConfig,
  recipient: string,
  organisationName: string,
): MailMessage => ({
  to: [recipient],
  subject: `You have been added to ${organisationName} in Muster`,
  text: [
    `You are now a member of ${organisationName} and can manage its systems and pairings.`,
    "",
    `Open it at ${publicUrlFor(config, "/my-organisation")}`,
  ].join("\n"),
});
