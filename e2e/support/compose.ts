/**
 * Driving the compose stack from the suite.
 *
 * Two scenarios need the stack itself to change while the suite is running, and neither can
 * be faked from the browser.
 *
 * Scenario 5 stops a server and asks the event view to notice. "Unreachable, and here is when
 * it was last reachable" is a claim about a server that *used to* answer, so nothing short of
 * stopping one that has already been checked will produce it.
 *
 * Scenario 4 runs the conformance harness against a stub that has had one of its rules turned
 * off. `STUB_BROKEN_MODE` is how the registration stub is told to skip signature validation,
 * and it is read at startup, so exercising it means recreating that one service.
 *
 * Everything here shells out to `docker compose` with the suite's own environment, so the
 * ports the stack was brought up on are the ports it is addressed on.
 *
 * Author: John Grimes
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/** The repository root, from this file. */
const ROOT = new URL("../..", import.meta.url).pathname;

/** The compose file, relative to the root. */
const COMPOSE_FILE = "deploy/docker-compose.yml";

/**
 * Runs one `docker compose` command against the stack.
 *
 * @param args - The arguments after `compose -f <file>`.
 * @param env - Extra environment for the command, merged over the suite's own.
 * @returns Nothing; the command's output is discarded unless it fails.
 * @throws {Error} When the command exits non-zero, carrying its stderr.
 */
async function compose(
  args: readonly string[],
  env: Readonly<Record<string, string>> = {},
): Promise<void> {
  await run("docker", ["compose", "-f", COMPOSE_FILE, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    maxBuffer: 32 * 1024 * 1024,
  });
}

/**
 * Reads one service's log from the beginning.
 *
 * @param service - The compose service.
 * @returns Everything the service has written, with compose's own per-line prefix stripped
 *   so that a message spanning several lines reads as it was written.
 * @example
 * ```ts
 * const log = await serviceLog("muster");
 * ```
 */
export async function serviceLog(service: string): Promise<string> {
  const { stdout } = await run(
    "docker",
    [
      "compose",
      "-f",
      COMPOSE_FILE,
      "logs",
      "--no-color",
      "--no-log-prefix",
      service,
    ],
    { cwd: ROOT, env: process.env, maxBuffer: 64 * 1024 * 1024 },
  );
  return stdout;
}

/**
 * Stops one service, leaving its container in place.
 *
 * @param service - The compose service.
 * @example
 * ```ts
 * await stopService("stub-server");
 * ```
 */
export async function stopService(service: string): Promise<void> {
  await compose(["stop", "--timeout", "5", service]);
}

/**
 * Starts a service that was stopped.
 *
 * @param service - The compose service.
 * @example
 * ```ts
 * await startService("stub-server");
 * ```
 */
export async function startService(service: string): Promise<void> {
  await compose(["start", service]);
}

/**
 * Recreates the registration stub with a rule turned off, or turned back on.
 *
 * `--no-deps`, because the stub declares a dependency on Muster and recreating that would
 * restart the server the whole suite is signed in to.
 *
 * @param mode - The broken mode, or the empty string for a conformant stub.
 * @example
 * ```ts
 * await setRegistrationStubMode("skip-signature");
 * ```
 */
export async function setRegistrationStubMode(mode: string): Promise<void> {
  await compose(["up", "-d", "--no-deps", "--force-recreate", "stub-server"], {
    STUB_BROKEN_MODE: mode,
  });
}
