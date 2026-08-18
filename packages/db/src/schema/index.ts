/**
 * Drizzle table definitions.
 *
 * Populated per user story: `directory.ts` (accounts, organisations, systems,
 * events, enrolments), `pairings.ts`, `checks.ts`, `keys.ts`, `statements.ts`,
 * `harness.ts`, `personas.ts`, `tickets.ts`. `drizzle-kit generate` reads this
 * directory to produce the SQL under `packages/db/migrations`.
 *
 * @author John Grimes
 */

export * from "./directory.ts";
export * from "./pairings.ts";
