/**
 * Every read and write the directory makes.
 *
 * Four things are worth knowing before reading further.
 *
 * **The executor comes first, and it is the widened type.** A Drizzle transaction and a
 * Drizzle connection expose the same query surface and are different types, so every
 * function here takes {@link Executor} - the common supertype - and one implementation
 * serves both. A caller composing several of these into one transaction needs no parallel
 * set of functions.
 *
 * **Time is passed in, never read.** Muster resolves one clock at the server boundary
 * (`context.clock()`), and the pure rules that decide expiry take that same instant. A
 * repository that reached for `new Date()` would introduce a second "now" that a test
 * could not pin and that would disagree with the one the rules used.
 *
 * **Refusals that are part of the domain are values, not exceptions.** Two writes here
 * race in a way no amount of looking first can prevent - two sign-ups for one address,
 * two enrolments of one system in one event - so those are attempted and the constraint
 * violation is recognised. The result is a discriminated union the route branches on.
 *
 * **Contact details are selected explicitly or not at all.** `listOrganisationMembers`
 * and `listMemberships` name the columns they read; nothing else in this module selects an
 * address or a password hash into memory. That is constitution principle V held one layer
 * lower than the views that enforce it.
 *
 * Author: John Grimes
 */

import {
  unknownTags as tagsWithoutDefinition,
  acceptsEnrolments,
} from "@muster/core";
import { and, desc, eq, gt, inArray, isNull, lte } from "drizzle-orm";

import { isUniqueViolation } from "./errors.js";
import { firstRow, requireRow } from "./rows.js";
import {
  account,
  accountToken,
  enrolment,
  event,
  organisation,
  organisationMember,
  session,
  system,
} from "../schema/directory.js";

import type { Executor } from "../executor.js";
import type {
  AccountRow,
  AccountTokenRow,
  EnrolmentRow,
  EventRow,
  OrganisationMemberRow,
  OrganisationRow,
  SessionRow,
  SystemRow,
} from "../schema/directory.js";
import type { EventInput, EventPatch, SystemInput } from "@muster/contracts";
import type { AccountStatus } from "@muster/core";

/** What a sign-up supplies. The address must already be case-folded. */
export interface NewAccount {
  readonly email: string;
  readonly displayName: string;
  readonly passwordHash: string;
}

/** The outcome of creating an account. */
export type AccountWrite =
  | { readonly ok: true; readonly account: AccountRow }
  | { readonly ok: false; readonly reason: "email-taken" };

/** The outcome of enrolling a system in an event. */
export type EnrolmentWrite =
  | { readonly ok: true; readonly enrolment: EnrolmentRow }
  | { readonly ok: false; readonly reason: "event-not-open" }
  | {
      readonly ok: false;
      readonly reason: "unknown-tags";
      /** The tags the event does not define, named so the participant can fix them. */
      readonly tags: readonly string[];
    };

/** One person's contact details, as the members-only feed reads them. */
export interface ContactRow {
  readonly accountId: string;
  readonly displayName: string;
  readonly email: string;
  readonly joinedAt: Date;
}

/** One of an account's memberships. */
export interface MembershipRow {
  readonly organisationId: string;
  readonly organisationName: string;
  readonly joinedAt: Date;
}

/** An organisation, attributed to the account that belongs to it. */
export interface AccountOrganisationRow {
  readonly accountId: string;
  readonly organisationId: string;
  readonly organisationName: string;
}

/** An enrolment joined to the system and organisation that own it. */
export interface EnrolledSystemRow {
  readonly enrolment: EnrolmentRow;
  readonly system: SystemRow;
  readonly organisation: OrganisationRow;
}

/** An enrolment joined to the event it is in. */
export interface SystemEnrolmentRow {
  readonly enrolment: EnrolmentRow;
  readonly event: EventRow;
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

/**
 * Creates a pending, unverified account.
 *
 * Attempted rather than checked first: two sign-ups for one address arriving together
 * would both pass a prior lookup, and the unique index is the only thing that decides
 * between them.
 *
 * @param db - The executor.
 * @param input - The address (case-folded), display name and argon2id hash.
 * @returns The account, or that the address is already held.
 * @example
 * ```ts
 * const created = await insertAccount(db, {
 *   email: foldEmail(body.email),
 *   displayName: body.displayName,
 *   passwordHash: await hashPassword(body.password),
 * });
 * ```
 */
export async function insertAccount(
  db: Executor,
  input: NewAccount,
): Promise<AccountWrite> {
  try {
    const rows = await db.insert(account).values(input).returning();
    return { ok: true, account: requireRow(rows, "insert into account") };
  } catch (error) {
    if (isUniqueViolation(error, "account_email_unique")) {
      return { ok: false, reason: "email-taken" };
    }
    throw error;
  }
}

/** The first track admin, or making an existing account one. */
export interface BootstrapAdmin {
  readonly email: string;
  readonly displayName: string;
  readonly passwordHash: string;
  readonly now: Date;
}

/**
 * Creates the first track admin, or grants an existing account that standing.
 *
 * The one write in this module that grants authority without an existing authority to grant it,
 * and it is deliberately not reachable from any route: every route that could create an admin
 * requires being one, so the first one has to come from somewhere else. That somewhere is the
 * `seed` command, which an operator runs against their own database.
 *
 * An existing account keeps its password. Re-running the seed makes somebody an admin; it does not
 * silently reset a credential.
 *
 * @param db - The executor.
 * @param input - The address (case-folded), display name and argon2id hash.
 * @returns The account, and whether this call created it.
 * @example
 * ```ts
 * const { account, created } = await upsertAdminAccount(db, {
 *   email: foldEmail(options.adminEmail),
 *   displayName: options.adminDisplayName,
 *   passwordHash: await hashPassword(options.adminPassword),
 *   now,
 * });
 * ```
 */
export async function upsertAdminAccount(
  db: Executor,
  input: BootstrapAdmin,
): Promise<{ readonly account: AccountRow; readonly created: boolean }> {
  const existing = await findAccountByEmail(db, input.email);
  const created =
    existing === undefined
      ? await insertAccount(db, {
          email: input.email,
          displayName: input.displayName,
          passwordHash: input.passwordHash,
        })
      : { ok: true as const, account: existing };
  if (!created.ok) {
    // Another process created it between the lookup and the insert, which for a seed is a
    // success rather than a collision.
    const raced = await findAccountByEmail(db, input.email);
    if (raced === undefined) {
      throw new Error("the admin account vanished between statements");
    }
    return { account: raced, created: false };
  }

  const rows = await db
    .update(account)
    .set({
      status: "approved",
      isAdmin: true,
      emailVerifiedAt: created.account.emailVerifiedAt ?? input.now,
      approvedAt: created.account.approvedAt ?? input.now,
      updatedAt: input.now,
    })
    .where(eq(account.id, created.account.id))
    .returning();
  return {
    account: requireRow(rows, "update account for the bootstrap admin"),
    created: existing === undefined,
  };
}

/** The account with this identifier. */
export async function findAccountById(
  db: Executor,
  id: string,
): Promise<AccountRow | undefined> {
  return firstRow(
    await db.select().from(account).where(eq(account.id, id)).limit(1),
  );
}

/**
 * The account with this address.
 *
 * @param db - The executor.
 * @param email - The address, already case-folded by the caller.
 */
export async function findAccountByEmail(
  db: Executor,
  email: string,
): Promise<AccountRow | undefined> {
  return firstRow(
    await db.select().from(account).where(eq(account.email, email)).limit(1),
  );
}

/**
 * Every account, or every account in one status, oldest sign-up first.
 *
 * Oldest first because the only reader is the approval queue, and a queue that puts the
 * newest request at the top is one where the person who has waited longest is on page two.
 *
 * @param db - The executor.
 * @param status - The status to filter to, or `undefined` for all of them.
 */
export async function listAccounts(
  db: Executor,
  status?: AccountStatus,
): Promise<readonly AccountRow[]> {
  const rows = db.select().from(account);
  return await (status === undefined
    ? rows.orderBy(account.createdAt)
    : rows.where(eq(account.status, status)).orderBy(account.createdAt));
}

/**
 * The addresses of every admin.
 *
 * The recipients of the awaiting-approval notice (FR-003). Only the address is selected:
 * this is the one place that reads addresses for a reason other than showing them to a
 * member.
 */
export async function listAdminEmails(
  db: Executor,
): Promise<readonly string[]> {
  const rows = await db
    .select({ email: account.email })
    .from(account)
    .where(and(eq(account.isAdmin, true), eq(account.status, "approved")));
  return rows.map((row) => row.email);
}

/**
 * Records that an account proved control of its address.
 *
 * Conditional on it not already being verified, so that a replayed request cannot move
 * the timestamp - and so the caller can tell a first verification from a repeat.
 *
 * @returns The account, or `undefined` when it was already verified or does not exist.
 */
export async function markEmailVerified(
  db: Executor,
  accountId: string,
  now: Date,
): Promise<AccountRow | undefined> {
  return firstRow(
    await db
      .update(account)
      .set({ emailVerifiedAt: now, updatedAt: now })
      .where(and(eq(account.id, accountId), isNull(account.emailVerifiedAt)))
      .returning(),
  );
}

/** An admin's decision about an account's standing. */
export interface AccountStatusChange {
  readonly accountId: string;
  readonly status: AccountStatus;
  /** The admin who decided. Recorded even for a revocation. */
  readonly decidedBy: string;
  readonly now: Date;
}

/**
 * Moves an account to a new status, recording who decided and when.
 *
 * Whether the transition is legal is decided by `canChangeAccountStatus` in
 * `@muster/core` before this is called: the rule is pure and belongs where it can be
 * exhaustively tested.
 *
 * @returns The account, or `undefined` when there is no such account.
 */
export async function setAccountStatus(
  db: Executor,
  change: AccountStatusChange,
): Promise<AccountRow | undefined> {
  return firstRow(
    await db
      .update(account)
      .set({
        status: change.status,
        approvedBy: change.decidedBy,
        approvedAt: change.now,
        updatedAt: change.now,
      })
      .where(eq(account.id, change.accountId))
      .returning(),
  );
}

// ---------------------------------------------------------------------------
// One-shot tokens
// ---------------------------------------------------------------------------

/** A token to store: the digest, never the value that went out in the email. */
export interface NewAccountToken {
  readonly accountId: string;
  readonly purpose: "email_verification" | "password_reset";
  readonly tokenHash: string;
  readonly expiresAt: Date;
}

/** Stores a one-shot token's digest. */
export async function insertAccountToken(
  db: Executor,
  input: NewAccountToken,
): Promise<AccountTokenRow> {
  const rows = await db.insert(accountToken).values(input).returning();
  return requireRow(rows, "insert into account_token");
}

/**
 * The token with this digest.
 *
 * Returned whether or not it is usable. Whether it has been redeemed or has expired is
 * `accountTokenRefusal`'s decision, and the route needs to tell those two apart in order
 * to offer the right thing.
 */
export async function findAccountToken(
  db: Executor,
  tokenHash: string,
): Promise<AccountTokenRow | undefined> {
  return firstRow(
    await db
      .select()
      .from(accountToken)
      .where(eq(accountToken.tokenHash, tokenHash))
      .limit(1),
  );
}

/**
 * Marks a token redeemed.
 *
 * Conditional on it being unredeemed, so two requests carrying the same link cannot both
 * succeed - which is what "single use" has to mean when the link is in a mailbox two
 * people can read.
 *
 * @returns The token, or `undefined` when something had already redeemed it.
 */
export async function markAccountTokenUsed(
  db: Executor,
  id: string,
  now: Date,
): Promise<AccountTokenRow | undefined> {
  return firstRow(
    await db
      .update(accountToken)
      .set({ usedAt: now })
      .where(and(eq(accountToken.id, id), isNull(accountToken.usedAt)))
      .returning(),
  );
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/** A session to store: the cookie's digest, never its value. */
export interface NewSession {
  readonly accountId: string;
  readonly tokenHash: string;
  readonly expiresAt: Date;
}

/** Stores a session's digest. */
export async function insertSession(
  db: Executor,
  input: NewSession,
): Promise<SessionRow> {
  const rows = await db.insert(session).values(input).returning();
  return requireRow(rows, "insert into session");
}

/**
 * The account a live session belongs to.
 *
 * The expiry is part of the predicate rather than something the caller checks afterwards:
 * a session that has expired must not identify anybody, and a two-step version of this
 * would eventually be written the wrong way round somewhere.
 */
export async function findAccountBySessionToken(
  db: Executor,
  tokenHash: string,
  now: Date,
): Promise<AccountRow | undefined> {
  const row = firstRow(
    await db
      .select({ account })
      .from(session)
      .innerJoin(account, eq(account.id, session.accountId))
      .where(and(eq(session.tokenHash, tokenHash), gt(session.expiresAt, now)))
      .limit(1),
  );
  return row?.account;
}

/** Ends one session. */
export async function deleteSession(
  db: Executor,
  tokenHash: string,
): Promise<void> {
  await db.delete(session).where(eq(session.tokenHash, tokenHash));
}

/**
 * Removes every session that has expired.
 *
 * @returns How many were removed, so a scheduled sweep can report what it did.
 */
export async function deleteExpiredSessions(
  db: Executor,
  now: Date,
): Promise<number> {
  const rows = await db
    .delete(session)
    .where(lte(session.expiresAt, now))
    .returning({ id: session.id });
  return rows.length;
}

// ---------------------------------------------------------------------------
// Organisations and their members
// ---------------------------------------------------------------------------

/**
 * Creates an organisation with the caller as its first member.
 *
 * One transaction, because an organisation with no members is exactly the state the spec
 * calls orphaned and treats as needing an admin to repair - so it must not be reachable
 * by a request that failed halfway.
 */
export async function insertOrganisationWithFirstMember(
  db: Executor,
  input: { readonly name: string; readonly accountId: string },
): Promise<OrganisationRow> {
  return await db.transaction(async (tx) => {
    const created = requireRow(
      await tx.insert(organisation).values({ name: input.name }).returning(),
      "insert into organisation",
    );
    await tx
      .insert(organisationMember)
      .values({ organisationId: created.id, accountId: input.accountId });
    return created;
  });
}

/** The organisation with this identifier. */
export async function findOrganisationById(
  db: Executor,
  id: string,
): Promise<OrganisationRow | undefined> {
  return firstRow(
    await db
      .select()
      .from(organisation)
      .where(eq(organisation.id, id))
      .limit(1),
  );
}

/**
 * Adds a member.
 *
 * @returns The membership, or `undefined` when the account was already a member - which
 *   is not an error worth reporting as one, and is how an invitation sent twice behaves.
 */
export async function addOrganisationMember(
  db: Executor,
  input: { readonly organisationId: string; readonly accountId: string },
): Promise<OrganisationMemberRow | undefined> {
  return firstRow(
    await db
      .insert(organisationMember)
      .values(input)
      .onConflictDoNothing()
      .returning(),
  );
}

/**
 * Removes a member.
 *
 * The last member may leave. Their organisation's systems stay enrolled and become
 * unmanageable until an admin reassigns it (spec edge case), which is a worse state than
 * having a member and a better one than losing the entries mid-event.
 *
 * @returns Whether there was a membership to remove.
 */
export async function removeOrganisationMember(
  db: Executor,
  input: { readonly organisationId: string; readonly accountId: string },
): Promise<boolean> {
  const rows = await db
    .delete(organisationMember)
    .where(
      and(
        eq(organisationMember.organisationId, input.organisationId),
        eq(organisationMember.accountId, input.accountId),
      ),
    )
    .returning({ id: organisationMember.id });
  return rows.length > 0;
}

/** Whether this account belongs to this organisation. */
export async function isOrganisationMember(
  db: Executor,
  input: { readonly organisationId: string; readonly accountId: string },
): Promise<boolean> {
  const rows = await db
    .select({ id: organisationMember.id })
    .from(organisationMember)
    .where(
      and(
        eq(organisationMember.organisationId, input.organisationId),
        eq(organisationMember.accountId, input.accountId),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * An organisation's members, with their contact details.
 *
 * The only read in this module that returns an address for display. Its callers are the
 * members-only contacts feed and the caller's own organisation page, both of which the
 * routes gate on an approved session (FR-007).
 */
export async function listOrganisationMembers(
  db: Executor,
  organisationId: string,
): Promise<readonly ContactRow[]> {
  return await db
    .select({
      accountId: account.id,
      displayName: account.displayName,
      email: account.email,
      joinedAt: organisationMember.createdAt,
    })
    .from(organisationMember)
    .innerJoin(account, eq(account.id, organisationMember.accountId))
    .where(eq(organisationMember.organisationId, organisationId))
    .orderBy(organisationMember.createdAt);
}

/** The organisations an account belongs to, as rows, by name. */
export async function listOrganisationsForAccount(
  db: Executor,
  accountId: string,
): Promise<readonly OrganisationRow[]> {
  return await db
    .select({ organisation })
    .from(organisationMember)
    .innerJoin(
      organisation,
      eq(organisation.id, organisationMember.organisationId),
    )
    .where(eq(organisationMember.accountId, accountId))
    .orderBy(organisation.name)
    .then((rows) => rows.map((row) => row.organisation));
}

/** Which organisations an account belongs to. */
export async function listMemberships(
  db: Executor,
  accountId: string,
): Promise<readonly MembershipRow[]> {
  return await db
    .select({
      organisationId: organisation.id,
      organisationName: organisation.name,
      joinedAt: organisationMember.createdAt,
    })
    .from(organisationMember)
    .innerJoin(
      organisation,
      eq(organisation.id, organisationMember.organisationId),
    )
    .where(eq(organisationMember.accountId, accountId))
    .orderBy(organisation.name);
}

/**
 * The organisations several accounts belong to, attributed to each.
 *
 * One query for the whole admin members table rather than one per row: the page lists
 * every account, and a per-row lookup is the shape that is fine with twelve accounts and
 * embarrassing with two hundred.
 */
export async function listOrganisationsForAccounts(
  db: Executor,
  accountIds: readonly string[],
): Promise<readonly AccountOrganisationRow[]> {
  if (accountIds.length === 0) {
    return [];
  }
  return await db
    .select({
      accountId: organisationMember.accountId,
      organisationId: organisation.id,
      organisationName: organisation.name,
    })
    .from(organisationMember)
    .innerJoin(
      organisation,
      eq(organisation.id, organisationMember.organisationId),
    )
    .where(inArray(organisationMember.accountId, [...accountIds]))
    .orderBy(organisation.name);
}

// ---------------------------------------------------------------------------
// Systems
// ---------------------------------------------------------------------------

/** The system columns a participant supplies, in the shape the table stores. */
function systemValues(input: SystemInput) {
  return {
    name: input.name,
    description: input.description,
    serverProfile: input.serverProfile,
    clientProfile: input.clientProfile,
  };
}

/** Creates a system. */
export async function insertSystem(
  db: Executor,
  input: { readonly organisationId: string; readonly system: SystemInput },
): Promise<SystemRow> {
  const rows = await db
    .insert(system)
    .values({
      organisationId: input.organisationId,
      ...systemValues(input.system),
    })
    .returning();
  return requireRow(rows, "insert into system");
}

/**
 * Replaces a system's editable fields.
 *
 * A whole-record write rather than a patch. The console's edit form holds the entire
 * system, and a partial-update path is the second code path nobody exercises - the one
 * that eventually blanks a profile because the caller omitted it.
 *
 * @returns The system, or `undefined` when there is no such system.
 */
export async function updateSystem(
  db: Executor,
  input: {
    readonly systemId: string;
    readonly system: SystemInput;
    readonly now: Date;
  },
): Promise<SystemRow | undefined> {
  return firstRow(
    await db
      .update(system)
      .set({ ...systemValues(input.system), updatedAt: input.now })
      .where(eq(system.id, input.systemId))
      .returning(),
  );
}

/** The system with this identifier. */
export async function findSystemById(
  db: Executor,
  id: string,
): Promise<SystemRow | undefined> {
  return firstRow(
    await db.select().from(system).where(eq(system.id, id)).limit(1),
  );
}

/** An organisation's systems, by name. */
export async function listSystemsForOrganisation(
  db: Executor,
  organisationId: string,
): Promise<readonly SystemRow[]> {
  return await db
    .select()
    .from(system)
    .where(eq(system.organisationId, organisationId))
    .orderBy(system.name);
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** Creates an event. It starts as a draft; opening it is a separate decision. */
export async function insertEvent(
  db: Executor,
  input: EventInput,
): Promise<EventRow> {
  const rows = await db
    .insert(event)
    .values({
      slug: input.slug,
      name: input.name,
      startsOn: input.startsOn,
      endsOn: input.endsOn,
      capabilityTags: [...input.capabilityTags],
      personaSourceUrl: input.personaSourceUrl,
      graceDays: input.graceDays,
    })
    .returning();
  return requireRow(rows, "insert into event");
}

/** The event with this slug. */
export async function findEventBySlug(
  db: Executor,
  slug: string,
): Promise<EventRow | undefined> {
  return firstRow(
    await db.select().from(event).where(eq(event.slug, slug)).limit(1),
  );
}

/** Every event, the one starting soonest first. */
export async function listEvents(db: Executor): Promise<readonly EventRow[]> {
  return await db.select().from(event).orderBy(desc(event.startsOn));
}

/**
 * Changes an event's editable fields.
 *
 * The absent keys of a patch are dropped rather than written, so an edit that named only
 * the status does not blank the capability tags. Whether a status change is legal is
 * `canChangeEventStatus`'s decision, made before this is called.
 *
 * @returns The event, or `undefined` when there is no such event.
 */
export async function updateEvent(
  db: Executor,
  input: {
    readonly slug: string;
    readonly patch: EventPatch;
    readonly now: Date;
  },
): Promise<EventRow | undefined> {
  const { patch } = input;
  return firstRow(
    await db
      .update(event)
      .set({
        ...(patch.name === undefined ? {} : { name: patch.name }),
        ...(patch.startsOn === undefined ? {} : { startsOn: patch.startsOn }),
        ...(patch.endsOn === undefined ? {} : { endsOn: patch.endsOn }),
        ...(patch.capabilityTags === undefined
          ? {}
          : { capabilityTags: [...patch.capabilityTags] }),
        ...(patch.personaSourceUrl === undefined
          ? {}
          : { personaSourceUrl: patch.personaSourceUrl }),
        ...(patch.graceDays === undefined
          ? {}
          : { graceDays: patch.graceDays }),
        ...(patch.status === undefined ? {} : { status: patch.status }),
        updatedAt: input.now,
      })
      .where(eq(event.slug, input.slug))
      .returning(),
  );
}

// ---------------------------------------------------------------------------
// Enrolments
// ---------------------------------------------------------------------------

/** What an enrolment records. */
export interface NewEnrolment {
  /** The event row, so its status and tag set are judged against what was read. */
  readonly event: EventRow;
  readonly systemId: string;
  readonly tags: readonly string[];
  readonly confirmedBy: string;
  readonly confirmedAt: Date;
}

/**
 * Enrols a system, or re-confirms an enrolment that already exists.
 *
 * An upsert rather than a refusal, because a second enrolment request is a participant
 * saying "still current" - which is the whole point of the enrolment record, and what
 * makes re-enrolling at the next event a minute's work (SC-008).
 *
 * Both refusals are enforced here rather than only in the route, so there is one place
 * that decides them: a closed event takes nothing new (FR-011), and a tag the event does
 * not define would appear as a filter chip that matches one row and means nothing
 * (FR-009).
 */
export async function upsertEnrolment(
  db: Executor,
  input: NewEnrolment,
): Promise<EnrolmentWrite> {
  if (!acceptsEnrolments(input.event.status)) {
    return { ok: false, reason: "event-not-open" };
  }
  const undefinedTags = tagsWithoutDefinition(
    input.tags,
    input.event.capabilityTags,
  );
  if (undefinedTags.length > 0) {
    return { ok: false, reason: "unknown-tags", tags: undefinedTags };
  }

  const values = {
    eventId: input.event.id,
    systemId: input.systemId,
    tags: [...input.tags],
    confirmedAt: input.confirmedAt,
    confirmedBy: input.confirmedBy,
  };
  const rows = await db
    .insert(enrolment)
    .values(values)
    .onConflictDoUpdate({
      target: [enrolment.eventId, enrolment.systemId],
      set: {
        tags: values.tags,
        confirmedAt: values.confirmedAt,
        confirmedBy: values.confirmedBy,
        updatedAt: input.confirmedAt,
      },
    })
    .returning();
  return { ok: true, enrolment: requireRow(rows, "upsert into enrolment") };
}

/** The joined selection every enrolment read returns. */
const ENROLLED_SYSTEM_COLUMNS = { enrolment, system, organisation };

/**
 * Every system enrolled in an event, with its owner.
 *
 * Ordered by organisation then system name, because two organisations may hold systems
 * with the same name and grouping them by owner is what lets a reader tell them apart.
 */
export async function listEventEnrolments(
  db: Executor,
  eventId: string,
): Promise<readonly EnrolledSystemRow[]> {
  return await db
    .select(ENROLLED_SYSTEM_COLUMNS)
    .from(enrolment)
    .innerJoin(system, eq(system.id, enrolment.systemId))
    .innerJoin(organisation, eq(organisation.id, system.organisationId))
    .where(eq(enrolment.eventId, eventId))
    .orderBy(organisation.name, system.name);
}

/** One enrolled system in an event, with its owner. */
export async function findEventEnrolment(
  db: Executor,
  input: { readonly eventId: string; readonly systemId: string },
): Promise<EnrolledSystemRow | undefined> {
  return firstRow(
    await db
      .select(ENROLLED_SYSTEM_COLUMNS)
      .from(enrolment)
      .innerJoin(system, eq(system.id, enrolment.systemId))
      .innerJoin(organisation, eq(organisation.id, system.organisationId))
      .where(
        and(
          eq(enrolment.eventId, input.eventId),
          eq(enrolment.systemId, input.systemId),
        ),
      )
      .limit(1),
  );
}

/** Where an organisation's systems are enrolled. */
export async function listEnrolmentsForOrganisation(
  db: Executor,
  organisationId: string,
): Promise<readonly SystemEnrolmentRow[]> {
  return await db
    .select({ enrolment, event })
    .from(enrolment)
    .innerJoin(system, eq(system.id, enrolment.systemId))
    .innerJoin(event, eq(event.id, enrolment.eventId))
    .where(eq(system.organisationId, organisationId))
    .orderBy(desc(event.startsOn));
}
