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

/** What a pairing notification is about. */
export type PairingNotice = {
  /** the pairing, so the message can link to it */
  readonly pairingId: string;
  /** the event it belongs to */
  readonly eventName: string;
  /** the client being registered */
  readonly clientName: string;
  /** the server being registered at */
  readonly serverName: string;
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
 * The message that carries a replacement link, when the first one lapsed.
 *
 * Distinct wording, because the recipient did not just sign up: they asked for
 * this, and the message says that any earlier link no longer works - which is
 * true, since minting this one retired it.
 *
 * @param config - the configuration the public URL derives from
 * @param recipient - the address being proved
 * @param token - the replacement verification token
 * @returns the message to send
 * @example
 * ```ts
 * await mail.send(verificationResendMessage(config, account.email, token));
 * ```
 */
export const verificationResendMessage = (
  config: MusterConfig,
  recipient: string,
  token: string,
): MailMessage => ({
  to: [recipient],
  subject: "Your new Muster verification link",
  text: [
    "A replacement verification link was asked for, for this Muster address.",
    "",
    `Prove the address by opening ${publicUrlFor(config, `/verify?token=${token}`)}`,
    "",
    "Any earlier link has stopped working. This one works once and expires within a day.",
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

/**
 * Where a pairing lives, so every message about it links to the same place.
 *
 * @param config - the configuration the public URL derives from
 * @param notice - the pairing being reported on
 * @returns the pairing's address
 */
const pairingUrl = (config: MusterConfig, notice: PairingNotice): string =>
  publicUrlFor(config, `/pairings/${notice.pairingId}`);

/**
 * The message telling a server's organisation that a client wants registering
 * (FR-012).
 *
 * Everything the server owner needs to decide is in Muster, so the message says
 * what has arrived and where to answer it rather than restating the registration
 * fields: an email that could be answered by replying to it is the round-trip
 * this tracker exists to replace.
 *
 * @param config - the configuration the public URL derives from
 * @param recipients - the server organisation's members
 * @param notice - the pairing being reported on
 * @returns the message to send
 * @example
 * ```ts
 * await mail.send(pairingRequestedMessage(config, emails, notice));
 * ```
 */
export const pairingRequestedMessage = (
  config: MusterConfig,
  recipients: readonly string[],
  notice: PairingNotice,
): MailMessage => ({
  to: [...recipients],
  subject: `${notice.clientName} has asked to register with ${notice.serverName}`,
  text: [
    `${notice.clientName} has requested a pairing with ${notice.serverName} for ${notice.eventName}.`,
    "",
    `The registration details are on the pairing: ${pairingUrl(config, notice)}`,
    "",
    "Record the client identifier you issue, or decline with a reason. Either way",
    "the app's owner is told, and both of you see the same history.",
  ].join("\n"),
});

/**
 * The message telling an app's owner that their client has been registered
 * (FR-014).
 *
 * @param config - the configuration the public URL derives from
 * @param recipients - the client organisation's members
 * @param notice - the pairing being reported on
 * @param clientId - the identifier the server issued
 * @returns the message to send
 */
export const pairingFulfilledMessage = (
  config: MusterConfig,
  recipients: readonly string[],
  notice: PairingNotice,
  clientId: string,
): MailMessage => ({
  to: [...recipients],
  subject: `${notice.serverName} has registered ${notice.clientName}`,
  text: [
    `${notice.serverName} has registered ${notice.clientName} for ${notice.eventName}.`,
    "",
    `The client identifier it issued is ${clientId}`,
    "",
    `The pairing, with its history: ${pairingUrl(config, notice)}`,
  ].join("\n"),
});

/**
 * The message telling an app's owner that their request was declined (FR-014).
 *
 * @param config - the configuration the public URL derives from
 * @param recipients - the client organisation's members
 * @param notice - the pairing being reported on
 * @param reason - why the server's organisation declined
 * @returns the message to send
 */
export const pairingDeclinedMessage = (
  config: MusterConfig,
  recipients: readonly string[],
  notice: PairingNotice,
  reason: string,
): MailMessage => ({
  to: [...recipients],
  subject: `${notice.serverName} declined to register ${notice.clientName}`,
  text: [
    `${notice.serverName} has declined to register ${notice.clientName} for ${notice.eventName}.`,
    "",
    `The reason given: ${reason}`,
    "",
    `The pairing, with its history: ${pairingUrl(config, notice)}`,
  ].join("\n"),
});

/**
 * The message telling a server's organisation that a client registered itself
 * (FR-026).
 *
 * Sent because nobody on the server's side did anything: their entry says the
 * server accepts trusted registration, Muster vouched, and a client now exists
 * that they did not create. An organisation finding that out from its own logs
 * would be a worse directory than one that emails them.
 *
 * @param config - the configuration the public URL derives from
 * @param recipients - the server organisation's members
 * @param notice - the pairing being reported on
 * @param clientId - the identifier the server itself issued
 * @returns the message to send
 * @example
 * ```ts
 * await mail.send(pairingRegisteredMessage(config, emails, notice, clientId));
 * ```
 */
export const pairingRegisteredMessage = (
  config: MusterConfig,
  recipients: readonly string[],
  notice: PairingNotice,
  clientId: string,
): MailMessage => ({
  to: [...recipients],
  subject: `${notice.clientName} has registered itself with ${notice.serverName}`,
  text: [
    `${notice.serverName} accepted Muster's software statement for`,
    `${notice.clientName} and registered it for ${notice.eventName}.`,
    "Nobody in your organisation had to act: your entry says the server accepts",
    "trusted registration.",
    "",
    `The client identifier your server issued: ${clientId}`,
    "",
    `What Muster vouched for, and the history: ${pairingUrl(config, notice)}`,
  ].join("\n"),
});
