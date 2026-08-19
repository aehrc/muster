import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright configuration for the end-to-end suite.
 *
 * The suite runs against the docker-compose stack, not a dev server:
 *
 * ```sh
 * bun run stack:up     # muster, postgres, and the three stubs
 * bun run stack:seed   # the admin account and the open event
 * bun run test:e2e
 * ```
 *
 * `MUSTER_E2E_BASE_URL` points it somewhere else, and the addresses in
 * `tests/support/stack.ts` do the same for each stub - which is what lets the same
 * suite run against the stack brought up as bare processes.
 *
 * One worker and no parallelism, deliberately: the scenarios share one event and
 * one persona set, as the participants at a connectathon do.
 */
export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  forbidOnly: Boolean(process.env["CI"]),
  retries: process.env["CI"] === undefined ? 0 : 1,
  workers: 1,
  reporter:
    process.env["CI"] === undefined
      ? [["list"]]
      : [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: process.env["MUSTER_E2E_BASE_URL"] ?? "http://localhost:8080",
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
