/**
 * What goes into a permission ticket, and when Muster refuses to mint one.
 *
 * This module is the whole of the authorisation decision, and it is pure on purpose. A
 * permission ticket is Muster telling a stranger's data holder "release this patient's
 * record to whoever presents this", so what the claim set says and who is allowed to cause
 * one to exist are decided here, where they can be exhausted by unit tests with no
 * database, no network and no clock of their own (constitution principle II).
 *
 * It is shaped like `../statements/build.ts` beside it, deliberately: the two artefacts are
 * the two things Muster signs, and a reviewer who has read one should recognise the other.
 * Four decisions are worth stating.
 *
 * **The claim names come from the contract, not from convenience.**
 * `contracts/ticket-profile.md` is a vendor-facing contract that Signet's
 * `002-trusted-dcr-tickets` implements against, so the claim vocabulary is centralised in
 * {@link buildPermissionTicketClaims} and nowhere else - which is what `research.md` asks
 * for, so that drift in the SMART Permission Tickets draft is absorbed by one module.
 * Renaming a claim is a breaking change to somebody else's product.
 *
 * **The expiry is capped, not validated.** FR-033 requires a validity no later than the
 * event's end plus its grace, and the way to guarantee that is to compute it rather than to
 * check a number somebody supplied. {@link ticketExpirySeconds} takes the smaller of the
 * event's cap and the day the member asked for, so there is no path by which a longer one
 * could be obtained - a request for a year yields the cap rather than a refusal.
 *
 * The cap is `vouchingExpirySeconds` from the statement builder rather than a second
 * arithmetic of its own, so a ticket and a statement cannot disagree about when an event is
 * over.
 *
 * **The subject is an identifier, never a value on its own.** FR-033 binds the subject by
 * IHI, and a sixteen-digit string with no namespace names nothing: a data holder resolving
 * it would have to guess which of its identifier systems was meant. So the claim carries the
 * system and the value, as the contract's table spells them.
 *
 * **Refusal is the default, and the scopes are constrained.** {@link permissionTicketRefusal}
 * answers "may this ticket exist?" by requiring every one of eight things to hold, in the
 * order the person can act on. The one rule that is Muster's rather than the contract's is
 * {@link isPatientCompartmentScope}: a ticket that says "this patient permits access to
 * their own record" and then carries `system/*.cruds` is not that, whoever asked for it. It
 * constrains what may be minted rather than what the claim vocabulary is, so it costs the
 * contract nothing.
 *
 * Author: John Grimes
 */

import { writeRefusal } from "../accounts/rules.js";
import { vouchingExpirySeconds } from "../statements/build.js";

import type { AccountStanding, WriteRefusal } from "../accounts/rules.js";
import type { EventStatus } from "../events/rules.js";

/**
 * The ticket types Muster mints.
 *
 * One long, and that is the spec's assumption rather than an unfinished list: only the
 * patient self-access type is in scope, and a type nobody has specified is refused rather
 * than passed through into a signed artefact.
 */
export const PERMISSION_TICKET_TYPES = ["patient-self-access"] as const;

/** A ticket type Muster mints. */
export type PermissionTicketType = (typeof PERMISSION_TICKET_TYPES)[number];

/** How the subject is named: a FHIR-style system and value. */
export interface TicketSubjectIdentifier {
  /** The IHI namespace. Configuration for the deployment, not a per-ticket choice. */
  readonly system: string;
  readonly value: string;
}

/** The `subject` claim, as `contracts/ticket-profile.md` shapes it. */
export interface TicketSubject {
  readonly identifier: TicketSubjectIdentifier;
}

/**
 * The claim set of a permission ticket.
 *
 * Exactly the claims `contracts/ticket-profile.md` tabulates, spelled as the contract spells
 * them - snake_case, because they are JWT claims rather than TypeScript fields.
 *
 * A type alias rather than an interface, deliberately: TypeScript gives an alias an implicit
 * index signature and an interface none, and the signing helper takes the claim set as a bag
 * of JWT claims because it signs statements with the same code.
 */
export type PermissionTicketClaims = {
  /** The issuer identifier: Muster's public URL. */
  readonly iss: string;
  /** The ticket identifier, unique across every ticket Muster has minted. */
  readonly jti: string;
  readonly iat: number;
  /** Never later than event end plus the event's grace period. */
  readonly exp: number;
  readonly ticket_type: PermissionTicketType;
  /** The subject, bound by identifier system and value rather than by a local reference. */
  readonly subject: TicketSubject;
  /** Space-separated scope constraints, as chosen at mint. */
  readonly smart_scopes: string;
  /** The event slug the ticket is scoped to. */
  readonly muster_event: string;
};

/** What the claim builder needs. */
export interface PermissionTicketInput {
  /** The issuer identifier. Derived from `MUSTER_PUBLIC_URL`. */
  readonly issuer: string;
  /** The ticket identifier. Generated by the caller, which owns the randomness. */
  readonly jti: string;
  readonly eventSlug: string;
  /** The event's last day, as `YYYY-MM-DD`. */
  readonly eventEndsOn: string;
  /** Days past the event's last day that a ticket may still be good for. */
  readonly graceDays: number;
  readonly ticketType: PermissionTicketType;
  /** The persona's IHI. */
  readonly ihi: string;
  /** The namespace the IHI belongs to. */
  readonly ihiSystem: string;
  readonly scopes: readonly string[];
  /** The last day the member asked for, as `YYYY-MM-DD`, or null for the event's cap. */
  readonly validUntil: string | null;
  readonly now: Date;
}

/** Why Muster will not mint a ticket. */
export type PermissionTicketRefusal =
  | WriteRefusal
  | "event_not_open"
  | "unknown_ticket_type"
  | "no_subject_identifier"
  | "ticket_window_closed"
  | "validity_in_the_past"
  | "no_scopes"
  | "not_a_patient_scope";

/** What the refusal rules read off the request. */
export interface PermissionTicketRequest {
  readonly standing: AccountStanding;
  readonly eventStatus: EventStatus;
  readonly eventEndsOn: string;
  readonly graceDays: number;
  /** As asked for, which is why it is a string: an unknown type is a refusal. */
  readonly ticketType: string;
  readonly ihi: string;
  readonly scopes: readonly string[];
  readonly validUntil: string | null;
  readonly now: Date;
}

/**
 * A scope in the patient compartment, in either SMART spelling.
 *
 * `patient/Resource.permissions`, where the resource may be `*` and the permissions are
 * either the version 2 letters or one of the version 1 words. Anchored at both ends, so a
 * value with something appended is not a scope.
 */
const PATIENT_SCOPE = /^patient\/([A-Za-z]+|\*)\.([cruds]+|read|write|\*)$/;

/**
 * Whether a value names a ticket type Muster mints.
 *
 * @param value - The requested type.
 * @returns `true` when it is one Muster mints.
 * @example
 * ```ts
 * isPermissionTicketType("patient-self-access"); // true
 * ```
 */
export function isPermissionTicketType(
  value: string,
): value is PermissionTicketType {
  return (PERMISSION_TICKET_TYPES as readonly string[]).includes(value);
}

/**
 * When the ticket stops being good (FR-033, scenario 5).
 *
 * The smaller of the event's cap and the day the member asked for. Both are computed the
 * same way - the end of the named day, which is the midnight that begins the next one - so a
 * ticket asked for "until the 16th" covers the whole of the 16th, which is what a date on a
 * form means to the person filling it in.
 *
 * UTC throughout, for the reason `vouchingExpirySeconds` is: a connectathon spans time
 * zones, and a deadline that moved with the server's offset would be a different deadline
 * for each participant reading it.
 *
 * @param eventEndsOn - The event's last day, as `YYYY-MM-DD`.
 * @param graceDays - Whole days of grace past that day.
 * @param validUntil - The last day the member asked for, or null for the cap.
 * @returns The expiry, as seconds since the epoch.
 * @throws {TypeError} When either date is not a calendar date.
 * @example
 * ```ts
 * ticketExpirySeconds("2026-09-19", 7, null); // 2026-09-27T00:00:00Z
 * ticketExpirySeconds("2026-09-19", 7, "2027-01-01"); // the same: capped
 * ```
 */
export function ticketExpirySeconds(
  eventEndsOn: string,
  graceDays: number,
  validUntil: string | null,
): number {
  const cap = vouchingExpirySeconds(eventEndsOn, graceDays);
  return validUntil === null
    ? cap
    : Math.min(cap, vouchingExpirySeconds(validUntil, 0));
}

/**
 * Whether a scope may constrain a patient self-access ticket.
 *
 * Patient-compartment resource scopes only. The ticket's whole claim is that a patient
 * permits access to their own record, and a `user/` or `system/` scope inside one would be
 * asking a data holder to honour an authorisation the subject never gave.
 *
 * @param scope - The requested scope.
 * @returns `true` when it is a patient-compartment resource scope.
 * @example
 * ```ts
 * isPatientCompartmentScope("patient/Observation.rs"); // true
 * isPatientCompartmentScope("system/*.cruds"); // false
 * ```
 */
export function isPatientCompartmentScope(scope: string): boolean {
  return PATIENT_SCOPE.test(scope.trim());
}

/**
 * Whether an event's ticket window has already closed.
 *
 * A ticket minted after this moment would be expired at the moment it was signed, which is
 * not a thing to hand anybody.
 */
function ticketWindowClosed(
  eventEndsOn: string,
  graceDays: number,
  now: Date,
): boolean {
  return vouchingExpirySeconds(eventEndsOn, graceDays) * 1000 <= now.getTime();
}

/**
 * Why Muster will not mint this ticket, or `undefined` when it will (FR-033, scenario 4).
 *
 * Deny by default: every one of the eight conditions must hold. The order is the order the
 * person can act on - nothing about a revoked account is fixed by editing a scope, and
 * nothing about a closed event is fixed by anything at all - and the two temporal refusals
 * are in that order too, because a member can change the date they asked for and cannot
 * change when the event ended.
 *
 * @param request - The caller's standing, the event, and the constraints asked for.
 * @returns The refusal code, or `undefined` when the ticket may be minted.
 * @example
 * ```ts
 * const refusal = permissionTicketRefusal({
 *   standing: account,
 *   eventStatus: event.status,
 *   eventEndsOn: event.endsOn,
 *   graceDays: event.graceDays,
 *   ticketType: input.ticketType,
 *   ihi: persona.ihi,
 *   scopes: input.scopes,
 *   validUntil: input.validUntil,
 *   now: context.clock(),
 * });
 * ```
 */
export function permissionTicketRefusal(
  request: PermissionTicketRequest,
): PermissionTicketRefusal | undefined {
  const standing = writeRefusal(request.standing);
  if (standing !== undefined) {
    // Scenario 4: a revoked member gets no ticket, whatever else is true.
    return standing;
  }
  if (request.eventStatus !== "open") {
    return "event_not_open";
  }
  if (!isPermissionTicketType(request.ticketType)) {
    return "unknown_ticket_type";
  }
  if (request.ihi.trim().length === 0) {
    // A ticket bound to an empty identifier is bound to nothing, and a data holder
    // resolving it would match everybody or nobody.
    return "no_subject_identifier";
  }
  if (ticketWindowClosed(request.eventEndsOn, request.graceDays, request.now)) {
    return "ticket_window_closed";
  }
  if (
    ticketExpirySeconds(
      request.eventEndsOn,
      request.graceDays,
      request.validUntil,
    ) *
      1000 <=
    request.now.getTime()
  ) {
    return "validity_in_the_past";
  }
  if (request.scopes.length === 0) {
    return "no_scopes";
  }
  // Last, because it is the one a person fixes by ticking a different box.
  return request.scopes.every((scope) => isPatientCompartmentScope(scope))
    ? undefined
    : "not_a_patient_scope";
}

/**
 * The claim set Muster signs (FR-033, scenario 1).
 *
 * @param input - The issuer, the event, the subject, the constraints, the identifier and the
 *   time. Every one of them is passed in: this function reads no clock and generates no
 *   identifier.
 * @returns The claims, ready to sign.
 * @throws {TypeError} When the event's end date, or the requested validity, is unparseable.
 * @example
 * ```ts
 * const claims = buildPermissionTicketClaims({
 *   issuer: config.publicUrl,
 *   jti: crypto.randomUUID(),
 *   eventSlug: event.slug,
 *   eventEndsOn: event.endsOn,
 *   graceDays: event.graceDays,
 *   ticketType: input.ticketType,
 *   ihi: persona.ihi,
 *   ihiSystem: config.ihiSystem,
 *   scopes: input.scopes,
 *   validUntil: input.validUntil,
 *   now: context.clock(),
 * });
 * ```
 */
export function buildPermissionTicketClaims(
  input: PermissionTicketInput,
): PermissionTicketClaims {
  return {
    iss: input.issuer,
    jti: input.jti,
    iat: Math.floor(input.now.getTime() / 1000),
    exp: ticketExpirySeconds(
      input.eventEndsOn,
      input.graceDays,
      input.validUntil,
    ),
    ticket_type: input.ticketType,
    subject: {
      identifier: { system: input.ihiSystem, value: input.ihi.trim() },
    },
    smart_scopes: input.scopes.map((scope) => scope.trim()).join(" "),
    muster_event: input.eventSlug,
  };
}
