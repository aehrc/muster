import type { AccountStatus, EventStatus } from "@muster/contracts";
import type { SQL } from "bun";

/**
 * Directory data access: stub surface.
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

/**
 * Creates an account.
 *
 * @param _sql - a connection
 * @param account - the account to create
 * @returns the created account
 */
export const insertAccount = (
  _sql: SQL,
  account: NewAccount,
): Promise<AccountRow> =>
  Promise.resolve({
    id: crypto.randomUUID(),
    email: account.email,
    displayName: account.displayName,
    passwordHash: account.passwordHash,
    emailVerifiedAt: null,
    status: "pending",
    isAdmin: account.isAdmin ?? false,
    approvedBy: null,
    approvedAt: null,
  });

/**
 * Finds an account by its identifier.
 *
 * @param _sql - a connection
 * @param _id - the account identifier
 * @returns the account, or undefined
 */
export const findAccountById = (
  _sql: SQL,
  _id: string,
): Promise<AccountRow | undefined> => Promise.resolve(undefined);

/**
 * Finds an account by its address.
 *
 * @param _sql - a connection
 * @param _email - the address, in any case
 * @returns the account, or undefined
 */
export const findAccountByEmail = (
  _sql: SQL,
  _email: string,
): Promise<AccountRow | undefined> => Promise.resolve(undefined);

/**
 * Lists the accounts holding a status.
 *
 * @param _sql - a connection
 * @param _status - the status to list
 * @returns the accounts
 */
export const listAccountsByStatus = (
  _sql: SQL,
  _status: AccountStatus,
): Promise<AccountRow[]> => Promise.resolve([]);

/**
 * Lists the track admins.
 *
 * @param _sql - a connection
 * @returns the admin accounts
 */
export const listAdminAccounts = (_sql: SQL): Promise<AccountRow[]> =>
  Promise.resolve([]);

/**
 * Records that an address was verified.
 *
 * @param _sql - a connection
 * @param _accountId - the account
 * @param _at - when it was verified
 * @returns the updated account, or undefined
 */
export const markAccountVerified = (
  _sql: SQL,
  _accountId: string,
  _at: Date,
): Promise<AccountRow | undefined> => Promise.resolve(undefined);

/**
 * Applies an admin's status decision.
 *
 * @param _sql - a connection
 * @param _decision - the account, the new status and who decided
 * @returns the updated account, or undefined
 */
export const updateAccountStatus = (
  _sql: SQL,
  _decision: StatusDecision,
): Promise<AccountRow | undefined> => Promise.resolve(undefined);

/**
 * Creates a single-use token.
 *
 * @param _sql - a connection
 * @param token - the token to create
 * @returns the created token
 */
export const insertAccountToken = (
  _sql: SQL,
  token: NewAccountToken,
): Promise<AccountTokenRow> =>
  Promise.resolve({
    id: crypto.randomUUID(),
    accountId: token.accountId,
    purpose: token.purpose,
    expiresAt: token.expiresAt,
    usedAt: null,
  });

/**
 * Finds a single-use token by its digest.
 *
 * @param _sql - a connection
 * @param _tokenHash - the digest
 * @returns the token, or undefined
 */
export const findAccountTokenByHash = (
  _sql: SQL,
  _tokenHash: string,
): Promise<AccountTokenRow | undefined> => Promise.resolve(undefined);

/**
 * Records that a token was spent.
 *
 * @param _sql - a connection
 * @param _spend - the token and when it was spent
 * @returns nothing
 */
export const markAccountTokenUsed = (
  _sql: SQL,
  _spend: { readonly id: string; readonly at: Date },
): Promise<void> => Promise.resolve();

/**
 * Creates a session.
 *
 * @param _sql - a connection
 * @param _session - the session to create
 * @returns nothing
 */
export const insertSession = (_sql: SQL, _session: NewSession): Promise<void> =>
  Promise.resolve();

/**
 * Finds the account behind a live session token.
 *
 * @param _sql - a connection
 * @param _tokenHash - the token's digest
 * @param _now - the current instant
 * @returns the account, or undefined
 */
export const findAccountBySessionToken = (
  _sql: SQL,
  _tokenHash: string,
  _now: Date,
): Promise<AccountRow | undefined> => Promise.resolve(undefined);

/**
 * Ends a session.
 *
 * @param _sql - a connection
 * @param _tokenHash - the token's digest
 * @returns nothing
 */
export const deleteSession = (_sql: SQL, _tokenHash: string): Promise<void> =>
  Promise.resolve();

/**
 * Creates an organisation.
 *
 * @param _sql - a connection
 * @param organisation - the organisation to create
 * @returns the created organisation
 */
export const insertOrganisation = (
  _sql: SQL,
  organisation: { readonly name: string },
): Promise<OrganisationRow> =>
  Promise.resolve({ id: crypto.randomUUID(), name: organisation.name });

/**
 * Finds an organisation by its identifier.
 *
 * @param _sql - a connection
 * @param _id - the organisation identifier
 * @returns the organisation, or undefined
 */
export const findOrganisationById = (
  _sql: SQL,
  _id: string,
): Promise<OrganisationRow | undefined> => Promise.resolve(undefined);

/**
 * Adds a member to an organisation.
 *
 * @param _sql - a connection
 * @param _membership - the organisation and the account
 * @returns nothing
 */
export const insertOrganisationMember = (
  _sql: SQL,
  _membership: {
    readonly organisationId: string;
    readonly accountId: string;
  },
): Promise<void> => Promise.resolve();

/**
 * Removes a member from an organisation.
 *
 * @param _sql - a connection
 * @param _membership - the organisation and the account
 * @returns whether a membership went
 */
export const deleteOrganisationMember = (
  _sql: SQL,
  _membership: {
    readonly organisationId: string;
    readonly accountId: string;
  },
): Promise<boolean> => Promise.resolve(false);

/**
 * Lists an organisation's members with their contact details.
 *
 * @param _sql - a connection
 * @param _organisationId - the organisation
 * @returns the contacts
 */
export const listOrganisationContacts = (
  _sql: SQL,
  _organisationId: string,
): Promise<OrganisationContact[]> => Promise.resolve([]);

/**
 * Lists the organisations an account belongs to.
 *
 * @param _sql - a connection
 * @param _accountId - the account
 * @returns the memberships
 */
export const listMembershipsForAccount = (
  _sql: SQL,
  _accountId: string,
): Promise<Membership[]> => Promise.resolve([]);

/**
 * Creates a system.
 *
 * @param _sql - a connection
 * @param system - the system to create
 * @returns the created system
 */
export const insertSystem = (
  _sql: SQL,
  system: NewSystem,
): Promise<SystemRow> =>
  Promise.resolve({ id: crypto.randomUUID(), ...system });

/**
 * Edits a system.
 *
 * @param _sql - a connection
 * @param _id - the system identifier
 * @param _patch - the fields to change
 * @returns the updated system, or undefined
 */
export const updateSystem = (
  _sql: SQL,
  _id: string,
  _patch: SystemPatch,
): Promise<SystemRow | undefined> => Promise.resolve(undefined);

/**
 * Finds a system by its identifier.
 *
 * @param _sql - a connection
 * @param _id - the system identifier
 * @returns the system, or undefined
 */
export const findSystemById = (
  _sql: SQL,
  _id: string,
): Promise<SystemRow | undefined> => Promise.resolve(undefined);

/**
 * Creates an event.
 *
 * @param _sql - a connection
 * @param event - the event to create
 * @returns the created event
 */
export const insertEvent = (_sql: SQL, event: NewEvent): Promise<EventRow> =>
  Promise.resolve({
    id: crypto.randomUUID(),
    slug: event.slug,
    name: event.name,
    startsOn: event.startsOn,
    endsOn: event.endsOn,
    status: event.status ?? "draft",
    capabilityTags: event.capabilityTags ?? [],
    personaSourceUrl: event.personaSourceUrl ?? null,
    graceDays: event.graceDays ?? 7,
  });

/**
 * Edits an event.
 *
 * @param _sql - a connection
 * @param _slug - the event's slug
 * @param _patch - the fields to change
 * @returns the updated event, or undefined
 */
export const updateEvent = (
  _sql: SQL,
  _slug: string,
  _patch: EventPatch,
): Promise<EventRow | undefined> => Promise.resolve(undefined);

/**
 * Finds an event by its slug.
 *
 * @param _sql - a connection
 * @param _slug - the event's slug
 * @returns the event, or undefined
 */
export const findEventBySlug = (
  _sql: SQL,
  _slug: string,
): Promise<EventRow | undefined> => Promise.resolve(undefined);

/**
 * Lists the events.
 *
 * @param _sql - a connection
 * @returns the events, newest first
 */
export const listEvents = (_sql: SQL): Promise<EventRow[]> =>
  Promise.resolve([]);

/**
 * Enrols a system into an event.
 *
 * @param _sql - a connection
 * @param enrolment - the enrolment to create
 * @returns the created enrolment
 */
export const insertEnrolment = (
  _sql: SQL,
  enrolment: NewEnrolment,
): Promise<EnrolmentRow> =>
  Promise.resolve({
    id: crypto.randomUUID(),
    eventId: enrolment.eventId,
    systemId: enrolment.systemId,
    tags: enrolment.tags,
    confirmedAt: new Date(0),
    confirmedBy: enrolment.confirmedBy,
  });

/**
 * Records a fresh confirmation against an existing enrolment.
 *
 * @param _sql - a connection
 * @param _reconfirmation - the enrolment, its tags and who confirmed
 * @returns the updated enrolment, or undefined
 */
export const reconfirmEnrolment = (
  _sql: SQL,
  _reconfirmation: Reconfirmation,
): Promise<EnrolmentRow | undefined> => Promise.resolve(undefined);

/**
 * Finds a system's enrolment in an event.
 *
 * @param _sql - a connection
 * @param _key - the event and the system
 * @returns the enrolment, or undefined
 */
export const findEnrolment = (
  _sql: SQL,
  _key: { readonly eventId: string; readonly systemId: string },
): Promise<EnrolmentRow | undefined> => Promise.resolve(undefined);

/**
 * Lists the systems enrolled in an event.
 *
 * @param _sql - a connection
 * @param _eventId - the event
 * @returns the enrolled systems
 */
export const listEnrolledSystems = (
  _sql: SQL,
  _eventId: string,
): Promise<EnrolledSystemRow[]> => Promise.resolve([]);

/**
 * Finds one enrolled system in an event.
 *
 * @param _sql - a connection
 * @param _key - the event and the system
 * @returns the enrolled system, or undefined
 */
export const findEnrolledSystem = (
  _sql: SQL,
  _key: { readonly eventId: string; readonly systemId: string },
): Promise<EnrolledSystemRow | undefined> => Promise.resolve(undefined);
