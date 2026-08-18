import {
  boolean,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { auditColumns, surrogateKey } from "./columns.ts";
import { enrolment } from "./directory.ts";

/**
 * The verification table: one row per check of one enrolled server.
 *
 * History is kept and nothing is overwritten. The latest row drives the badge on
 * the event view and the older rows answer the question the participant table
 * could never answer - was this ever true, and when did it stop being true
 * (acceptance scenario 2). That is also what makes a restart harmless: the
 * scheduler holds no state a row does not.
 *
 * A row records what happened rather than what was hoped for. `reachable` is
 * false with a `failure_mode` whenever the server could not be read, and
 * `guarded` says the address guard refused the target and no request was made
 * (FR-020) - a refusal Muster is accountable for, not the server.
 *
 * @author John Grimes
 */

/** Why a check did not reach a server, per the data model. */
export const checkFailureMode = pgEnum("check_failure_mode", [
  "timeout",
  "refused",
  "guarded",
  "invalid",
]);

/** One check of one enrolled server. */
export const checkResult = pgTable(
  "check_result",
  {
    id: surrogateKey(),
    // Server enrolments only, which is a rule about which rows are written
    // rather than a shape: a client has no address to check.
    enrolmentId: uuid()
      .notNull()
      .references(() => enrolment.id, { onDelete: "cascade" }),
    checkedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    reachable: boolean().notNull(),
    // Null exactly when the server was reached.
    failureMode: checkFailureMode(),
    // Why a probe failed, in words fit to show a member. Present on a reachable
    // entry too: a probe that was refused is reported, never skipped quietly.
    detail: text(),
    // The highlights as fetched, validated against the contract schemas before
    // they are written. Null when the document could not be read.
    discovery: jsonb(),
    capability: jsonb(),
    // The disagreements, each naming the field, the declared value and the
    // advertised one. A JSON array rather than an array of jsonb: it is read and
    // written whole, and Postgres arrays of jsonb buy nothing here.
    driftFlags: jsonb().notNull().default([]),
    ...auditColumns(),
  },
  (table) => [
    // Every read is "the latest for this enrolment" or "this enrolment's
    // history", and both are this index.
    index("check_result_enrolment_checked_at_idx").on(
      table.enrolmentId,
      table.checkedAt.desc(),
    ),
  ],
);
