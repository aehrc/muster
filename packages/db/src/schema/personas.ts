/*
 * Copyright © 2026 Commonwealth Scientific and Industrial Research Organisation
 * (CSIRO) ABN 41 687 119 230. Licensed under the Apache License, Version 2.0.
 */

import {
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { auditColumns, surrogateKey } from "./columns.ts";
import { enrolment, event } from "./directory.ts";

/**
 * The persona tables: an event's shared test patients, and the coverage of each
 * one at each enrolled server.
 *
 * Muster is an index, not a store. A persona row holds the identifier that makes
 * the patient findable elsewhere, enough demographics to recognise it on a screen,
 * and a link back to the record it was curated from - and nothing else. Anything
 * more would be a copy of somebody else's clinical data, kept up to date by
 * nobody.
 *
 * The IHI is what a persona is (FR-031), so it is required and unique within an
 * event: two rows for one identifier in one event would put two columns of
 * coverage against the same patient and let them disagree.
 *
 * Coverage rows are observations and nothing here overwrites one. The grid is the
 * latest row per (persona, enrolment), which is what makes a restart harmless and
 * what lets a reader see that a server held the patient last week and does not
 * today. `outcome` is three-valued because `unverifiable` is a real answer: a
 * server that will not be searched without authorization has not said it lacks
 * the patient (FR-032).
 *
 * @author John Grimes
 */

/** Whether the source server still holds the patient a persona was curated from. */
export const personaSourceStatus = pgEnum("persona_source_status", [
  "present",
  "missing",
]);

/** Whether a persona was found at a server, per the data model. */
export const coverageOutcome = pgEnum("coverage_outcome", [
  "found",
  "missing",
  "unverifiable",
]);

/** One of an event's shared test patients. */
export const persona = pgTable(
  "persona",
  {
    id: surrogateKey(),
    eventId: uuid()
      .notNull()
      .references(() => event.id, { onDelete: "cascade" }),
    // The resource identifier on the source server, which is only meaningful
    // there; the IHI is what other servers are searched by.
    patientId: text().notNull(),
    ihi: text().notNull(),
    // Name, birth date and gender as curated, validated against the contract
    // schema before it is written.
    display: jsonb().notNull(),
    // The canonical record, resolved when the persona was added, so a reader can
    // go and look at what everybody is meant to have seeded from.
    sourceUrl: text().notNull(),
    // The flag the edge case asks for: a patient the source has deleted, or whose
    // IHI has changed under Muster, reads `missing` on the admin view.
    sourceStatus: personaSourceStatus().notNull().default("present"),
    // When the source was last read. Null until the scheduler has been round
    // once, which is also what makes the first source check due immediately.
    sourceCheckedAt: timestamp({ withTimezone: true }),
    ...auditColumns(),
  },
  (table) => [unique().on(table.eventId, table.ihi)],
);

/** One check of one persona at one enrolled server. */
export const personaCoverage = pgTable(
  "persona_coverage",
  {
    id: surrogateKey(),
    personaId: uuid()
      .notNull()
      .references(() => persona.id, { onDelete: "cascade" }),
    // Server enrolments only, which is a rule about which rows are written
    // rather than a shape: a client holds no patients to find.
    enrolmentId: uuid()
      .notNull()
      .references(() => enrolment.id, { onDelete: "cascade" }),
    checkedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    outcome: coverageOutcome().notNull(),
    // Why, in words fit for the grid. It matters most for `unverifiable`: "the
    // server requires authorization" and "the guard refused the address" are the
    // same cell to a reader who is only shown the word.
    detail: text().notNull().default(""),
    ...auditColumns(),
  },
  (table) => [
    // The grid reads the latest row per pair, and that is this index.
    index("persona_coverage_pair_checked_at_idx").on(
      table.personaId,
      table.enrolmentId,
      table.checkedAt.desc(),
    ),
  ],
);
