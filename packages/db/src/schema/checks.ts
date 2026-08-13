/**
 * What Muster observed when it asked a server about itself.
 *
 * One table, append-only in practice: `data-model.md` keeps the history and lets the
 * latest row per enrolment drive the badges. Nothing here is ever updated, because a check
 * is an observation at a time rather than a status that changes - and because scenario 2
 * needs the last row *and* the last successful one, which a single mutable status row
 * cannot answer.
 *
 * Three things the schema holds rather than a route remembering to.
 *
 * **A check belongs to an enrolment, not a system.** Only enrolled systems are checked
 * (`data-model.md`), and an enrolment is what ties a system to an event - so the event view
 * reads checks without having to decide which of a system's enrolments a check was for.
 * Nothing constrains the enrolment to a server here, because that is a property of the
 * system's `server_profile` jsonb and not something a foreign key can express; the
 * scheduler selects server enrolments and nothing else writes these rows.
 *
 * **Reachable and failed are the same fact, stated once.** `reachable` is a boolean the
 * badge reads and `failure_mode` is the cause the sentence beside it reads, so a row
 * claiming to be reachable with a timeout - or unreachable with no reason - would make the
 * two disagree on the same page. The check constraint makes them one fact.
 *
 * **`drift_flags` is a single jsonb array rather than an array of jsonb.**
 * `data-model.md` writes `jsonb[]`; a Postgres array of jsonb is awkward to read back and
 * buys nothing over one document holding the list, which is what the API sends anyway.
 *
 * Author: John Grimes
 */

import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  text,
  uuid,
} from "drizzle-orm/pg-core";

import { createdAt, instant, primaryId } from "./columns.js";
import { enrolment } from "./directory.js";
import { checkFailureModeEnum } from "./enums.js";

import type {
  CapabilityHighlights,
  DiscoveryHighlights,
  DriftFlag,
} from "@muster/contracts";

/**
 * One verification check of one enrolled server (FR-017).
 *
 * `detail` is not in `data-model.md` and is here anyway, because `guarded` on its own is
 * not something an owner can act on: it says the address was refused without saying that
 * the name resolved to a private address, or that the scheme was plain HTTP. FR-037 asks
 * every operation to report its cause, and this column is where a check's cause lives.
 */
export const checkResult = pgTable(
  "check_result",
  {
    ...primaryId(),
    enrolmentId: uuid("enrolment_id")
      .notNull()
      .references(() => enrolment.id),
    checkedAt: instant("checked_at").notNull(),
    reachable: boolean("reachable").notNull(),
    /** Null when the check succeeded. See the constraint below. */
    failureMode: checkFailureModeEnum("failure_mode"),
    detail: text("detail"),
    /** Null when no smart-configuration was served, which an open server is entitled to. */
    discovery: jsonb("discovery").$type<DiscoveryHighlights>(),
    capability: jsonb("capability").$type<CapabilityHighlights>(),
    driftFlags: jsonb("drift_flags")
      .$type<readonly DriftFlag[]>()
      .notNull()
      .default([]),
    ...createdAt(),
  },
  (table) => [
    // "What is the latest check for this enrolment?", asked once per row of the event
    // view, and "when did one last succeed?", asked for every unreachable one.
    index("check_result_enrolment_id_checked_at_idx").on(
      table.enrolmentId,
      table.checkedAt.desc(),
    ),
    check(
      "check_result_reachable_has_no_failure_mode",
      sql`${table.reachable} = (${table.failureMode} is null)`,
    ),
  ],
);

/** A row of `check_result` as selected. */
export type CheckResultRow = typeof checkResult.$inferSelect;
