/**
 * Reading the mail of a server that logs it instead of sending it.
 *
 * The compose stack sets no `MUSTER_SMTP_URL`, which selects the console transport: every
 * message Muster would have sent is written to its log instead. That is deliberate - it is
 * how the quickstart reads a verification link - and reading it back is the only way a suite
 * can follow one, or assert that a counterparty was notified, without either standing up an
 * SMTP server or reaching into the database. Both of those would test something other than
 * what a participant experiences.
 *
 * Pure, and separate from the reading of the log, so the parsing can be tested without a
 * stack. The interesting failure is attributing one account's message to another, which
 * produces a suite that verifies the wrong address and then fails somewhere unrelated.
 *
 * Author: John Grimes
 */

/**
 * The messages addressed to one recipient, oldest first.
 *
 * Each message is rendered as an envelope, a blank line and a body (`renderMessage` in
 * `apps/server/src/mail/transport.ts`), and one message's `From:` is where the previous one
 * ends.
 *
 * @param log - The server's log, with any per-line container prefix already stripped.
 * @param address - The recipient to collect messages for.
 * @returns Each message, from its `To:` line onwards.
 * @example
 * ```ts
 * messagesTo(log, "server.owner@muster.test").some((m) => m.includes("pairing"));
 * ```
 */
export function messagesTo(log: string, address: string): readonly string[] {
  return log
    .split(/^From:\s/m)
    .slice(1)
    .filter((message) => /^To:\s*(\S+)\s*$/m.exec(message)?.[1] === address);
}

/**
 * Every verification link sent to one address, oldest first.
 *
 * @param log - The server's log.
 * @param address - The account's email address.
 * @returns The links, in the order they were written, so the newest is the last.
 * @example
 * ```ts
 * verificationLinksIn(log, "server.owner@muster.test").at(-1);
 * ```
 */
export function verificationLinksIn(
  log: string,
  address: string,
): readonly string[] {
  return messagesTo(log, address).flatMap((message) => {
    const link = /(https?:\/\/\S*\/verify\?token=\S+)/.exec(message);
    return link?.[1] === undefined ? [] : [link[1]];
  });
}
