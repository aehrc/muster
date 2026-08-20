/*
 * Copyright © 2026 Commonwealth Scientific and Industrial Research Organisation
 * (CSIRO) ABN 41 687 119 230. Licensed under the Apache License, Version 2.0.
 */

import { createTransport } from "nodemailer";

import type { MailDelivery } from "../config.ts";

/**
 * Mail transport.
 *
 * Delivery is decided entirely by configuration: an SMTP URL in a deployment,
 * the console otherwise. The console transport writes the rendered message to
 * the log instead of sending it, which is what makes the compose stack and the
 * quickstart scenarios observable without a mail server - verification and
 * notification links are read out of the log.
 *
 * SMTP arrives through nodemailer, which is pure JavaScript and survives the
 * single-file bundle (`bun run check:bundle`).
 *
 * @author John Grimes
 */

/** A message to send. */
export type MailMessage = {
  /** recipients; at least one */
  readonly to: readonly string[];
  /** subject line */
  readonly subject: string;
  /** plain-text body */
  readonly text: string;
};

/** What a sender must accept; nodemailer's transporter satisfies it. */
export type MailSender = {
  /** hands one message over for delivery */
  readonly sendMail: (message: {
    from: string;
    to: string;
    subject: string;
    text: string;
  }) => Promise<unknown>;
};

/** Builds a sender for an SMTP URL. */
export type SmtpSenderFactory = (url: string) => MailSender;

/** How to build a transport. */
export type MailTransportOptions = {
  /** the From address */
  readonly from: string;
  /** where mail goes, from configuration */
  readonly delivery: MailDelivery;
  /** where the console transport writes; defaults to the log */
  readonly log?: (line: string) => void;
  /** builds the SMTP sender; injected by tests */
  readonly smtpFactory?: SmtpSenderFactory;
};

/** Sends mail. */
export type MailTransport = {
  /** sends one message */
  readonly send: (message: MailMessage) => Promise<void>;
};

/**
 * Renders a message as text.
 *
 * The console transport writes this, so it carries everything a reader needs to
 * act on the message: who it is from, who it is for, the subject and the body.
 *
 * @param message - the message to render
 * @param from - the From address
 * @returns the rendered message
 * @example
 * ```ts
 * renderMessage({ to: ["a@example.org"], subject: "Hi", text: "There" }, "muster@example.org");
 * // From: muster@example.org
 * // To: a@example.org
 * // Subject: Hi
 * //
 * // There
 * ```
 */
export const renderMessage = (message: MailMessage, from: string): string =>
  [
    `From: ${from}`,
    `To: ${message.to.join(", ")}`,
    `Subject: ${message.subject}`,
    "",
    message.text,
  ].join("\n");

/**
 * Builds the configured mail transport.
 *
 * The SMTP sender is built once and reused: nodemailer holds the connection
 * pool, so building one per message would open a connection per notification.
 *
 * @param options - the From address, the delivery from configuration, and the
 *   log and SMTP seams tests inject
 * @returns a transport that sends, or logs, one message at a time
 * @example
 * ```ts
 * const mail = createMailTransport({ from: config.mailFrom, delivery: config.mail });
 * await mail.send({ to: [account.email], subject: "Approved", text: body });
 * ```
 */
export const createMailTransport = (
  options: MailTransportOptions,
): MailTransport => {
  const write =
    options.log ??
    ((line: string) => {
      console.log(line);
    });
  const build = options.smtpFactory ?? createTransport;
  const delivery = options.delivery;

  // Built on first use and kept: one sender for the life of the process.
  let sender: MailSender | undefined;

  return {
    send: async (message) => {
      if (message.to.length === 0) {
        throw new Error("A message needs at least one recipient");
      }
      if (delivery.kind === "console") {
        write(renderMessage(message, options.from));
        return;
      }
      sender ??= build(delivery.url);
      await sender.sendMail({
        from: options.from,
        to: message.to.join(", "),
        subject: message.subject,
        text: message.text,
      });
    },
  };
};
