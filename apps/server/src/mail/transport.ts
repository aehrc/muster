/**
 * Sending mail, or logging it when there is nowhere to send it.
 *
 * Email is Muster's only notification channel: approval and revocation, the
 * awaiting-approval notice to admins (FR-003), verification links, and every pairing
 * transition (FR-014). Two transports serve it. SMTP, configured entirely by
 * `MUSTER_SMTP_URL`, works with a CSIRO relay, an SES SMTP endpoint or anything else,
 * so the venue decision stays open. The console transport - selected by leaving that
 * variable unset - logs the rendered message instead, which is how a developer and the
 * compose stack read a verification link (quickstart scenario 1).
 *
 * They are two transports rather than one with a flag because the difference is
 * whether the message body reaches the deployment's logs. A verification link is a
 * credential; printing one in development is the point, and printing one in production
 * would be a finding.
 *
 * Author: John Grimes
 */

import { createTransport } from "nodemailer";

/** A message to send. */
export interface MailMessage {
  readonly to: string;
  readonly subject: string;
  /** Plain text. Muster sends no HTML: every message it sends is a few lines. */
  readonly text: string;
}

/** Somewhere to send mail. */
export interface MailTransport {
  /**
   * Sends a message.
   *
   * @throws {Error} When the relay refuses it. The caller decides whether that fails
   *   the operation it was notifying about.
   */
  readonly send: (message: MailMessage) => Promise<void>;
}

/**
 * The one call this module makes into an SMTP library.
 *
 * Declared as the narrow shape used rather than as nodemailer's own types, so a test
 * can substitute a recorder without constructing a transporter.
 */
export type SmtpTransportFactory = (url: string) => {
  sendMail: (options: Record<string, unknown>) => Promise<unknown>;
};

/** How to send. */
export interface MailTransportOptions {
  /** The relay. Absent selects the console transport. */
  readonly smtpUrl?: string | undefined;
  /** The `From` address on every message. */
  readonly from: string;
  /** Where the console transport writes. Injected for the tests. */
  readonly log?: (line: string) => void;
  /** The SMTP library. Defaults to nodemailer. */
  readonly createSmtpTransport?: SmtpTransportFactory;
}

/**
 * Renders a message as it appears in a log.
 *
 * @param from - The `From` address.
 * @param message - The message.
 * @returns The envelope, a blank line, then the body - so a link sits on its own line
 *   and can be clicked out of a terminal.
 * @example
 * ```ts
 * console.log(renderMessage(config.mailFrom, { to, subject, text }));
 * ```
 */
export function renderMessage(from: string, message: MailMessage): string {
  return [
    `From: ${from}`,
    `To: ${message.to}`,
    `Subject: ${message.subject}`,
    "",
    message.text,
  ].join("\n");
}

/**
 * How the configured transport should be described in a startup log.
 *
 * Names the relay and never the credential: the SMTP URL carries a password, and a
 * line reporting what mail is configured must not be the place it leaks (FR-036).
 *
 * @param smtpUrl - The configured relay, or undefined for the console transport.
 * @returns A one-line description safe to log.
 */
export function describeMailTransport(smtpUrl: string | undefined): string {
  if (smtpUrl === undefined) {
    return "console (messages are logged, not sent)";
  }
  try {
    const url = new URL(smtpUrl);
    return `smtp ${url.host}`;
  } catch {
    // The value is not quoted: it was meant to be a URL, and an unparseable one may
    // still contain the password that made it unparseable.
    return "smtp (the configured MUSTER_SMTP_URL could not be parsed)";
  }
}

/**
 * Builds the transport the configuration selects.
 *
 * The SMTP transport is constructed once, because a transporter pools connections and
 * rebuilding it per notification would open a connection per email.
 *
 * @param options - The relay, the from-address, and the injection points the tests
 *   use.
 * @returns A transport whose `send` either delivers the message or logs it.
 * @example
 * ```ts
 * const mail = createMailTransport({
 *   smtpUrl: config.smtpUrl,
 *   from: config.mailFrom,
 * });
 * await mail.send({ to, subject: "You have been approved", text });
 * ```
 */
export function createMailTransport(
  options: MailTransportOptions,
): MailTransport {
  const write = options.log ?? console.log;

  if (options.smtpUrl === undefined) {
    return {
      send: async (message) => {
        // Deliberately not silent. A workflow that waits on an email nobody can see is
        // a dead end, so the whole message goes to the log.
        write(renderMessage(options.from, message));
        await Promise.resolve();
      },
    };
  }

  const factory = options.createSmtpTransport ?? createTransport;
  const transporter = factory(options.smtpUrl);

  return {
    send: async (message) => {
      await transporter.sendMail({
        from: options.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
      });
    },
  };
}
