import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright configuration for the end-to-end suite.
 *
 * The suite runs against the docker-compose stack, not a dev server: bring the
 * stack up first (`bun run stack:up`, added with the suite itself), then point
 * `MUSTER_E2E_BASE_URL` at it if it is not on the default port.
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
