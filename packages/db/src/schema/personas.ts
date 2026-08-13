/**
 * The event's shared test patients, and who was found to hold them.
 *
 * Four decisions the schema holds rather than a route remembering to.
 *
 * **An IHI is mandatory.** `data-model.md` writes it as required, and it is required for a
 * reason beyond tidiness: the ticket playground binds a ticket's subject by IHI, so a
 * persona without one is a persona nothing can be minted for. A `not null` column is what
 * makes FR-031's "only patients carrying an IHI are eligible" a property of the record
 * rather than of whichever route inserted it.
 *
 * **One persona per IHI per event.** Two rows for one identifier would put two identical
 * cards on the persona page, two rows in the coverage grid, and an ambiguity where the
 * ticket playground has to pick a subject. The unique index makes a second attempt a
 * refusal rather than a duplicate.
 *
 * **The IHI's system is not stored.** It is one value for the deployment, fixed by
 * configuration (`research.md`), and a column holding it per row would be a column that can
 * disagree with the configuration the coverage checks search by - which would show as
 * personas that are permanently `missing` everywhere.
 *
 * **Coverage is append-only, one row per observation.** Same as `check_result` and for the
 * same reason: a coverage outcome is something observed at a time rather than a status that
 * changes, and `data-model.md` fills the grid from the latest row per (persona, enrolment).
 * Nothing constrains the enrolment to a server here, because that is a property of the
 * system's `server_profile` jsonb rather than something a foreign key can express; the
 * scheduler selects server enrolments and nothing else writes these rows.
 *
 * Author: John Grimes
 */

import {
  index,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { createdAt, instant, primaryId, timestamps } from "./columns.js";
import { enrolment, event } from "./directory.js";
import {
  personaCoverageOutcomeEnum,
  personaSourceStatusEnum,
} from "./enums.js";

import type { PersonaDisplay } from "@muster/contracts";

/**
 * One curated persona (FR-031).
 *
 * `source_checked_at` is not in `data-model.md`'s table and is here anyway, for the reason
 * `check_result.detail` is: `source_status` on its own is a flag with no provenance, and the
 * edge case it exists for - the source server deleted or changed the patient - is something
 * an admin has to be able to date. It is also what makes the source re-read schedulable at
 * a cadence rather than repeated on every pass.
 */
export const persona = pgTable(
  "persona",
  {
    ...primaryId(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => event.id),
    /** The patient's identifier on the event's configured source server. */
    patientId: text("patient_id").notNull(),
    display: jsonb("display").$type<PersonaDisplay>().notNull(),
    /** Required. Its system is configuration, not a column. See the module header. */
    ihi: text("ihi").notNull(),
    sourceStatus: personaSourceStatusEnum("source_status")
      .notNull()
      .default("present"),
    /** Null until the scheduler has asked the source about this persona. */
    sourceCheckedAt: instant("source_checked_at"),
    ...timestamps(),
  },
  (table) => [
    // "The personas of this event", which is the persona page's whole first query.
    index("persona_event_id_idx").on(table.eventId),
    uniqueIndex("persona_event_id_ihi_key").on(table.eventId, table.ihi),
  ],
);

/**
 * What one server said about one persona (FR-032).
 *
 * `detail` carries why, because `unverifiable` alone is not something a server's owner can
 * act on: "requires authorization" and "answered with something that is not a searchset"
 * are different problems, and the wireframe's own grid shows the reason beside the outcome.
 */
export const personaCoverage = pgTable(
  "persona_coverage",
  {
    ...primaryId(),
    personaId: uuid("persona_id")
      .notNull()
      .references(() => persona.id),
    enrolmentId: uuid("enrolment_id")
      .notNull()
      .references(() => enrolment.id),
    checkedAt: instant("checked_at").notNull(),
    outcome: personaCoverageOutcomeEnum("outcome").notNull(),
    /** Null when the patient was simply found: the grid's tick is the whole answer. */
    detail: text("detail"),
    ...createdAt(),
  },
  (table) => [
    // "What is the latest outcome for this pair?", asked once per cell of the grid.
    index("persona_coverage_pair_checked_at_idx").on(
      table.personaId,
      table.enrolmentId,
      table.checkedAt.desc(),
    ),
  ],
);

/** A row of `persona` as selected. */
export type PersonaRow = typeof persona.$inferSelect;
/** A row of `persona_coverage` as selected. */
export type PersonaCoverageRow = typeof personaCoverage.$inferSelect;
