import {
  arrayLiteral,
  asDay,
  asJson,
  asOptionalText,
  asStrings,
  jsonParameter,
  queryRows,
} from "./rows.ts";

import type { RawRow } from "./rows.ts";
import type { AccountStatus, EventStatus } from "@muster/contracts";
import type { SQL } from "bun";

/**
 * Directory data access: accounts, tokens, sessions, organisations, systems,
 * events and enrolments.
 *
 * Every query lives here rather than in a route handler, and every function
 * takes the connection as its first argument, so a suite hands it a scratch
 * schema and the server hands it the serving role's pool.
 *
 * Two shapes recur. Rows come back with the column names Postgres holds, so a
 * mapper per table turns them into the camel-case types the rest of Muster
 * uses. Text arrays are passed as an array literal with an explicit cast,
 * because the driver renders a JavaScript array as a bare comma-separated list
 * that Postgres will not read as an array.
 *
 * @author John Grimes
 */

/** An account as stored. */
export type AccountRow = {
  /** primary key */
  readonly id: string;
  /** the case-folded address */
  readonly email: string;
  /** the name shown to other members */
  readonly displayName: string;
  /** the argon2id hash; never logged or returned */
  readonly passwordHash: string;
  /** when the address was verified, null when it has not been */
  readonly emailVerifiedAt: Date | null;
  /** the lifecycle status */
  readonly status: AccountStatus;
  /** whether the account holds the track admin role */
  readonly isAdmin: boolean;
  /** the admin who approved the account */
  readonly approvedBy: string | null;
  /** when the account was approved */
  readonly approvedAt: Date | null;
};

/** An account to create. */
export type NewAccount = {
  /** the address, folded on the way in */
  readonly email: string;
  /** the name shown to other members */
  readonly displayName: string;
  /** the argon2id hash */
  readonly passwordHash: string;
  /** whether the account holds the track admin role; defaults to false */
  readonly isAdmin?: boolean;
};

/** What a single-use token is for. */
export type AccountTokenPurpose = "emailVerification" | "passwordReset";

/** A single-use token as stored. */
export type AccountTokenRow = {
  /** primary key */
  readonly id: string;
  /** the account the token belongs to */
  readonly accountId: string;
  /** what the token is for */
  readonly purpose: AccountTokenPurpose;
  /** when the token stops being usable */
  readonly expiresAt: Date;
  /** when the token was spent, null while unused */
  readonly usedAt: Date | null;
};

/** A token to create. */
export type NewAccountToken = {
  /** the account the token belongs to */
  readonly accountId: string;
  /** the token's digest; the token itself is never stored */
  readonly tokenHash: string;
  /** what the token is for */
  readonly purpose: AccountTokenPurpose;
  /** when the token stops being usable */
  readonly expiresAt: Date;
};

/** A session to create. */
export type NewSession = {
  /** the account signing in */
  readonly accountId: string;
  /** the opaque token's digest */
  readonly tokenHash: string;
  /** when the session stops being usable */
  readonly expiresAt: Date;
};

/** An organisation as stored. */
export type OrganisationRow = {
  /** primary key */
  readonly id: string;
  /** the organisation's name, which is not unique */
  readonly name: string;
};

/** A member's contact details, for the members-only view. */
export type OrganisationContact = {
  /** the member's account */
  readonly accountId: string;
  /** the member's name */
  readonly displayName: string;
  /** the member's address */
  readonly email: string;
};

/** One organisation an account belongs to. */
export type Membership = {
  /** the organisation */
  readonly organisationId: string;
  /** the organisation's name */
  readonly name: string;
};

/** A system as stored. Profiles are validated at the route boundary. */
export type SystemRow = {
  /** primary key */
  readonly id: string;
  /** the owning organisation */
  readonly organisationId: string;
  /** the system's name */
  readonly name: string;
  /** free text describing the system */
  readonly description: string;
  /** the server profile, null when the system is not a server */
  readonly serverProfile: unknown;
  /** the client profile, null when the system is not a client */
  readonly clientProfile: unknown;
};

/** A system to create. */
export type NewSystem = {
  /** the owning organisation */
  readonly organisationId: string;
  /** the system's name */
  readonly name: string;
  /** free text describing the system */
  readonly description: string;
  /** the server profile, or null */
  readonly serverProfile: unknown;
  /** the client profile, or null */
  readonly clientProfile: unknown;
};

/** Fields a system edit may change; an absent field is left alone. */
export type SystemPatch = {
  /** the system's name */
  readonly name?: string;
  /** free text describing the system */
  readonly description?: string;
  /** the server profile, or null to clear it */
  readonly serverProfile?: unknown;
  /** the client profile, or null to clear it */
  readonly clientProfile?: unknown;
};

/** An event as stored. */
export type EventRow = {
  /** primary key */
  readonly id: string;
  /** the URL-safe identifier */
  readonly slug: string;
  /** the event's name */
  readonly name: string;
  /** the first day, as `YYYY-MM-DD` */
  readonly startsOn: string;
  /** the last day, as `YYYY-MM-DD` */
  readonly endsOn: string;
  /** the lifecycle status */
  readonly status: EventStatus;
  /** the capability tags this event defines */
  readonly capabilityTags: readonly string[];
  /** the FHIR base URL personas are curated from */
  readonly personaSourceUrl: string | null;
  /** days beyond the end that vouching artefacts may live */
  readonly graceDays: number;
};

/** An event to create. */
export type NewEvent = {
  /** the URL-safe identifier */
  readonly slug: string;
  /** the event's name */
  readonly name: string;
  /** the first day, as `YYYY-MM-DD` */
  readonly startsOn: string;
  /** the last day, as `YYYY-MM-DD` */
  readonly endsOn: string;
  /** the lifecycle status; defaults to draft */
  readonly status?: EventStatus;
  /** the capability tags this event defines */
  readonly capabilityTags?: readonly string[];
  /** the FHIR base URL personas are curated from */
  readonly personaSourceUrl?: string | null;
  /** days beyond the end that vouching artefacts may live */
  readonly graceDays?: number;
};

/** Fields an event edit may change; an absent field is left alone. */
export type EventPatch = {
  /** the event's name */
  readonly name?: string;
  /** the first day, as `YYYY-MM-DD` */
  readonly startsOn?: string;
  /** the last day, as `YYYY-MM-DD` */
  readonly endsOn?: string;
  /** the lifecycle status */
  readonly status?: EventStatus;
  /** the capability tags this event defines */
  readonly capabilityTags?: readonly string[];
  /** the FHIR base URL personas are curated from */
  readonly personaSourceUrl?: string | null;
  /** days beyond the end that vouching artefacts may live */
  readonly graceDays?: number;
};

/** An enrolment as stored. */
export type EnrolmentRow = {
  /** primary key */
  readonly id: string;
  /** the event enrolled into */
  readonly eventId: string;
  /** the system enrolled */
  readonly systemId: string;
  /** the capability tags claimed, drawn from the event's set */
  readonly tags: readonly string[];
  /** when the details were last confirmed current */
  readonly confirmedAt: Date;
  /** the account that confirmed them */
  readonly confirmedBy: string;
};

/** An enrolment to create. */
export type NewEnrolment = {
  /** the event enrolled into */
  readonly eventId: string;
  /** the system enrolled */
  readonly systemId: string;
  /** the capability tags claimed */
  readonly tags: readonly string[];
  /** the account confirming the details */
  readonly confirmedBy: string;
};

/** A fresh confirmation of an existing enrolment. */
export type Reconfirmation = {
  /** the enrolment */
  readonly id: string;
  /** the capability tags claimed */
  readonly tags: readonly string[];
  /** the account confirming the details */
  readonly confirmedBy: string;
};

/** An enrolled system with everything an event view shows. */
export type EnrolledSystemRow = {
  /** the enrolment */
  readonly enrolmentId: string;
  /** the capability tags claimed */
  readonly tags: readonly string[];
  /** when the details were last confirmed current */
  readonly confirmedAt: Date;
  /** the system */
  readonly system: SystemRow;
  /** the owning organisation */
  readonly organisation: OrganisationRow;
};

/** An admin's decision about an account's status. */
export type StatusDecision = {
  /** the account decided about */
  readonly accountId: string;
  /** the status to move to */
  readonly status: AccountStatus;
  /** the admin deciding */
  readonly decidedBy: string;
  /** when they decided */
  readonly decidedAt: Date;
};

/** The event and system an enrolment joins. */
type EnrolmentKey = {
  /** the event */
  readonly eventId: string;
  /** the system */
  readonly systemId: string;
};

/** A token being spent. */
type TokenSpend = {
  /** the token */
  readonly id: string;
  /** when it was spent */
  readonly at: Date;
};

/** An organisation to create. */
type NewOrganisation = {
  /** the name to create it under */
  readonly name: string;
};

/** An organisation and one of its members. */
type MembershipKey = {
  /** the organisation */
  readonly organisationId: string;
  /** the account */
  readonly accountId: string;
};

/**
 * Maps an account row.
 *
 * @param row - the row as the driver returned it
 * @returns the account
 */
const toAccount = (row: RawRow): AccountRow => ({
  id: String(row["id"]),
  email: String(row["email"]),
  displayName: String(row["display_name"]),
  passwordHash: String(row["password_hash"]),
  emailVerifiedAt: (row["email_verified_at"] as Date | null) ?? null,
  status: row["status"] as AccountStatus,
  isAdmin: row["is_admin"] === true,
  approvedBy: asOptionalText(row["approved_by"]),
  approvedAt: (row["approved_at"] as Date | null) ?? null,
});

/**
 * Maps a token row.
 *
 * @param row - the row as the driver returned it
 * @returns the token
 */
const toAccountToken = (row: RawRow): AccountTokenRow => ({
  id: String(row["id"]),
  accountId: String(row["account_id"]),
  purpose: row["purpose"] as AccountTokenPurpose,
  expiresAt: row["expires_at"] as Date,
  usedAt: (row["used_at"] as Date | null) ?? null,
});

/**
 * Maps a system row.
 *
 * @param row - the row as the driver returned it
 * @returns the system
 */
const toSystem = (row: RawRow): SystemRow => ({
  id: String(row["id"]),
  organisationId: String(row["organisation_id"]),
  name: String(row["name"]),
  description: String(row["description"]),
  serverProfile: asJson(row["server_profile"]),
  clientProfile: asJson(row["client_profile"]),
});

/**
 * Maps an event row.
 *
 * @param row - the row as the driver returned it
 * @returns the event
 */
const toEvent = (row: RawRow): EventRow => ({
  id: String(row["id"]),
  slug: String(row["slug"]),
  name: String(row["name"]),
  startsOn: asDay(row["starts_on"]),
  endsOn: asDay(row["ends_on"]),
  status: row["status"] as EventStatus,
  capabilityTags: asStrings(row["capability_tags"]),
  personaSourceUrl: asOptionalText(row["persona_source_url"]),
  graceDays: Number(row["grace_days"]),
});

/**
 * Maps an enrolment row.
 *
 * @param row - the row as the driver returned it
 * @returns the enrolment
 */
const toEnrolment = (row: RawRow): EnrolmentRow => ({
  id: String(row["id"]),
  eventId: String(row["event_id"]),
  systemId: String(row["system_id"]),
  tags: asStrings(row["tags"]),
  confirmedAt: row["confirmed_at"] as Date,
  confirmedBy: String(row["confirmed_by"]),
});

/**
 * Maps a joined enrolment, system and organisation row.
 *
 * @param row - the row as the driver returned it
 * @returns the enrolled system
 */
const toEnrolledSystem = (row: RawRow): EnrolledSystemRow => ({
  enrolmentId: String(row["enrolment_id"]),
  tags: asStrings(row["tags"]),
  confirmedAt: row["confirmed_at"] as Date,
  system: toSystem(row),
  organisation: {
    id: String(row["organisation_id"]),
    name: String(row["organisation_name"]),
  },
});

/**
 * Creates an account.
 *
 * The address is folded to lower case here, so the unique constraint is the
 * whole rule and no caller has to remember it.
 *
 * @param sql - a connection
 * @param account - the account to create
 * @returns the created account
 * @throws {Error} when the address is already held; classify with
 *   {@link isUniqueViolation}
 * @example
 * ```ts
 * const account = await insertAccount(sql, {
 *   email: "owner@example.org",
 *   displayName: "Server Owner",
 *   passwordHash: await Bun.password.hash(password, "argon2id"),
 * });
 * ```
 */
export const insertAccount = async (
  sql: SQL,
  account: NewAccount,
): Promise<AccountRow> => {
  const rows =
    await queryRows(sql`insert into account (email, display_name, password_hash, is_admin)
    values (${account.email.trim().toLowerCase()}, ${account.displayName},
            ${account.passwordHash}, ${account.isAdmin ?? false})
    returning *`);
  return toAccount(rows[0]);
};

/**
 * Finds an account by its identifier.
 *
 * @param sql - a connection
 * @param id - the account identifier
 * @returns the account, or undefined when there is none
 */
export const findAccountById = async (
  sql: SQL,
  id: string,
): Promise<AccountRow | undefined> => {
  const rows = await queryRows(sql`select * from account where id = ${id}`);
  return rows.length === 0 ? undefined : toAccount(rows[0]);
};

/**
 * Finds an account by its address, in any case.
 *
 * @param sql - a connection
 * @param email - the address
 * @returns the account, or undefined when there is none
 * @example
 * ```ts
 * const account = await findAccountByEmail(sql, "Owner@Example.org");
 * ```
 */
export const findAccountByEmail = async (
  sql: SQL,
  email: string,
): Promise<AccountRow | undefined> => {
  const rows = await queryRows(
    sql`select * from account where email = ${email.trim().toLowerCase()}`,
  );
  return rows.length === 0 ? undefined : toAccount(rows[0]);
};

/**
 * Lists the accounts holding a status, oldest first.
 *
 * @param sql - a connection
 * @param status - the status to list
 * @returns the accounts, which is the admin approval queue for `pending`
 */
export const listAccountsByStatus = async (
  sql: SQL,
  status: AccountStatus,
): Promise<AccountRow[]> => {
  const rows = await queryRows(
    sql`select * from account where status = ${status}::account_status order by created_at`,
  );
  return rows.map(toAccount);
};

/**
 * Lists the track admins.
 *
 * Used to notify them that an account is awaiting approval (FR-003), so it
 * lists only admins who could act on it: approved, with a verified address.
 *
 * @param sql - a connection
 * @returns the admin accounts
 */
export const listNotifiableAdmins = async (sql: SQL): Promise<AccountRow[]> => {
  const rows = await queryRows(sql`select * from account
    where is_admin = true and status = 'approved' and email_verified_at is not null
    order by created_at`);
  return rows.map(toAccount);
};

/**
 * Records that an address was verified.
 *
 * @param sql - a connection
 * @param accountId - the account
 * @param at - when it was verified
 * @returns the updated account, or undefined when there is no such account
 */
export const markAccountVerified = async (
  sql: SQL,
  accountId: string,
  at: Date,
): Promise<AccountRow | undefined> => {
  const rows = await queryRows(sql`update account
    set email_verified_at = ${at}, updated_at = now()
    where id = ${accountId}
    returning *`);
  return rows.length === 0 ? undefined : toAccount(rows[0]);
};

/**
 * Applies an admin's status decision.
 *
 * The approval audit is written when the account becomes approved and left
 * alone otherwise: it records what happened, not what is currently true, so a
 * later revocation does not erase who approved the account.
 *
 * @param sql - a connection
 * @param decision - the account, the new status, and who decided when
 * @returns the updated account, or undefined when there is no such account
 * @example
 * ```ts
 * await updateAccountStatus(sql, {
 *   accountId,
 *   status: "approved",
 *   decidedBy: admin.id,
 *   decidedAt: new Date(),
 * });
 * ```
 */
export const updateAccountStatus = async (
  sql: SQL,
  decision: StatusDecision,
): Promise<AccountRow | undefined> => {
  const approving = decision.status === "approved";
  const rows = await queryRows(sql`update account set
      status = ${decision.status}::account_status,
      approved_by = case when ${approving} then ${decision.decidedBy}::uuid else approved_by end,
      approved_at = case when ${approving} then ${decision.decidedAt}::timestamptz else approved_at end,
      updated_at = now()
    where id = ${decision.accountId}
    returning *`);
  return rows.length === 0 ? undefined : toAccount(rows[0]);
};

/**
 * Creates a single-use token.
 *
 * @param sql - a connection
 * @param token - the account, the token's digest, its purpose and its expiry
 * @returns the created token
 */
export const insertAccountToken = async (
  sql: SQL,
  token: NewAccountToken,
): Promise<AccountTokenRow> => {
  const rows =
    await queryRows(sql`insert into account_token (account_id, token_hash, purpose, expires_at)
    values (${token.accountId}, ${token.tokenHash},
            ${token.purpose}::account_token_purpose, ${token.expiresAt})
    returning *`);
  return toAccountToken(rows[0]);
};

/**
 * Finds a single-use token by its digest.
 *
 * @param sql - a connection
 * @param tokenHash - the digest of the token the caller presented
 * @returns the token, or undefined when the digest matches none
 */
export const findAccountTokenByHash = async (
  sql: SQL,
  tokenHash: string,
): Promise<AccountTokenRow | undefined> => {
  const rows = await queryRows(
    sql`select * from account_token where token_hash = ${tokenHash}`,
  );
  return rows.length === 0 ? undefined : toAccountToken(rows[0]);
};

/**
 * Records that a token was spent, which is what makes it single use.
 *
 * @param sql - a connection
 * @param spend - the token and when it was spent
 * @returns nothing
 */
export const markAccountTokenUsed = async (
  sql: SQL,
  spend: TokenSpend,
): Promise<void> => {
  await sql`update account_token set used_at = ${spend.at}, updated_at = now()
    where id = ${spend.id} and used_at is null`;
};

/**
 * Creates a session.
 *
 * @param sql - a connection
 * @param session - the account, the token's digest and the expiry
 * @returns nothing
 */
export const insertSession = async (
  sql: SQL,
  session: NewSession,
): Promise<void> => {
  await sql`insert into session (account_id, token_hash, expires_at)
    values (${session.accountId}, ${session.tokenHash}, ${session.expiresAt})`;
};

/**
 * Finds the account behind a live session token.
 *
 * An expired session is no session: the expiry is applied in the query, so no
 * caller can forget it.
 *
 * @param sql - a connection
 * @param tokenHash - the digest of the token in the cookie
 * @param now - the current instant
 * @returns the account, or undefined when the session is unknown or expired
 */
export const findAccountBySessionToken = async (
  sql: SQL,
  tokenHash: string,
  now: Date,
): Promise<AccountRow | undefined> => {
  const rows = await queryRows(sql`select account.* from session
    join account on account.id = session.account_id
    where session.token_hash = ${tokenHash} and session.expires_at > ${now}`);
  return rows.length === 0 ? undefined : toAccount(rows[0]);
};

/**
 * Ends a session.
 *
 * @param sql - a connection
 * @param tokenHash - the digest of the token in the cookie
 * @returns nothing
 */
export const deleteSession = async (
  sql: SQL,
  tokenHash: string,
): Promise<void> => {
  await sql`delete from session where token_hash = ${tokenHash}`;
};

/**
 * Creates an organisation.
 *
 * @param sql - a connection
 * @param organisation - the name to create it under
 * @returns the created organisation
 */
export const insertOrganisation = async (
  sql: SQL,
  organisation: NewOrganisation,
): Promise<OrganisationRow> => {
  const rows = await queryRows(
    sql`insert into organisation (name) values (${organisation.name}) returning id, name`,
  );
  return { id: String(rows[0]["id"]), name: String(rows[0]["name"]) };
};

/**
 * Finds an organisation by its identifier.
 *
 * @param sql - a connection
 * @param id - the organisation identifier
 * @returns the organisation, or undefined when there is none
 */
export const findOrganisationById = async (
  sql: SQL,
  id: string,
): Promise<OrganisationRow | undefined> => {
  const rows = await queryRows(
    sql`select id, name from organisation where id = ${id}`,
  );
  return rows.length === 0
    ? undefined
    : { id: String(rows[0]["id"]), name: String(rows[0]["name"]) };
};

/**
 * Adds a member to an organisation.
 *
 * Membership is a set, so an invitation accepted twice leaves one row rather
 * than failing: the second call is a no-op.
 *
 * @param sql - a connection
 * @param membership - the organisation and the account
 * @returns nothing
 */
export const insertOrganisationMember = async (
  sql: SQL,
  membership: MembershipKey,
): Promise<void> => {
  await sql`insert into organisation_member (organisation_id, account_id)
    values (${membership.organisationId}, ${membership.accountId})
    on conflict (organisation_id, account_id) do nothing`;
};

/**
 * Removes a member from an organisation.
 *
 * The organisation and its systems survive: the spec's edge case is that the
 * last member leaving makes the organisation unmanageable until an admin
 * reassigns it, not that anything is deleted.
 *
 * @param sql - a connection
 * @param membership - the organisation and the account
 * @returns whether a membership went
 */
export const deleteOrganisationMember = async (
  sql: SQL,
  membership: MembershipKey,
): Promise<boolean> => {
  const rows = await queryRows(sql`delete from organisation_member
    where organisation_id = ${membership.organisationId}
      and account_id = ${membership.accountId}
    returning id`);
  return rows.length > 0;
};

/**
 * Lists an organisation's members with their contact details.
 *
 * This is the members-only feed: nothing it returns may reach an anonymous
 * caller (FR-007).
 *
 * @param sql - a connection
 * @param organisationId - the organisation
 * @returns the contacts, by name
 */
export const listOrganisationContacts = async (
  sql: SQL,
  organisationId: string,
): Promise<OrganisationContact[]> => {
  const rows =
    await queryRows(sql`select account.id, account.display_name, account.email
    from organisation_member
    join account on account.id = organisation_member.account_id
    where organisation_member.organisation_id = ${organisationId}
    order by account.display_name`);
  return rows.map((row: RawRow) => ({
    accountId: String(row["id"]),
    displayName: String(row["display_name"]),
    email: String(row["email"]),
  }));
};

/**
 * Lists the organisations an account belongs to.
 *
 * @param sql - a connection
 * @param accountId - the account
 * @returns the memberships, by organisation name
 */
export const listMembershipsForAccount = async (
  sql: SQL,
  accountId: string,
): Promise<Membership[]> => {
  const rows = await queryRows(sql`select organisation.id, organisation.name
    from organisation_member
    join organisation on organisation.id = organisation_member.organisation_id
    where organisation_member.account_id = ${accountId}
    order by organisation.name`);
  return rows.map((row: RawRow) => ({
    organisationId: String(row["id"]),
    name: String(row["name"]),
  }));
};

/**
 * Creates a system.
 *
 * @param sql - a connection
 * @param system - the owning organisation, the name, and the profiles
 * @returns the created system
 * @throws {Error} when neither profile is present; classify with
 *   {@link isCheckViolation}
 * @example
 * ```ts
 * await insertSystem(sql, {
 *   organisationId,
 *   name: "MediRecords FHIR",
 *   description: "",
 *   serverProfile: { fhirBaseUrl, authorizationMode: "smart", registrationMode: "manual" },
 *   clientProfile: null,
 * });
 * ```
 */
export const insertSystem = async (
  sql: SQL,
  system: NewSystem,
): Promise<SystemRow> => {
  const rows =
    await queryRows(sql`insert into system (organisation_id, name, description, server_profile, client_profile)
    values (${system.organisationId}, ${system.name}, ${system.description},
            ${jsonParameter(system.serverProfile)}::jsonb,
            ${jsonParameter(system.clientProfile)}::jsonb)
    returning *`);
  return toSystem(rows[0]);
};

/**
 * Edits a system.
 *
 * The row is read, merged and written, so an absent field is left alone and an
 * explicit null clears a profile - which the schema refuses if it would leave
 * the system as neither a server nor a client.
 *
 * @param sql - a connection
 * @param id - the system identifier
 * @param patch - the fields to change
 * @returns the updated system, or undefined when there is no such system
 * @throws {Error} when the edit would leave no profile
 */
export const updateSystem = async (
  sql: SQL,
  id: string,
  patch: SystemPatch,
): Promise<SystemRow | undefined> => {
  const existing = await findSystemById(sql, id);
  if (existing === undefined) {
    return undefined;
  }
  const serverProfile =
    patch.serverProfile === undefined
      ? existing.serverProfile
      : patch.serverProfile;
  const clientProfile =
    patch.clientProfile === undefined
      ? existing.clientProfile
      : patch.clientProfile;
  const rows = await queryRows(sql`update system set
      name = ${patch.name ?? existing.name},
      description = ${patch.description ?? existing.description},
      server_profile = ${jsonParameter(serverProfile)}::jsonb,
      client_profile = ${jsonParameter(clientProfile)}::jsonb,
      updated_at = now()
    where id = ${id}
    returning *`);
  return rows.length === 0 ? undefined : toSystem(rows[0]);
};

/**
 * Lists the systems one organisation owns.
 *
 * Ordered by name, because this is what the console shows a member and a list
 * whose order changes between reads is a list nobody can scan.
 *
 * @param sql - a connection
 * @param organisationId - the owning organisation
 * @returns the organisation's systems, in name order
 * @example
 * ```ts
 * const systems = await listSystemsByOrganisation(sql, organisationId);
 * ```
 */
export const listSystemsByOrganisation = async (
  sql: SQL,
  organisationId: string,
): Promise<SystemRow[]> => {
  const rows = await queryRows(
    sql`select * from system where organisation_id = ${organisationId} order by name`,
  );
  return rows.map(toSystem);
};

/**
 * Finds a system by its identifier.
 *
 * @param sql - a connection
 * @param id - the system identifier
 * @returns the system, or undefined when there is none
 */
export const findSystemById = async (
  sql: SQL,
  id: string,
): Promise<SystemRow | undefined> => {
  const rows = await queryRows(sql`select * from system where id = ${id}`);
  return rows.length === 0 ? undefined : toSystem(rows[0]);
};

/**
 * Creates an event.
 *
 * @param sql - a connection
 * @param event - the slug, name, dates and capability tags
 * @returns the created event
 * @throws {Error} when the slug is already held; classify with
 *   {@link isUniqueViolation}
 */
export const insertEvent = async (
  sql: SQL,
  event: NewEvent,
): Promise<EventRow> => {
  const rows = await queryRows(sql`insert into event
      (slug, name, starts_on, ends_on, status, capability_tags, persona_source_url, grace_days)
    values (${event.slug}, ${event.name}, ${event.startsOn}::date, ${event.endsOn}::date,
            ${event.status ?? "draft"}::event_status,
            ${arrayLiteral(event.capabilityTags ?? [])}::text[],
            ${event.personaSourceUrl ?? null}, ${event.graceDays ?? defaultGraceDays})
    returning *`);
  return toEvent(rows[0]);
};

/**
 * Edits an event, which is how an admin opens and closes it.
 *
 * @param sql - a connection
 * @param slug - the event's slug
 * @param patch - the fields to change
 * @returns the updated event, or undefined when there is no such event
 * @example
 * ```ts
 * const opened = await updateEvent(sql, "sparked-2026-09", { status: "open" });
 * ```
 */
export const updateEvent = async (
  sql: SQL,
  slug: string,
  patch: EventPatch,
): Promise<EventRow | undefined> => {
  const existing = await findEventBySlug(sql, slug);
  if (existing === undefined) {
    return undefined;
  }
  const personaSourceUrl =
    patch.personaSourceUrl === undefined
      ? existing.personaSourceUrl
      : patch.personaSourceUrl;
  const rows = await queryRows(sql`update event set
      name = ${patch.name ?? existing.name},
      starts_on = ${patch.startsOn ?? existing.startsOn}::date,
      ends_on = ${patch.endsOn ?? existing.endsOn}::date,
      status = ${patch.status ?? existing.status}::event_status,
      capability_tags = ${arrayLiteral(patch.capabilityTags ?? existing.capabilityTags)}::text[],
      persona_source_url = ${personaSourceUrl},
      grace_days = ${patch.graceDays ?? existing.graceDays},
      updated_at = now()
    where slug = ${slug}
    returning *`);
  return rows.length === 0 ? undefined : toEvent(rows[0]);
};

/**
 * Finds an event by its slug.
 *
 * @param sql - a connection
 * @param slug - the event's slug
 * @returns the event, or undefined when there is none
 */
export const findEventBySlug = async (
  sql: SQL,
  slug: string,
): Promise<EventRow | undefined> => {
  const rows = await queryRows(sql`select * from event where slug = ${slug}`);
  return rows.length === 0 ? undefined : toEvent(rows[0]);
};

/**
 * Finds an event by its identifier.
 *
 * The routes addressed to an enrolment rather than to an event start here: an
 * enrolment names its event by identifier, and the event's status and its grace
 * days are what decide whether anything may be vouched for in it.
 *
 * @param sql - a connection
 * @param id - the event's identifier
 * @returns the event, or undefined when there is none
 * @example
 * ```ts
 * const event = await findEventById(sql, enrolment.eventId);
 * ```
 */
export const findEventById = async (
  sql: SQL,
  id: string,
): Promise<EventRow | undefined> => {
  const rows = await queryRows(sql`select * from event where id = ${id}`);
  return rows.length === 0 ? undefined : toEvent(rows[0]);
};

/**
 * Lists the events, the ones starting soonest last.
 *
 * @param sql - a connection
 * @returns the events, newest first
 */
export const listEvents = async (sql: SQL): Promise<EventRow[]> => {
  const rows = await queryRows(
    sql`select * from event order by starts_on desc, slug`,
  );
  return rows.map(toEvent);
};

/**
 * Enrols a system into an event.
 *
 * @param sql - a connection
 * @param enrolment - the event, the system, the tags and who confirmed
 * @returns the created enrolment
 * @throws {Error} when the system is already enrolled in the event (classify
 *   with {@link isUniqueViolation}) or a tag is not one the event defines
 *   (classify with {@link isCheckViolation})
 */
export const insertEnrolment = async (
  sql: SQL,
  enrolment: NewEnrolment,
): Promise<EnrolmentRow> => {
  const rows =
    await queryRows(sql`insert into enrolment (event_id, system_id, tags, confirmed_by)
    values (${enrolment.eventId}, ${enrolment.systemId},
            ${arrayLiteral(enrolment.tags)}::text[], ${enrolment.confirmedBy})
    returning *`);
  return toEnrolment(rows[0]);
};

/**
 * Records a fresh confirmation against an existing enrolment.
 *
 * Re-enrolling a system in an event it is already in is a re-confirmation that
 * its details are current, which is what a returning participant does at the
 * next event.
 *
 * @param sql - a connection
 * @param reconfirmation - the enrolment, its tags, and who confirmed
 * @returns the updated enrolment, or undefined when there is no such enrolment
 * @throws {Error} when a tag is not one the event defines
 */
export const reconfirmEnrolment = async (
  sql: SQL,
  reconfirmation: Reconfirmation,
): Promise<EnrolmentRow | undefined> => {
  const rows = await queryRows(sql`update enrolment set
      tags = ${arrayLiteral(reconfirmation.tags)}::text[],
      confirmed_by = ${reconfirmation.confirmedBy},
      confirmed_at = now(),
      updated_at = now()
    where id = ${reconfirmation.id}
    returning *`);
  return rows.length === 0 ? undefined : toEnrolment(rows[0]);
};

/**
 * Finds a system's enrolment in an event.
 *
 * @param sql - a connection
 * @param key - the event and the system
 * @returns the enrolment, or undefined when the system is not enrolled
 */
export const findEnrolment = async (
  sql: SQL,
  key: EnrolmentKey,
): Promise<EnrolmentRow | undefined> => {
  const rows = await queryRows(sql`select * from enrolment
    where event_id = ${key.eventId} and system_id = ${key.systemId}`);
  return rows.length === 0 ? undefined : toEnrolment(rows[0]);
};

/**
 * Finds an enrolment by its identifier.
 *
 * A pairing names its two sides by their enrolments, so the routes that build one
 * start here: the enrolment says which event it belongs to and which system it
 * enrolled, and both are conditions of the pairing (FR-012).
 *
 * @param sql - a connection
 * @param id - the enrolment
 * @returns the enrolment, or undefined when there is no such enrolment
 * @example
 * ```ts
 * const enrolment = await findEnrolmentById(sql, body.clientEnrolmentId);
 * ```
 */
export const findEnrolmentById = async (
  sql: SQL,
  id: string,
): Promise<EnrolmentRow | undefined> => {
  const rows = await queryRows(sql`select * from enrolment where id = ${id}`);
  return rows.length === 0 ? undefined : toEnrolment(rows[0]);
};

/**
 * Lists the systems enrolled in an event.
 *
 * This is the event view's query, and it is why enrolment exists: a system that
 * is not enrolled does not appear (FR-009, FR-010).
 *
 * @param sql - a connection
 * @param eventId - the event
 * @returns the enrolled systems with their owning organisations, by name
 */
export const listEnrolledSystems = async (
  sql: SQL,
  eventId: string,
): Promise<EnrolledSystemRow[]> => {
  const rows = await queryRows(sql`${enrolledSystemQuery(sql)}
    where enrolment.event_id = ${eventId}
    order by organisation.name, system.name`);
  return rows.map(toEnrolledSystem);
};

/**
 * Finds one enrolled system in an event.
 *
 * @param sql - a connection
 * @param key - the event and the system
 * @returns the enrolled system, or undefined when it is not enrolled
 */
export const findEnrolledSystem = async (
  sql: SQL,
  key: EnrolmentKey,
): Promise<EnrolledSystemRow | undefined> => {
  const rows = await queryRows(sql`${enrolledSystemQuery(sql)}
    where enrolment.event_id = ${key.eventId} and system.id = ${key.systemId}`);
  return rows.length === 0 ? undefined : toEnrolledSystem(rows[0]);
};

/** Days beyond an event's end that vouching artefacts may live, by default. */
const defaultGraceDays = 7;

/**
 * The select and joins shared by the two enrolled-system queries.
 *
 * @param sql - a connection, which builds the fragment
 * @returns the fragment, to be finished with a where clause
 */
const enrolledSystemQuery = (sql: SQL): unknown =>
  sql`select enrolment.id as enrolment_id, enrolment.tags, enrolment.confirmed_at,
             system.id, system.organisation_id, system.name, system.description,
             system.server_profile, system.client_profile,
             organisation.name as organisation_name
      from enrolment
      join system on system.id = enrolment.system_id
      join organisation on organisation.id = system.organisation_id`;
