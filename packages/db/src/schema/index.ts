/*
 * Copyright © 2026 Commonwealth Scientific and Industrial Research Organisation
 * (CSIRO) ABN 41 687 119 230. Licensed under the Apache License, Version 2.0.
 */

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

export * from "./checks.ts";
export * from "./directory.ts";
export * from "./harness.ts";
export * from "./keys.ts";
export * from "./pairings.ts";
export * from "./personas.ts";
export * from "./statements.ts";
export * from "./tickets.ts";
