/*
 * Copyright © 2026 Commonwealth Scientific and Industrial Research Organisation
 * (CSIRO) ABN 41 687 119 230. Licensed under the Apache License, Version 2.0.
 */

import {
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { auditColumns, surrogateKey } from "./columns.ts";
import { account, enrolment, event, organisation } from "./directory.ts";

/**
 * The pairing tables: a pairing between one enrolled client and one enrolled
 * server, and the append-only timeline of its transitions.
 *
 * Two rules live in the schema rather than in a route handler, because they must
 * hold whatever a handler believes. A client, a server and an event admit one
 * pairing (FR-015), stated as a unique constraint. The timeline is append-only
 * (FR-013), stated as a trigger in the migration - a record of who did what is
 * not something a later statement gets to revise.
 *
 * A pairing references enrolments rather than systems, because a pairing exists
 * within a single event and an enrolment is what ties a system to one.
 *
 * @author John Grimes
 */

/** Pairing lifecycle, per the data model. */
export const pairingState = pgEnum("pairing_state", [
  "requested",
  "fulfilled",
  "declined",
  "failed",
  "lapsed",
]);

/** One client enrolment paired with one server enrolment, in one event. */
export const pairing = pgTable(
  "pairing",
  {
    id: surrogateKey(),
    eventId: uuid()
      .notNull()
      .references(() => event.id),
    clientEnrolmentId: uuid()
      .notNull()
      .references(() => enrolment.id),
    serverEnrolmentId: uuid()
      .notNull()
      .references(() => enrolment.id),
    state: pairingState().notNull().default("requested"),
    // The standard registration field set as submitted, validated against the
    // contract schema before it is written. A snapshot: the client's own record
    // can change afterwards, and what the server was asked for must not.
    registrationFields: jsonb().notNull(),
    clientId: text(),
    declineReason: text(),
    ...auditColumns(),
  },
  (table) => [
    unique().on(
      table.eventId,
      table.clientEnrolmentId,
      table.serverEnrolmentId,
    ),
  ],
);

/** One transition, recorded for the timeline both parties read. */
export const pairingEvent = pgTable("pairing_event", {
  id: surrogateKey(),
  pairingId: uuid()
    .notNull()
    .references(() => pairing.id, { onDelete: "cascade" }),
  // Null for a transition Muster made rather than a person: an event closing
  // lapses what is still open without anybody acting for a side.
  actorAccountId: uuid().references(() => account.id),
  actingForOrganisationId: uuid().references(() => organisation.id),
  fromState: pairingState(),
  toState: pairingState().notNull(),
  detail: jsonb().notNull().default({}),
  at: timestamp({ withTimezone: true }).notNull().defaultNow(),
  ...auditColumns(),
});
