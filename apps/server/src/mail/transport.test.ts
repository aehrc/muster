/*
 * Copyright © 2026 Commonwealth Scientific and Industrial Research Organisation
 * (CSIRO) ABN 41 687 119 230. Licensed under the Apache License, Version 2.0.
 */

import { describe, expect, test } from "bun:test";

import { createMailTransport, renderMessage } from "./transport.ts";

import type { MailMessage, MailSender } from "./transport.ts";

/**
 * Mail is configured entirely by environment: an SMTP URL in a deployment, the
 * console otherwise. The console transport is what makes the compose stack and
 * the quickstart observable - verification links are read out of the log.
 */

/** A message the notification code would build. */
const message: MailMessage = {
  to: ["member@example.org"],
  subject: "Your Muster account is approved",
  text: "You can now enrol systems at https://muster.example.org.",
};

// Records what was handed to SMTP, and how many senders were built.
const stubSmtp = () => {
  const urls: string[] = [];
  const sent: Parameters<MailSender["sendMail"]>[0][] = [];
  return {
    urls,
    sent,
    factory: (url: string): MailSender => {
      urls.push(url);
      return {
        sendMail: (options) => {
          sent.push(options);
          return Promise.resolve({ messageId: "stub" });
        },
      };
    },
  };
};

describe("renderMessage", () => {
  test("renders the headers a reader needs, then the body", () => {
    const rendered = renderMessage(message, "Muster <muster@example.org>");

    expect(rendered).toContain("From: Muster <muster@example.org>");
    expect(rendered).toContain("To: member@example.org");
    expect(rendered).toContain("Subject: Your Muster account is approved");
    expect(rendered).toContain(
      "You can now enrol systems at https://muster.example.org.",
    );
    // A blank line separates the headers from the body, as in a real message.
    expect(rendered).toMatch(/Subject: [^\n]+\n\n/);
  });

  test("lists every recipient", () => {
    const rendered = renderMessage(
      { ...message, to: ["one@example.org", "two@example.org"] },
      "muster@example.org",
    );

    expect(rendered).toContain("To: one@example.org, two@example.org");
  });
});

describe("createMailTransport", () => {
  test("writes to the log when no SMTP URL is configured", async () => {
    const lines: string[] = [];
    const smtp = stubSmtp();

    const transport = createMailTransport({
      from: "muster@example.org",
      delivery: { kind: "console" },
      log: (line) => lines.push(line),
      smtpFactory: smtp.factory,
    });
    await transport.send(message);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Subject: Your Muster account is approved");
    expect(lines[0]).toContain("member@example.org");
    // Nothing is sent, and no SMTP connection is even built.
    expect(smtp.urls).toEqual([]);
  });

  test("builds an SMTP sender from the configured URL", async () => {
    const smtp = stubSmtp();

    const transport = createMailTransport({
      from: "Muster <muster@example.org>",
      delivery: { kind: "smtp", url: "smtps://user:pass@smtp.example.org:465" },
      smtpFactory: smtp.factory,
    });
    await transport.send(message);

    expect(smtp.urls).toEqual(["smtps://user:pass@smtp.example.org:465"]);
    expect(smtp.sent).toEqual([
      {
        from: "Muster <muster@example.org>",
        to: "member@example.org",
        subject: "Your Muster account is approved",
        text: "You can now enrol systems at https://muster.example.org.",
      },
    ]);
  });

  test("joins multiple recipients into one message", async () => {
    const smtp = stubSmtp();

    const transport = createMailTransport({
      from: "muster@example.org",
      delivery: { kind: "smtp", url: "smtp://smtp.example.org:25" },
      smtpFactory: smtp.factory,
    });
    await transport.send({
      ...message,
      to: ["one@example.org", "two@example.org"],
    });

    expect(smtp.sent[0]?.to).toBe("one@example.org, two@example.org");
  });

  // One sender, not one per message: nodemailer holds the connection pool, and
  // rebuilding it per notification would open a connection per email.
  test("builds the SMTP sender once and reuses it", async () => {
    const smtp = stubSmtp();

    const transport = createMailTransport({
      from: "muster@example.org",
      delivery: { kind: "smtp", url: "smtp://smtp.example.org:25" },
      smtpFactory: smtp.factory,
    });
    await transport.send(message);
    await transport.send(message);

    expect(smtp.urls).toHaveLength(1);
    expect(smtp.sent).toHaveLength(2);
  });

  // A failure must reach the caller: every user-visible operation reports
  // pending, failed with cause, or succeeded, and a swallowed send would leave
  // a member waiting for an email that never comes.
  test("propagates an SMTP failure", async () => {
    const transport = createMailTransport({
      from: "muster@example.org",
      delivery: { kind: "smtp", url: "smtp://smtp.example.org:25" },
      smtpFactory: () => ({
        sendMail: () => Promise.reject(new Error("550 mailbox unavailable")),
      }),
    });

    await expect(transport.send(message)).rejects.toThrow(
      /mailbox unavailable/,
    );
  });

  test("refuses a message with no recipient", async () => {
    const smtp = stubSmtp();
    const transport = createMailTransport({
      from: "muster@example.org",
      delivery: { kind: "smtp", url: "smtp://smtp.example.org:25" },
      smtpFactory: smtp.factory,
    });

    await expect(transport.send({ ...message, to: [] })).rejects.toThrow(
      /recipient/i,
    );
    expect(smtp.sent).toEqual([]);
  });
});
