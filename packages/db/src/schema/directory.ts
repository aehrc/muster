/**
 * The directory's tables: people, organisations, systems, events and enrolments.
 *
 * Three constraints here are the ones worth reading, because each is a rule the schema
 * holds rather than a route remembering to.
 *
 * **A system must be a server, a client, or both.** A row with neither profile is an
 * entry nobody can pair with, and it would pass every route's validation the day a new
 * route forgot to check. This one is a `check` constraint rather than something made
 * structurally impossible, because there is no shape that expresses "at least one of
 * these two documents": splitting the profiles into two tables would allow a system with
 * rows in neither, and merging them would lose the distinction the whole directory turns
 * on.
 *
 * **One enrolment per system per event.** Re-enrolling is how a participant confirms
 * their details are still current (SC-008), so the second request has to update the
 * first row rather than add a second - and the unique index is what makes that an upsert
 * instead of a silent duplicate.
 *
 * **An event ends no earlier than it starts.** Statement and ticket expiry is derived
 * from `ends_on` plus a grace period, so a reversed range would mint credentials that
 * expired before the event opened.
 *
 * What is not here: `checkResult`, `pairing`, `persona`, `signingKey` and the rest. Each
 * lands with the user story that reads it, in its own module, and the barrel in
 * `./index.ts` is what `drizzle-kit generate` diffs.
 *
 * Author: John Grimes
 */

import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { createdAt, instant, primaryId, timestamps } from "./columns.js";
import {
  accountStatusEnum,
  accountTokenPurposeEnum,
  eventStatusEnum,
} from "./enums.js";

import type { ClientProfile, ServerProfile } from "@muster/contracts";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

/**
 * A person.
 *
 * `email` is unique on the case-folded form the repositories write (`foldEmail` in
 * `@muster/core`), so two sign-ups differing only in case are one account.
 *
 * `password_hash` holds an argon2id hash and nothing else. It is never projected into a
 * response shape, and no log line may carry it (FR-036).
 */
export const account = pgTable(
  "account",
  {
    ...primaryId(),
    email: text("email").notNull(),
    displayName: text("display_name").notNull(),
    passwordHash: text("password_hash").notNull(),
    emailVerifiedAt: instant("email_verified_at"),
    status: accountStatusEnum("status").notNull().default("pending"),
    isAdmin: boolean("is_admin").notNull().default(false),
    /**
     * Who decided the current status.
     *
     * Self-referential, because an admin is an account. No `onDelete`: accounts are
     * never deleted - a revoked one keeps its history - so there is nothing to cascade.
     */
    approvedBy: uuid("approved_by").references((): AnyPgColumn => account.id),
    approvedAt: instant("approved_at"),
    ...timestamps(),
  },
  (table) => [uniqueIndex("account_email_unique").on(table.email)],
);

/**
 * A single-use, expiring token: today an email verification link.
 *
 * The token itself is never stored. `token_hash` is a digest of the value that went out
 * in the email, so a copy of this table does not let its holder verify somebody else's
 * address. `used_at` is what makes the second use of a link fail (spec edge case).
 */
export const accountToken = pgTable(
  "account_token",
  {
    ...primaryId(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => account.id),
    purpose: accountTokenPurposeEnum("purpose").notNull(),
    tokenHash: text("token_hash").notNull(),
    expiresAt: instant("expires_at").notNull(),
    usedAt: instant("used_at"),
    ...createdAt(),
  },
  (table) => [
    uniqueIndex("account_token_hash_unique").on(table.tokenHash),
    // "Has this account any live verification token?", asked by the resend route.
    index("account_token_account_id_idx").on(table.accountId),
  ],
);

/**
 * A signed-in browser.
 *
 * Same reasoning as the tokens: the cookie's value is opaque and random, and only its
 * digest is here, so a copy of this table cannot be replayed as a session.
 */
export const session = pgTable(
  "session",
  {
    ...primaryId(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => account.id),
    tokenHash: text("token_hash").notNull(),
    expiresAt: instant("expires_at").notNull(),
    ...createdAt(),
  },
  (table) => [
    uniqueIndex("session_token_hash_unique").on(table.tokenHash),
    index("session_account_id_idx").on(table.accountId),
  ],
);

/**
 * A participating vendor or team.
 *
 * `name` is deliberately not unique. Two teams from one company are two organisations,
 * and refusing the second would push them into one shared record with one shared
 * membership list. The event view shows the owning organisation beside every system, so
 * a reader can tell two same-named entries apart (spec edge case).
 */
export const organisation = pgTable("organisation", {
  ...primaryId(),
  name: text("name").notNull(),
  ...timestamps(),
});

/**
 * Who belongs to an organisation.
 *
 * Every member has the same rights over it (FR-005): manage its systems, answer its
 * pairings, read the contacts addressed to it. There is no owner role, because a single
 * owner is the person who goes on leave the week of the connectathon - and because the
 * spec's answer to an organisation with no members is an admin reassignment rather than
 * a preserved owner.
 *
 * `created_at` is the joined date the organisation page shows.
 */
export const organisationMember = pgTable(
  "organisation_member",
  {
    ...primaryId(),
    organisationId: uuid("organisation_id")
      .notNull()
      .references(() => organisation.id),
    accountId: uuid("account_id")
      .notNull()
      .references(() => account.id),
    ...createdAt(),
  },
  (table) => [
    uniqueIndex("organisation_member_unique").on(
      table.organisationId,
      table.accountId,
    ),
    // "Which organisations may this account manage?", asked on every console request.
    index("organisation_member_account_id_idx").on(table.accountId),
  ],
);

/**
 * An organisation's entry: a server, a client, or both.
 *
 * The profiles are `jsonb` rather than columns because they are two closed shapes
 * validated by Zod at the boundary (`serverProfileSchema`, `clientProfileSchema`), and
 * flattening them would put a dozen mostly-null columns on every row and turn "is this a
 * server?" into a question about which of them happen to be set.
 */
export const system = pgTable(
  "system",
  {
    ...primaryId(),
    organisationId: uuid("organisation_id")
      .notNull()
      .references(() => organisation.id),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    serverProfile: jsonb("server_profile").$type<ServerProfile>(),
    clientProfile: jsonb("client_profile").$type<ClientProfile>(),
    ...timestamps(),
  },
  (table) => [
    index("system_organisation_id_idx").on(table.organisationId),
    check(
      "system_has_a_profile",
      sql`${table.serverProfile} is not null or ${table.clientProfile} is not null`,
    ),
  ],
);

/**
 * A connectathon.
 *
 * `capability_tags` is an array on the event rather than a table of tags, because the
 * tags are defined per event and have no life outside one (FR-008): "form renderer host"
 * in September 2026 and the same string in December 2025 are two independent labels, and
 * a shared tag table would invite them to be merged.
 */
export const event = pgTable(
  "event",
  {
    ...primaryId(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    startsOn: date("starts_on").notNull(),
    endsOn: date("ends_on").notNull(),
    status: eventStatusEnum("status").notNull().default("draft"),
    capabilityTags: text("capability_tags").array().notNull().default([]),
    personaSourceUrl: text("persona_source_url"),
    graceDays: integer("grace_days").notNull().default(7),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex("event_slug_unique").on(table.slug),
    check("event_dates_ordered", sql`${table.endsOn} >= ${table.startsOn}`),
  ],
);

/**
 * A system's participation in one event (FR-009).
 *
 * `confirmed_at` and `confirmed_by` are the point of the row rather than metadata: an
 * enrolment is a participant saying "these details are current as of now", which is
 * exactly what the Confluence table could never record.
 *
 * Only enrolled systems appear in event views, exports and checks - so a system enrolled
 * last December and not this September is absent from this September (scenario 7).
 */
export const enrolment = pgTable(
  "enrolment",
  {
    ...primaryId(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => event.id),
    systemId: uuid("system_id")
      .notNull()
      .references(() => system.id),
    tags: text("tags").array().notNull().default([]),
    confirmedAt: instant("confirmed_at").notNull(),
    confirmedBy: uuid("confirmed_by")
      .notNull()
      .references(() => account.id),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex("enrolment_event_id_system_id_unique").on(
      table.eventId,
      table.systemId,
    ),
    // "Where is this system enrolled?", asked by the organisation page.
    index("enrolment_system_id_idx").on(table.systemId),
  ],
);

/** A row of `account` as selected. */
export type AccountRow = typeof account.$inferSelect;
/** A row of `account_token` as selected. */
export type AccountTokenRow = typeof accountToken.$inferSelect;
/** A row of `session` as selected. */
export type SessionRow = typeof session.$inferSelect;
/** A row of `organisation` as selected. */
export type OrganisationRow = typeof organisation.$inferSelect;
/** A row of `organisation_member` as selected. */
export type OrganisationMemberRow = typeof organisationMember.$inferSelect;
/** A row of `system` as selected. */
export type SystemRow = typeof system.$inferSelect;
/** A row of `event` as selected. */
export type EventRow = typeof event.$inferSelect;
/** A row of `enrolment` as selected. */
export type EnrolmentRow = typeof enrolment.$inferSelect;
