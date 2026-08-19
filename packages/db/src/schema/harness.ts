import { index, jsonb, pgEnum, pgTable, text, uuid } from "drizzle-orm/pg-core";

import { auditColumns, surrogateKey } from "./columns.ts";
import { account, enrolment } from "./directory.ts";

/**
 * The conformance table: one row per run of the harness against one entry.
 *
 * A run is evidence, and evidence is not disposable. Nothing here is overwritten:
 * the latest row per enrolment drives the "DCR verified" badge (FR-030) and the
 * older rows are the history that makes the badge worth anything - a server that
 * passed in July and fails today shows both, and the badge follows the newer one.
 *
 * `checks` holds the whole report: each check's name, its outcome and the request
 * and response that decided it. It is written and read whole, so it is one jsonb
 * array rather than a table of rows; nothing queries inside it.
 *
 * The evidence has already been redacted by the time it arrives (see
 * `packages/core/src/harness/checks.ts`). A software statement is stored without
 * its signature and a client secret or registration access token is stored as
 * `[redacted]`, because the report is public and no credential is ever written
 * down (the constitution).
 *
 * `created_at` is the run's time. The data model gives the run no time column of
 * its own because the audit column already is one, and two timestamps that mean
 * the same thing eventually disagree.
 *
 * @author John Grimes
 */

/** How a run turned out; only `passed` earns the badge. */
export const harnessVerdict = pgEnum("harness_verdict", ["passed", "failed"]);

/** One conformance run against one enrolled server. */
export const harnessRun = pgTable(
  "harness_run",
  {
    id: surrogateKey(),
    // Server enrolments that declare trusted DCR, which is a rule about which
    // rows are written rather than a shape: nothing else has an endpoint to run
    // the profile against.
    enrolmentId: uuid()
      .notNull()
      .references(() => enrolment.id, { onDelete: "cascade" }),
    runBy: uuid()
      .notNull()
      .references(() => account.id),
    verdict: harnessVerdict().notNull(),
    // The whole report, redacted, as the public route serves it.
    checks: jsonb().notNull().default([]),
    // What became of the throwaway clients the run registered: what was deleted,
    // and what was left behind for its owner to remove (acceptance scenario 4).
    cleanup: text().notNull().default(""),
    ...auditColumns(),
  },
  (table) => [
    // "The latest run for this enrolment" and "this enrolment's runs" are the
    // only two reads, and this is both of them.
    index("harness_run_enrolment_created_at_idx").on(
      table.enrolmentId,
      table.createdAt.desc(),
    ),
  ],
);
