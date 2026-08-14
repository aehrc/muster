/**
 * Waits for Muster, and seeds it, before any spec runs.
 *
 * The seed is repeated here rather than left to whoever brought the stack up, because it is
 * idempotent and because a missing fixture - no admin, no open event - fails the first spec
 * as an unexplained sign-in error rather than as the thing it is.
 *
 * It does not wait for the stubs. They are Bun processes with nothing to install and are
 * listening within seconds; the first spec that needs one is minutes into the run and polls
 * it itself. Waiting for them here would mean verifying a self-signed certificate from a
 * plain `fetch`, which is a fight worth having nowhere.
 *
 * Author: John Grimes
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { resolveStackUrls } from "./src/stackUrls.js";

const run = promisify(execFile);

/** How long to wait for Muster to answer at all. */
const READY_TIMEOUT_MS = 120_000;

/** The repository root, from this file. */
const ROOT = new URL("..", import.meta.url).pathname;

/**
 * Polls Muster's liveness probe until it answers.
 *
 * @param url - The probe's address.
 * @throws {Error} When it does not answer within the timeout.
 */
async function waitForMuster(url: string): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    try {
      if ((await fetch(url)).ok) {
        return;
      }
    } catch {
      // Not up yet.
    }
    if (Date.now() > deadline) {
      throw new Error(
        `Muster did not answer at ${url} within ${String(READY_TIMEOUT_MS / 1000)}s. Is the stack up? Try \`bun run stack:reset\`.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

/**
 * Waits for the stack and seeds it.
 *
 * @returns Nothing. Playwright fails the run if this throws.
 */
export default async function globalSetup(): Promise<void> {
  const { muster } = resolveStackUrls(process.env);
  await waitForMuster(`${muster}/healthz`);
  const { stdout } = await run("bun", ["run", "stack:seed"], {
    cwd: ROOT,
    env: process.env,
  });
  process.stdout.write(stdout);
}
