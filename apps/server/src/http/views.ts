/**
 * What the API says about a row.
 *
 * Every response body is built here rather than by returning a row directly, for one
 * reason: `account` holds an argon2id hash and an email address, and a handler that spread a
 * row into a response would ship whichever of them it happened to have.
 *
 * So the rule is structural. A response is an explicit projection into a shape declared in
 * `@muster/contracts`, and adding a column to the schema does not add it to the API. The
 * cost is that a new field needs an edit here to become visible; the benefit is that a new
 * contact detail* cannot become visible without one.
 *
 * Which is the whole of constitution principle V in this file: exactly two functions here
 * return an email address - {@link contactView}, whose callers are gated on an approved
 * session, and {@link sessionAccountView}, which returns the caller their own. Nothing
 * reachable without an account passes through either.
 *
 * Author: John Grimes
 */

import {
  pairingTransition,
  REQUEST_NOTIFIES,
  transitionRefusal,
  unsupportedScopes,
  writeRefusal,
} from "@muster/core";

import type {
  AdminAccount,
  CheckDetail,
  CheckStatus,
  CheckSummary,
  Contact,
  EnrolledSystem,
  EnrolledSystemDetail,
  EventDetail,
  EventSummary,
  Membership,
  MyOrganisation,
  OrganisationContacts,
  OrganisationRef,
  OrganisationSystem,
  PairingAction,
  PairingDetail,
  PairingSideName,
  PairingSideView,
  PairingSummary,
  PairingTimelineEntry,
  ScopeWarning,
  SessionAccount,
  SystemKind,
} from "@muster/contracts";
import type { PairingState } from "@muster/core";
import type {
  AccountRow,
  CheckResultRow,
  CheckStatusRow,
  ContactRow,
  EnrolledSystemRow,
  EnrolmentRow,
  EventRow,
  MembershipRow,
  OrganisationRow,
  PairingSideRow,
  PairingTimelineRow,
  PairingWithSides,
  SystemEnrolmentRow,
  SystemRow,
} from "@muster/db";

/** An organisation, named just enough to attribute a system to it. */
export function organisationRefView(row: OrganisationRow): OrganisationRef {
  return { id: row.id, name: row.name };
}

/** An event in a list. */
export function eventSummaryView(row: EventRow): EventSummary {
  return {
    slug: row.slug,
    name: row.name,
    startsOn: row.startsOn,
    endsOn: row.endsOn,
    status: row.status,
  };
}

/** An event on its own page, with the tags its enrolments may choose from. */
export function eventDetailView(row: EventRow): EventDetail {
  return {
    ...eventSummaryView(row),
    capabilityTags: row.capabilityTags,
    personaSourceUrl: row.personaSourceUrl,
    graceDays: row.graceDays,
  };
}

/**
 * Whether a system is a server, a client, or both.
 *
 * Derived from which profiles are present rather than stored, so the answer cannot
 * disagree with the record. The schema guarantees the result is never empty.
 */
export function systemKinds(row: SystemRow): readonly SystemKind[] {
  return [
    ...(row.serverProfile === null ? [] : (["server"] as const)),
    ...(row.clientProfile === null ? [] : (["client"] as const)),
  ];
}

/**
 * One verification check, as a badge (FR-017).
 *
 * The advertised documents are deliberately absent: they belong to {@link checkDetailView},
 * because an event listing shows a badge and a time for every server and sending twenty
 * servers' scopes and resource types with it would pay for nothing.
 */
export function checkSummaryView(row: CheckResultRow): CheckSummary {
  return {
    checkedAt: row.checkedAt.toISOString(),
    reachable: row.reachable,
    failureMode: row.failureMode,
    detail: row.detail,
    driftFlags: [...row.driftFlags],
  };
}

/**
 * The latest check, with the last time one succeeded.
 *
 * The second time is what scenario 2 asks for: an unreachable server shown with the time of
 * the last successful check, which the latest row cannot carry because it is the row that
 * failed.
 */
export function checkStatusView(status: CheckStatusRow): CheckStatus {
  return {
    ...checkSummaryView(status.latest),
    lastSuccessAt: status.lastSuccessAt?.toISOString() ?? null,
  };
}

/** The latest check in full, with everything the server advertised. */
export function checkDetailView(status: CheckStatusRow): CheckDetail {
  return {
    ...checkStatusView(status),
    discovery: status.latest.discovery,
    capability: status.latest.capability,
  };
}

/**
 * An enrolled system, as the public event view and the public JSON API present it.
 *
 * No contact detail of any kind. The owning organisation appears as a name and an
 * identifier, because two organisations may hold systems with the same name and the reader
 * has to be able to tell them apart.
 *
 * `check` is null when nothing has checked the enrolment, which is not the same claim as
 * unreachable: a server nobody has looked at has not failed.
 */
export function enrolledSystemView(
  row: EnrolledSystemRow,
  status?: CheckStatusRow,
): EnrolledSystem {
  return {
    systemId: row.system.id,
    enrolmentId: row.enrolment.id,
    name: row.system.name,
    description: row.system.description,
    organisation: organisationRefView(row.organisation),
    kinds: [...systemKinds(row.system)],
    serverProfile: row.system.serverProfile,
    clientProfile: row.system.clientProfile,
    tags: row.enrolment.tags,
    confirmedAt: row.enrolment.confirmedAt.toISOString(),
    check: status === undefined ? null : checkStatusView(status),
  };
}

/** One enrolled system on its own page, with the whole of its verification record. */
export function enrolledSystemDetailView(
  row: EnrolledSystemRow,
  status: CheckStatusRow | undefined,
  history: readonly CheckResultRow[],
): EnrolledSystemDetail {
  return {
    ...enrolledSystemView(row, status),
    check: status === undefined ? null : checkDetailView(status),
    checkHistory: history.map(checkSummaryView),
  };
}

/**
 * One person's contact details.
 *
 * One of the two functions in this module that returns an address. Its callers - the
 * members-only contacts feed and the caller's own organisation page - are gated on an
 * approved session (FR-007).
 */
export function contactView(row: ContactRow): Contact {
  return {
    accountId: row.accountId,
    displayName: row.displayName,
    email: row.email,
    joinedAt: row.joinedAt.toISOString(),
  };
}

/** An organisation's contact details: who to talk to, and how. */
export function organisationContactsView(
  organisation: OrganisationRow,
  members: readonly ContactRow[],
): OrganisationContacts {
  return {
    organisation: organisationRefView(organisation),
    members: members.map(contactView),
  };
}

/** Where one enrolment of a system sits. */
function systemEnrolmentView(row: SystemEnrolmentRow) {
  return {
    id: row.enrolment.id,
    eventSlug: row.event.slug,
    eventName: row.event.name,
    eventStatus: row.event.status,
    tags: row.enrolment.tags,
    confirmedAt: row.enrolment.confirmedAt.toISOString(),
  };
}

/** One of an organisation's systems, with where it is enrolled. */
export function organisationSystemView(
  row: SystemRow,
  enrolments: readonly SystemEnrolmentRow[],
): OrganisationSystem {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    kinds: [...systemKinds(row)],
    serverProfile: row.serverProfile,
    clientProfile: row.clientProfile,
    enrolments: enrolments.map(systemEnrolmentView),
  };
}

/**
 * An organisation the caller belongs to, with everything its page shows.
 *
 * The enrolments arrive as one list for the whole organisation and are grouped here, so the
 * page costs one query per table rather than one per system.
 */
export function myOrganisationView(
  organisation: OrganisationRow,
  members: readonly ContactRow[],
  systems: readonly SystemRow[],
  enrolments: readonly SystemEnrolmentRow[],
): MyOrganisation {
  return {
    id: organisation.id,
    name: organisation.name,
    members: members.map(contactView),
    systems: systems.map((row) =>
      organisationSystemView(
        row,
        enrolments.filter((held) => held.enrolment.systemId === row.id),
      ),
    ),
  };
}

/** One of the caller's memberships. */
export function membershipView(row: MembershipRow): Membership {
  return {
    organisationId: row.organisationId,
    organisationName: row.organisationName,
    joinedAt: row.joinedAt.toISOString(),
  };
}

/**
 * The caller's own account.
 *
 * The second of the two functions that returns an address, and it returns it to the person
 * it belongs to. `writeRefusal` is computed here rather than in the browser so that the
 * console's banner and the server's refusal cannot disagree about why (FR-037).
 */
export function sessionAccountView(row: AccountRow): SessionAccount {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    status: row.status,
    isAdmin: row.isAdmin,
    emailVerified: row.emailVerifiedAt !== null,
    writeRefusal: writeRefusal(row) ?? null,
  };
}

/**
 * An account in the admin queue.
 *
 * Carries addresses, and is reachable only by an admin. The memberships come from one query
 * over every listed account rather than one per row.
 */
export function adminAccountView(
  row: AccountRow,
  organisations: readonly OrganisationRef[],
): AdminAccount {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    status: row.status,
    isAdmin: row.isAdmin,
    emailVerifiedAt: row.emailVerifiedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    approvedAt: row.approvedAt?.toISOString() ?? null,
    organisations: [...organisations],
  };
}

/** One half of a pairing: the enrolled system, and who owns it. */
export function pairingSideView(row: PairingSideRow): PairingSideView {
  return {
    enrolmentId: row.enrolment.id,
    systemId: row.system.id,
    name: row.system.name,
    organisation: organisationRefView(row.organisation),
  };
}

/**
 * Which sides of a pairing the caller's organisations hold.
 *
 * Both, for a member of both organisations (spec edge case) - which is why this is a list rather
 * than a single side, and why the actions below are computed from it rather than from whichever
 * side the request happened to arrive through.
 *
 * @param row - The pairing with both sides.
 * @param organisationIds - The organisations the caller belongs to.
 * @returns The sides held, client before server.
 */
export function pairingSides(
  row: PairingWithSides,
  organisationIds: readonly string[],
): readonly PairingSideName[] {
  const mine = new Set(organisationIds);
  return [
    ...(mine.has(row.client.organisation.id) ? (["client"] as const) : []),
    ...(mine.has(row.server.organisation.id) ? (["server"] as const) : []),
  ];
}

/** The state each offered action asks for. */
const ACTION_TARGETS = {
  fulfil: "fulfilled",
  decline: "declined",
} as const satisfies Readonly<Record<PairingAction, PairingState>>;

/**
 * What the caller may do to a pairing now.
 *
 * Computed from the same rule that would refuse the request, so the action the console offers and
 * the transition the server admits cannot disagree - and so the console holds no copy of who may
 * answer a pairing.
 */
function pairingActions(
  state: PairingState,
  sides: readonly PairingSideName[],
): readonly PairingAction[] {
  return (Object.keys(ACTION_TARGETS) as readonly PairingAction[]).filter(
    (action) =>
      transitionRefusal(state, ACTION_TARGETS[action], sides) === undefined,
  );
}

/** A pairing as the list shows it. */
export function pairingSummaryView(
  row: PairingWithSides,
  sides: readonly PairingSideName[],
): PairingSummary {
  return {
    id: row.pairing.id,
    event: eventSummaryView(row.event),
    state: row.pairing.state,
    client: pairingSideView(row.client),
    server: pairingSideView(row.server),
    clientId: row.pairing.clientId,
    declineReason: row.pairing.declineReason,
    sides: [...sides],
    actions: [...pairingActions(row.pairing.state, sides)],
    requestedAt: row.pairing.createdAt.toISOString(),
    updatedAt: row.pairing.updatedAt.toISOString(),
  };
}

/**
 * One recorded transition.
 *
 * `notifies` is derived from the transition rather than stored, so both organisations read the
 * same claim about who was told (FR-014). Whether the message was accepted for delivery is
 * reported to whoever acted, by the mutation's own response.
 */
export function pairingTimelineEntryView(
  row: PairingTimelineRow,
): PairingTimelineEntry {
  const { entry } = row;
  return {
    id: entry.id,
    at: entry.at.toISOString(),
    fromState: entry.fromState,
    toState: entry.toState,
    actorDisplayName: row.actorDisplayName,
    actingFor:
      row.actingFor === null ? null : organisationRefView(row.actingFor),
    clientId: entry.detail.clientId ?? null,
    reason: entry.detail.reason ?? null,
    notifies: [
      ...(entry.fromState === null
        ? REQUEST_NOTIFIES
        : (pairingTransition(entry.fromState, entry.toState)?.notifies ?? [])),
    ],
  };
}

/**
 * The scopes a server does not advertise, for one pairing (FR-019).
 *
 * Computed from the pairing's own registration snapshot rather than from the client's record
 * as it stands today, because the snapshot is what the server owner was actually asked to
 * register (`data-model.md`).
 *
 * Null rather than an empty list when there is nothing to say, so a console cannot render a
 * warning box with nothing in it. There are three ways for that to happen and all of them
 * mean the same thing: no check has run, the server advertises no scopes, or every
 * requested scope is supported.
 *
 * @param row - The pairing, for its registration snapshot.
 * @param status - The latest check on the server side's enrolment, if any.
 * @returns The warning, or null.
 */
export function pairingScopeWarning(
  row: PairingWithSides,
  status: CheckStatusRow | undefined,
): ScopeWarning | null {
  const unsupported = unsupportedScopes(
    row.pairing.registrationFields.scopes,
    status?.latest.discovery?.scopesSupported ?? null,
  );
  return unsupported.length === 0 || status === undefined
    ? null
    : {
        unsupportedScopes: [...unsupported],
        // The check's own time: the warning is only as current as the check behind it, and a
        // server that has since added the scope should not be argued with.
        checkedAt: status.latest.checkedAt.toISOString(),
      };
}

/**
 * A pairing in full: its registration snapshot, its whole history, and its warnings.
 *
 * The scope warning is the same value for both organisations, because FR-019 warns both
 * parties.
 */
export function pairingDetailView(
  row: PairingWithSides,
  sides: readonly PairingSideName[],
  timeline: readonly PairingTimelineRow[],
  scopeWarning: ScopeWarning | null,
): PairingDetail {
  return {
    ...pairingSummaryView(row, sides),
    registrationFields: row.pairing.registrationFields,
    timeline: timeline.map(pairingTimelineEntryView),
    scopeWarning,
  };
}

/** Where an enrolment's confirmation stands, for a mutation's own response. */
export function enrolmentConfirmation(row: EnrolmentRow) {
  return {
    id: row.id,
    tags: row.tags,
    confirmedAt: row.confirmedAt.toISOString(),
  };
}
