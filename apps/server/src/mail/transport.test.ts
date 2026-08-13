/**
 * How Muster sends mail, and what it says about having done so.
 *
 * Email is the only notification channel: approval, revocation, awaiting-approval
 * (FR-003) and every pairing transition (FR-014) arrive this way, so a transport that
 * fails silently turns a workflow into a dead end. The console transport therefore
 * logs the rendered message rather than discarding it - that is what a developer and
 * the compose stack read verification links out of - and neither transport may put a
 * credential in a log (FR-036).
 *
 * Author: John Grimes
 */

import { describe, expect, it } from "bun:test";

import {
  createMailTransport,
  describeMailTransport,
  renderMessage,
} from "./transport.js";

import type { MailMessage } from "./transport.js";

/** A representative message: the verification email, which carries a link. */
const MESSAGE: MailMessage = {
  to: "participant@example.org",
  subject: "Verify your Muster email address",
  text: "Open https://muster.example/verify?token=abc to verify your address.",
};

describe("renderMessage", () => {
  it("renders the envelope and the body", () => {
    const rendered = renderMessage("Muster <no-reply@muster.example>", MESSAGE);

    expect(rendered).toContain("From: Muster <no-reply@muster.example>");
    expect(rendered).toContain("To: participant@example.org");
    expect(rendered).toContain("Subject: Verify your Muster email address");
    expect(rendered).toContain("https://muster.example/verify?token=abc");
  });

  it("separates the headers from the body with a blank line", () => {
    // So a reader scanning a log can tell where the message starts, and so a link on
    // its own line can be clicked.
    const rendered = renderMessage("no-reply@muster.example", MESSAGE);

    expect(rendered).toContain("\n\n");
  });
});

describe("createMailTransport with no SMTP URL", () => {
  it("logs the rendered message instead of sending it", async () => {
    const lines: string[] = [];
    const transport = createMailTransport({
      from: "no-reply@muster.example",
      log: (line) => lines.push(line),
    });

    await transport.send(MESSAGE);

    // The whole message, not a summary: this is where a developer reads the
    // verification link out of, per the quickstart.
    expect(lines.join("\n")).toContain("participant@example.org");
    expect(lines.join("\n")).toContain(
      "https://muster.example/verify?token=abc",
    );
  });

  it("describes itself as the console transport", () => {
    expect(describeMailTransport(undefined)).toBe(
      "console (messages are logged, not sent)",
    );
  });
});

describe("createMailTransport with an SMTP URL", () => {
  /** Records what would have been handed to nodemailer. */
  function recordingSmtp() {
    const sent: Record<string, unknown>[] = [];
    const urls: string[] = [];
    return {
      sent,
      urls,
      factory: (url: string) => {
        urls.push(url);
        return {
          sendMail: async (options: Record<string, unknown>) => {
            sent.push(options);
            await Promise.resolve();
          },
        };
      },
    };
  }

  it("builds the transport from the URL and sends through it", async () => {
    const smtp = recordingSmtp();
    const transport = createMailTransport({
      smtpUrl: "smtp://user:secret@relay.example:587",
      from: "no-reply@muster.example",
      createSmtpTransport: smtp.factory,
    });

    await transport.send(MESSAGE);

    expect(smtp.urls).toEqual(["smtp://user:secret@relay.example:587"]);
    expect(smtp.sent[0]).toMatchObject({
      from: "no-reply@muster.example",
      to: "participant@example.org",
      subject: "Verify your Muster email address",
      text: MESSAGE.text,
    });
  });

  // Built once rather than per message, because a transport pools connections and
  // rebuilding it per notification would open a connection per email.
  it("builds the transport once", async () => {
    const smtp = recordingSmtp();
    const transport = createMailTransport({
      smtpUrl: "smtp://relay.example:25",
      from: "no-reply@muster.example",
      createSmtpTransport: smtp.factory,
    });

    await transport.send(MESSAGE);
    await transport.send(MESSAGE);

    expect(smtp.urls).toHaveLength(1);
  });

  it("does not log the message body when sending for real", async () => {
    const lines: string[] = [];
    const smtp = recordingSmtp();
    const transport = createMailTransport({
      smtpUrl: "smtp://relay.example:25",
      from: "no-reply@muster.example",
      createSmtpTransport: smtp.factory,
      log: (line) => lines.push(line),
    });

    await transport.send(MESSAGE);

    // A verification link is a credential. It belongs in the message, not in the
    // deployment's logs - which is exactly the opposite of what the console transport
    // is for, and why the two are separate transports rather than one with a flag.
    expect(lines.join("\n")).not.toContain("token=abc");
  });

  // The URL carries a password. Startup and failure messages name the relay, never
  // the credential.
  it("describes itself without the credentials", () => {
    const description = describeMailTransport(
      "smtp://user:secret@relay.example:587",
    );

    expect(description).toContain("relay.example:587");
    expect(description).not.toContain("secret");
    expect(description).not.toContain("user");
  });

  it("describes an unparseable SMTP URL without quoting it", () => {
    expect(describeMailTransport("not a url")).toBe(
      "smtp (the configured MUSTER_SMTP_URL could not be parsed)",
    );
  });

  // The default factory is nodemailer itself. Exercised here so the wiring is proved
  // rather than only the injected stand-in - the bundle gate covers whether it can
  // ship, and this covers whether it can be constructed.
  it("uses nodemailer when no factory is injected", () => {
    const transport = createMailTransport({
      smtpUrl: "smtp://relay.example:25",
      from: "no-reply@muster.example",
    });

    expect(typeof transport.send).toBe("function");
  });
});
