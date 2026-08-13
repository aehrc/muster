/**
 * Every conformance run Muster has made against a participant's registration endpoint.
 *
 * One table, append-only, and the latest row per enrolment decides the DCR-verified badge -
 * which is `data-model.md`'s arrangement and is also the only one that satisfies FR-030's
 * second half. "Any failing run removes the badge" is a claim about the newest run rather
 * than about a stored flag: a badge held in a column would have to be un-set by whatever
 * wrote the next run, and the day that write failed the badge would be a lie.
 *
 * Three columns need their reasons stated.
 *
 * **`checks` is one jsonb document rather than an array of them.** `data-model.md` writes
 * `jsonb[]`; a Postgres array of jsonb is awkward to read back and buys nothing over a single
 * document holding the list, which is what the API sends anyway. The same decision as
 * `check_result.drift_flags`, for the same reason.
 *
 * **The evidence in `checks` is already scrubbed.** A registration response for a
 * confidential client carries a `client_secret`, and constitution principle IV forbids
 * storing one. The route redacts credential-bearing members before this row is written, so
 * there is no state of the database in which a secret is in this column - and
 * `harness.routes.test.ts` asserts it by searching every column of every table rather than
 * the ones somebody thought of.
 *
 * **`ran_at` is the request's time, not the database's.** Every other time in this schema is
 * decided by the route from the injected clock, so a suite that pins the clock sees the time
 * it pinned. `created_at` stays as the row's own audit stamp.
 *
 * Rows are never deleted or updated. A run is a record of what a server did when asked.
 *
 * Author: John Grimes
 */

import { index, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";

import { createdAt, instant, primaryId } from "./columns.js";
import { account, enrolment } from "./directory.js";
import { harnessVerdictEnum } from "./enums.js";

import type { HarnessCheckView } from "@muster/contracts";

/**
 * One conformance run against one enrolled server (FR-029, FR-030).
 *
 * Nothing constrains the enrolment to a trusted-DCR server here: the registration mode lives
 * inside the system's `server_profile` jsonb, which is not something a foreign key can reach.
 * The route refuses any other kind, and it is the only writer.
 */
export const harnessRun = pgTable(
  "harness_run",
  {
    ...primaryId(),
    enrolmentId: uuid("enrolment_id")
      .notNull()
      .references(() => enrolment.id),
    /** The member who ran it. A run presents artefacts to somebody else's server. */
    runBy: uuid("run_by")
      .notNull()
      .references(() => account.id),
    ranAt: instant("ran_at").notNull(),
    verdict: harnessVerdictEnum("verdict").notNull(),
    /** Per-check outcomes with their request and response evidence, already scrubbed. */
    checks: jsonb("checks").$type<readonly HarnessCheckView[]>().notNull(),
    /** What was deleted, and what was left behind (scenario 4). */
    cleanup: text("cleanup").notNull(),
    ...createdAt(),
  },
  (table) => [
    // "What was the latest run for this enrolment?", asked once per server row of the event
    // view, and "what runs has this entry had?", asked by the harness screen.
    index("harness_run_enrolment_id_ran_at_idx").on(
      table.enrolmentId,
      table.ranAt.desc(),
    ),
  ],
);

/** A row of `harness_run` as selected. */
export type HarnessRunRow = typeof harnessRun.$inferSelect;
