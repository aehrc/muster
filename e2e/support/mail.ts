/**
 * Waiting for the mail the stack did not send.
 *
 * The parsing lives in `../src/consoleMail.ts`, which is pure and unit tested; this is the
 * polling around it.
 *
 * Author: John Grimes
 */

import { serviceLog } from "./compose.js";
import { messagesTo, verificationLinksIn } from "../src/consoleMail.js";

/** How long to keep re-reading the log before giving up on a message. */
const WAIT_TIMEOUT_MS = 30_000;

/** How long to leave between reads. */
const WAIT_INTERVAL_MS = 500;

/**
 * Polls Muster's log until a message satisfies the reader, or the wait runs out.
 *
 * @param what - What is being waited for, for the failure message.
 * @param read - Turns the log into the answer, or undefined when it is not there yet.
 * @returns The answer.
 * @throws {Error} When nothing satisfies the reader in time, which means the message was
 *   never sent rather than that it was slow.
 */
async function awaitInLog<T>(
  what: string,
  read: (log: string) => T | undefined,
): Promise<T> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  for (;;) {
    const found = read(await serviceLog("muster"));
    if (found !== undefined) {
      return found;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `${what} did not appear in Muster's log within ${String(WAIT_TIMEOUT_MS / 1000)}s. The console mail transport writes every message there, so an absent one means none was sent.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, WAIT_INTERVAL_MS));
  }
}

/**
 * Waits for the newest verification link sent to an address.
 *
 * @param address - The account's email address.
 * @returns The absolute link, as the message carries it.
 * @throws {Error} When no link is logged in time.
 * @example
 * ```ts
 * await page.goto(await awaitVerificationLink("server.owner@muster.test"));
 * ```
 */
export async function awaitVerificationLink(address: string): Promise<string> {
  return await awaitInLog(`A verification link for ${address}`, (log) =>
    verificationLinksIn(log, address).at(-1),
  );
}

/**
 * Waits for a message to an address whose text contains a phrase.
 *
 * @param address - The recipient.
 * @param phrase - Something the message must say.
 * @returns The message, from its `To:` line onwards.
 * @throws {Error} When no such message is logged in time.
 * @example
 * ```ts
 * await awaitMessageTo(SERVER_OWNER.email, "Smart Forms");
 * ```
 */
export async function awaitMessageTo(
  address: string,
  phrase: string,
): Promise<string> {
  return await awaitInLog(
    `A message to ${address} mentioning "${phrase}"`,
    (log) =>
      messagesTo(log, address).find((message) => message.includes(phrase)),
  );
}
