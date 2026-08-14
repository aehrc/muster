/**
 * The log parser the suite reads Muster's mail with.
 *
 * Tested here rather than discovered in a spec, because the failure that matters - handing
 * one account the other account's link - produces a suite that verifies the wrong address and
 * then fails somewhere unrelated.
 *
 * Author: John Grimes
 */

import { describe, expect, it } from "bun:test";

import { messagesTo, verificationLinksIn } from "./consoleMail.js";

/** Two sign-ups, a resend, and a notification, as the console transport writes them. */
const LOG = [
  "Muster listening on port 3000, public URL http://localhost:3000",
  "From: muster@localhost",
  "To: app.owner@muster.test",
  "Subject: Verify your Muster account",
  "",
  "Hello App Owner,",
  "",
  "http://localhost:3000/verify?token=first-token",
  "",
  "The link works once and expires after 24 hours.",
  "From: muster@localhost",
  "To: server.owner@muster.test",
  "Subject: Verify your Muster account",
  "",
  "http://localhost:3000/verify?token=second-token",
  "From: muster@localhost",
  "To: app.owner@muster.test",
  "Subject: Verify your Muster account",
  "",
  "http://localhost:3000/verify?token=third-token",
  "From: muster@localhost",
  "To: server.owner@muster.test",
  "Subject: A pairing request for MediRecords FHIR",
  "",
  "Smart Forms would like to register.",
].join("\n");

describe("messagesTo", () => {
  it("returns only the messages addressed to the recipient", () => {
    const messages = messagesTo(LOG, "server.owner@muster.test");
    expect(messages).toHaveLength(2);
    expect(messages[1]).toContain("A pairing request for MediRecords FHIR");
  });

  it("finds nothing for an address that was never written to", () => {
    expect(messagesTo(LOG, "nobody@muster.test")).toEqual([]);
  });

  it("ignores log lines that are not part of a message", () => {
    // A startup banner is not a message to anybody.
    expect(messagesTo("Muster listening on port 3000", "a@b.test")).toEqual([]);
  });
});

describe("verificationLinksIn", () => {
  it("attributes each link to the address its envelope named", () => {
    expect(verificationLinksIn(LOG, "server.owner@muster.test")).toEqual([
      "http://localhost:3000/verify?token=second-token",
    ]);
  });

  it("returns an address's links oldest first, so the newest is the last", () => {
    // A resent link supersedes the one before it, and the suite follows the newest.
    expect(verificationLinksIn(LOG, "app.owner@muster.test")).toEqual([
      "http://localhost:3000/verify?token=first-token",
      "http://localhost:3000/verify?token=third-token",
    ]);
  });

  it("finds no link in a message that carries none", () => {
    expect(
      verificationLinksIn(
        [
          "From: muster@localhost",
          "To: a@b.test",
          "Subject: Approved",
          "",
        ].join("\n"),
        "a@b.test",
      ),
    ).toEqual([]);
  });
});
