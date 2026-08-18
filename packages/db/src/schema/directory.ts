import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { auditColumns, surrogateKey } from "./columns.ts";

/**
 * The directory tables: accounts and their tokens and sessions, organisations
 * and their members, systems, events and enrolments.
 *
 * These definitions are the source `drizzle-kit generate` reads to write the
 * SQL under `packages/db/migrations`, which the runner applies. Queries are
 * written in `repositories/`, against Bun's SQL client, so nothing in the
 * serving path depends on Drizzle at run time.
 *
 * Three constraints in here carry rules rather than shapes, and each is stated
 * in the database because a rule enforced only in a route handler is a rule
 * that a later route handler forgets: a system must be a server or a client or
 * both, a system enrols into an event at most once, and an enrolment's
 * capability tags must be drawn from the event's own set.
 *
 * @author John Grimes
 */

/** Account lifecycle, per the data model. */
export const accountStatus = pgEnum("account_status", [
  "pending",
  "approved",
  "revoked",
]);

/** What a single-use account token is for. */
export const accountTokenPurpose = pgEnum("account_token_purpose", [
  "emailVerification",
  "passwordReset",
]);

/** Event lifecycle, per the data model. */
export const eventStatus = pgEnum("event_status", ["draft", "open", "closed"]);

/**
 * A required reference to an account, dropped with it.
 *
 * @returns the foreign key column
 */
const accountReference = () =>
  uuid()
    .notNull()
    .references(() => account.id, { onDelete: "cascade" });

/** A person. */
export const account = pgTable("account", {
  id: surrogateKey(),
  // Case-folded on the way in, so the unique constraint is the whole rule.
  email: text().notNull().unique(),
  displayName: text().notNull(),
  // argon2id, via Bun.password. Never logged, never returned.
  passwordHash: text().notNull(),
  emailVerifiedAt: timestamp({ withTimezone: true }),
  status: accountStatus().notNull().default("pending"),
  isAdmin: boolean().notNull().default(false),
  approvedBy: uuid(),
  approvedAt: timestamp({ withTimezone: true }),
  ...auditColumns(),
});

/** A single-use token: email verification today, password reset later. */
export const accountToken = pgTable("account_token", {
  id: surrogateKey(),
  accountId: accountReference(),
  // The token itself is never stored; this is its SHA-256 digest.
  tokenHash: text().notNull().unique(),
  purpose: accountTokenPurpose().notNull(),
  expiresAt: timestamp({ withTimezone: true }).notNull(),
  usedAt: timestamp({ withTimezone: true }),
  ...auditColumns(),
});

/** A signed-in browser. The opaque token is held only as a digest. */
export const session = pgTable("session", {
  id: surrogateKey(),
  accountId: accountReference(),
  tokenHash: text().notNull().unique(),
  expiresAt: timestamp({ withTimezone: true }).notNull(),
  ...auditColumns(),
});

/** A participating vendor or team. Names are not unique: identity is the row. */
export const organisation = pgTable("organisation", {
  id: surrogateKey(),
  name: text().notNull(),
  ...auditColumns(),
});

/** Who belongs to an organisation. Every member has the same rights. */
export const organisationMember = pgTable(
  "organisation_member",
  {
    id: surrogateKey(),
    organisationId: uuid()
      .notNull()
      .references(() => organisation.id, { onDelete: "cascade" }),
    accountId: accountReference(),
    ...auditColumns(),
  },
  (table) => [unique().on(table.organisationId, table.accountId)],
);

/** An organisation's entry: a server, a client, or both. */
export const system = pgTable(
  "system",
  {
    id: surrogateKey(),
    organisationId: uuid()
      .notNull()
      .references(() => organisation.id),
    name: text().notNull(),
    description: text().notNull().default(""),
    // Validated against the contracts schemas before it is written.
    serverProfile: jsonb(),
    clientProfile: jsonb(),
    ...auditColumns(),
  },
  (table) => [
    check(
      "system_profile_present",
      sql`${table.serverProfile} is not null or ${table.clientProfile} is not null`,
    ),
  ],
);

/** A connectathon. Capability tags are defined per event, not in the schema. */
export const event = pgTable("event", {
  id: surrogateKey(),
  slug: text().notNull().unique(),
  name: text().notNull(),
  startsOn: date().notNull(),
  endsOn: date().notNull(),
  status: eventStatus().notNull().default("draft"),
  capabilityTags: text().array().notNull().default([]),
  personaSourceUrl: text(),
  graceDays: integer().notNull().default(7),
  ...auditColumns(),
});

/** A system's participation in one event, with its details confirmed current. */
export const enrolment = pgTable(
  "enrolment",
  {
    id: surrogateKey(),
    eventId: uuid()
      .notNull()
      .references(() => event.id),
    systemId: uuid()
      .notNull()
      .references(() => system.id),
    tags: text().array().notNull().default([]),
    confirmedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    confirmedBy: uuid()
      .notNull()
      .references(() => account.id),
    ...auditColumns(),
  },
  (table) => [unique().on(table.eventId, table.systemId)],
);
