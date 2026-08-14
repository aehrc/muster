/**
 * The end-to-end suite: quickstart scenarios 1 to 7, against the compose stack.
 *
 * Run it as:
 *
 * ```sh
 * bun run stack:reset   # or stack:up, against a database with nothing in it
 * bun run stack:seed
 * bun run test:e2e
 * ```
 *
 * Four decisions worth stating, because each of them is the opposite of what a suite of
 * independent tests would do.
 *
 * **It is one journey, in order, and it is not parallel.** The quickstart is a sequence: an
 * account is approved before it owns an organisation, a system is enrolled before it can be
 * paired with, a pairing is registered before the harness has anything to verify, and a
 * persona exists before a ticket can name it. The files are numbered because that order is
 * the subject. One worker, `fullyParallel` off.
 *
 * **It needs a database with nothing in it.** A development stack accumulates: extra events,
 * demonstration systems, an account somebody signed up while trying something. The suite
 * asserts what an event contains, so it starts from `stack:reset` - which removes the
 * volume - and the seed. That is a stronger contract than making every fixture unique, and
 * it is the one the quickstart itself describes.
 *
 * **No retries.** A retried spec would replay a step whose effect is already recorded: a
 * second sign-up for an address that now exists, a second pairing that is refused as a
 * duplicate. A failure here is a failure to investigate, not to re-run.
 *
 * **It drives `docker compose`.** Scenario 5 stops a server to watch the directory notice,
 * scenario 4 recreates the registration stub with one of its rules turned off, and every
 * verification link is read from the log the console mail transport writes to. None of those
 * is reachable from a browser, and faking any of them would test the fake.
 *
 * `MUSTER_PORT`, `STUB_SERVER_PORT` and `STUB_HOLDER_PORT` move the stack. **Export them into
 * the shell**, so that this suite and `docker compose` read the same values: Bun does not
 * pass a variable it loaded from a `.env` file to the processes it spawns, and neither
 * `docker compose` nor Playwright is Bun.
 *
 * Author: John Grimes
 */

import { defineConfig, devices } from "@playwright/test";

import { resolveStackUrls } from "./src/stackUrls.js";

export default defineConfig({
  testDir: "./tests",
  // `.e2e.ts`, not Playwright's default `.spec.ts`. Bun's test runner discovers `*.spec.*`
  // and `*.test.*` anywhere under the working directory and has no way to be told to ignore a
  // path, so a spec named the default way is collected by `bun test` at the repository root -
  // where it aborts with "Playwright Test did not expect test() to be called here". The two
  // runners are separated by name because that is the only place they can be separated.
  // `e2e/src/specNaming.test.ts` guards the rule.
  testMatch: "**/*.e2e.ts",
  globalSetup: "./globalSetup.ts",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env["CI"],
  retries: 0,
  reporter: process.env["CI"]
    ? [["github"], ["list"], ["html", { open: "never" }]]
    : [["list"], ["html", { open: "never" }]],
  // Generous, because two scenarios wait for the scheduler. The stack runs with a one-minute
  // check interval and the scheduler looks four times per interval, so an entry that has to
  // be checked, then re-checked after something changed, is a wait of a couple of minutes.
  timeout: 300_000,
  expect: { timeout: 15_000 },
  use: {
    // Bounded, because Playwright's default for an action is *no* limit: a click on
    // something that never appears would otherwise consume the whole test timeout above and
    // report five minutes of waiting rather than fifteen seconds of a missing element.
    actionTimeout: 15_000,
    baseURL: resolveStackUrls(process.env).muster,
    // The stubs serve TLS with the throwaway self-signed certificate in
    // `deploy/stubs/tls`, which is what lets a server entry's https-only URLs point at them.
    // Muster trusts it through `NODE_EXTRA_CA_CERTS`; this is the same decision for the
    // suite, which presents a ticket to the data holder directly.
    ignoreHTTPSErrors: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
