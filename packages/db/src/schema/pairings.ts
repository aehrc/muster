/**
 * The pairing tracker's two tables: the negotiation, and its history.
 *
 * Four rules are held here rather than by a route remembering to hold them.
 *
 * **One pairing per client, server and event.** FR-015 refuses a duplicate request and links to
 * the existing pairing, and a unique index is what makes that a recognised constraint violation
 * rather than a look-then-insert with a window in the middle. It is also what stops one app
 * owner's second attempt from splitting a conversation the server owner has already answered.
 *
 * **A fulfilled pairing carries an identifier, and a declined one carries a reason.** Both are
 * the point of their state: a fulfilment without the issued client identifier records that
 * somebody said yes and loses the only thing the app owner needed, and a decline without a
 * reason turns the tracker back into the email thread it replaces.
 *
 * **The two sides are enrolments, not systems.** A pairing exists inside one event (FR-012,
 * scenario 6), and an enrolment is what ties a system to an event; referencing systems would
 * leave the event to be implied by a column that could disagree with both of them.
 *
 * **The timeline is append-only.** `pairing_event` has no `updated_at` and nothing updates it -
 * `data-model.md` names exactly the columns below, and `at` is the whole of the row's time
 * story. Its rows outlive their causes: `from_state` is null for the request that created the
 * pairing, and `actor_account_id` is nullable so that a lapse nobody triggered by hand still
 * records what happened.
 *
 * Author: John Grimes
 */

import { sql } from "drizzle-orm";
import {
  check,
  index,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { instant, primaryId, timestamps } from "./columns.js";
import { account, enrolment, event, organisation } from "./directory.js";
import { pairingStateEnum } from "./enums.js";

import type {
  PairingEventDetail,
  RegistrationFieldsInput,
} from "@muster/contracts";

/**
 * One client's registration with one server, at one event.
 *
 * `registration_fields` is a snapshot taken when the request was made, and deliberately not a
 * view of the client's record. A server whose registration mode changes from manual to trusted
 * DCR while pairings are open leaves those pairings following the workflow they were requested
 * under (spec edge case), and a client entry edited mid-event does not silently change what a
 * server owner was asked to register.
 */
export const pairing = pgTable(
  "pairing",
  {
    ...primaryId(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => event.id),
    clientEnrolmentId: uuid("client_enrolment_id")
      .notNull()
      .references(() => enrolment.id),
    serverEnrolmentId: uuid("server_enrolment_id")
      .notNull()
      .references(() => enrolment.id),
    state: pairingStateEnum("state").notNull().default("requested"),
    registrationFields: jsonb("registration_fields")
      .$type<RegistrationFieldsInput>()
      .notNull(),
    /** The identifier the server issued. Null until the pairing is fulfilled. */
    clientId: text("client_id"),
    declineReason: text("decline_reason"),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex("pairing_event_client_server_unique").on(
      table.eventId,
      table.clientEnrolmentId,
      table.serverEnrolmentId,
    ),
    // "Which pairings involve this system?", asked by the pairing list from both directions.
    index("pairing_client_enrolment_id_idx").on(table.clientEnrolmentId),
    index("pairing_server_enrolment_id_idx").on(table.serverEnrolmentId),
    // "Which pairings does closing this event lapse?" (FR-011).
    index("pairing_event_id_idx").on(table.eventId),
    check(
      "pairing_fulfilled_has_client_id",
      sql`${table.state} <> 'fulfilled' or ${table.clientId} is not null`,
    ),
    check(
      "pairing_declined_has_reason",
      sql`${table.state} <> 'declined' or ${table.declineReason} is not null`,
    ),
  ],
);

/**
 * One recorded transition: the timeline both organisations read (FR-013).
 *
 * `acting_for_organisation_id` is the organisation the action was taken for, which is the only
 * way to read the history of a pairing where one person belongs to both organisations (spec
 * edge case). It is nullable because a track admin closing an event acts for no organisation.
 */
export const pairingEvent = pgTable(
  "pairing_event",
  {
    ...primaryId(),
    pairingId: uuid("pairing_id")
      .notNull()
      .references(() => pairing.id),
    /** Null when nothing a person did caused it. */
    actorAccountId: uuid("actor_account_id").references(() => account.id),
    actingForOrganisationId: uuid("acting_for_organisation_id").references(
      () => organisation.id,
    ),
    /** Null for the request that created the pairing: it came from no prior state. */
    fromState: pairingStateEnum("from_state"),
    toState: pairingStateEnum("to_state").notNull(),
    detail: jsonb("detail").$type<PairingEventDetail>().notNull().default({}),
    at: instant("at").notNull(),
  },
  (table) => [
    // "What has happened to this pairing?", asked by the detail screen for both parties.
    index("pairing_event_pairing_id_at_idx").on(table.pairingId, table.at),
  ],
);

/** A row of `pairing` as selected. */
export type PairingRow = typeof pairing.$inferSelect;
/** A row of `pairing_event` as selected. */
export type PairingEventRow = typeof pairingEvent.$inferSelect;
