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
  patientResourceUrl,
  REQUEST_NOTIFIES,
  softwareStatementRefusal,
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
  DcrVerified,
  EnrolledSystem,
  EnrolledSystemDetail,
  EventDetail,
  EventSummary,
  HarnessRunView,
  HarnessTarget,
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
  PersonaCoverageCell,
  PersonaCoverageServer,
  PersonaRefusal,
  PersonaView,
  ScopeWarning,
  SessionAccount,
  SoftwareStatementView,
  SystemKind,
} from "@muster/contracts";
import type {
  AccountStanding,
  HarnessRunRefusal,
  PairingState,
  PersonaAssessment,
} from "@muster/core";
import type {
  AccountRow,
  CheckResultRow,
  CheckStatusRow,
  ContactRow,
  EnrolledSystemInEventRow,
  EnrolledSystemRow,
  EnrolmentRow,
  EventRow,
  HarnessRunRow,
  MembershipRow,
  OrganisationRow,
  PairingSideRow,
  PairingTimelineRow,
  PairingWithSides,
  PersonaCoverageRow,
  PersonaRow,
  SoftwareStatementRow,
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
 * The DCR-verified badge, from the latest conformance run (FR-030, scenario 2 and 3).
 *
 * Two conditions, and both are the requirement rather than caution. The run has to be the
 * latest* one and it has to have passed, because "any failing run removes the badge" is a
 * claim about the newest run - so a failure after a pass produces null here, and there is no
 * stored flag that could disagree. And the system has to still declare trusted DCR: an owner
 * who has since switched to manual registration is no longer offering the thing the run
 * proved, and a badge for it would be a claim about a mode the entry no longer advertises.
 *
 * @param run - The latest run on the enrolment, or `undefined` when nothing has run.
 * @param system - The system as it now stands, for its registration mode.
 * @returns The badge, or null.
 */
export function dcrVerifiedView(
  run: HarnessRunRow | undefined,
  system: SystemRow,
): DcrVerified | null {
  if (
    run === undefined ||
    run.verdict !== "passed" ||
    system.serverProfile?.registrationMode !== "trustedDcr"
  ) {
    return null;
  }
  return { verifiedAt: run.ranAt.toISOString(), runId: run.id };
}

/**
 * An enrolled system, as the public event view and the public JSON API present it.
 *
 * No contact detail of any kind. The owning organisation appears as a name and an
 * identifier, because two organisations may hold systems with the same name and the reader
 * has to be able to tell them apart.
 *
 * `check` is null when nothing has checked the enrolment, which is not the same claim as
 * unreachable: a server nobody has looked at has not failed. `dcrVerified` is null on the
 * same principle and for a second reason besides: a server that has never been put through
 * the harness has not failed it.
 */
export function enrolledSystemView(
  row: EnrolledSystemRow,
  status?: CheckStatusRow,
  latestRun?: HarnessRunRow,
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
    dcrVerified: dcrVerifiedView(latestRun, row.system),
  };
}

/** One enrolled system on its own page, with the whole of its verification record. */
export function enrolledSystemDetailView(
  row: EnrolledSystemRow,
  status: CheckStatusRow | undefined,
  history: readonly CheckResultRow[],
  latestRun?: HarnessRunRow,
): EnrolledSystemDetail {
  return {
    ...enrolledSystemView(row, status, latestRun),
    check: status === undefined ? null : checkDetailView(status),
    checkHistory: history.map(checkSummaryView),
  };
}

/**
 * One recorded conformance run, as the harness screen and the public report show it.
 *
 * The endpoint comes from the run's own evidence rather than from the system's record as it
 * stands today: the run is a statement about where the statements went at the time, and an
 * owner who has since edited the entry has not changed what happened.
 *
 * The checks are stored already scrubbed and already projected, so they pass through: the
 * redaction happens once, before the row is written, rather than in every reader.
 */
export function harnessRunView(row: HarnessRunRow): HarnessRunView {
  return {
    id: row.id,
    enrolmentId: row.enrolmentId,
    ranAt: row.ranAt.toISOString(),
    verdict: row.verdict,
    registrationEndpoint: row.checks[0]?.request.url ?? "",
    checks: row.checks.map((check) => ({
      ...check,
      advisories: [...check.advisories],
    })),
    cleanup: row.cleanup,
  };
}

/**
 * The entry a run is aimed at, and whether this caller may aim one (FR-037).
 *
 * The refusal is computed from the same rule the route enforces, so the sentence the screen
 * shows and the answer the server would give cannot disagree.
 */
export function harnessTargetView(
  row: EnrolledSystemInEventRow,
  refusal?: HarnessRunRefusal,
): HarnessTarget {
  return {
    enrolmentId: row.enrolment.id,
    systemId: row.system.id,
    systemName: row.system.name,
    organisationName: row.organisation.name,
    eventSlug: row.event.slug,
    eventName: row.event.name,
    registrationEndpoint:
      row.system.serverProfile?.registrationEndpoint ?? null,
    canRun: refusal === undefined,
    refusal: refusal ?? null,
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

/**
 * Who is looking at a pairing, and when.
 *
 * The three things every pairing projection needs beyond the row itself. `standing` and `now`
 * are here because one of the offered actions - the trusted-DCR run - is refused for a revoked
 * member and for an event whose grace has run out, and the console must not offer a button the
 * server would refuse.
 */
export interface PairingViewer {
  /** The sides the caller's organisations hold. Both, for a member of both. */
  readonly sides: readonly PairingSideName[];
  readonly standing: AccountStanding;
  readonly now: Date;
}

/** The state each offered transition asks for. */
const ACTION_TARGETS = {
  fulfil: "fulfilled",
  decline: "declined",
} as const satisfies Readonly<Partial<Record<PairingAction, PairingState>>>;

/** The transitions this caller may ask for. */
function transitionActions(
  state: PairingState,
  sides: readonly PairingSideName[],
): readonly PairingAction[] {
  return (
    Object.keys(ACTION_TARGETS) as readonly ("fulfil" | "decline")[]
  ).filter(
    (action) =>
      transitionRefusal(state, ACTION_TARGETS[action], sides) === undefined,
  );
}

/**
 * What the caller may do to a pairing now.
 *
 * Computed from the same rules that would refuse the request, so the action the console offers
 * and the thing the server admits cannot disagree - and so the console holds no copy of who may
 * answer a pairing, and none of when Muster will vouch for one.
 */
function pairingActions(
  row: PairingWithSides,
  viewer: PairingViewer,
): readonly PairingAction[] {
  const profile = row.server.system.serverProfile;
  const canRegister =
    profile !== null &&
    softwareStatementRefusal({
      standing: viewer.standing,
      ownsClientSide: viewer.sides.includes("client"),
      eventStatus: row.event.status,
      eventEndsOn: row.event.endsOn,
      graceDays: row.event.graceDays,
      pairingState: row.pairing.state,
      serverRegistrationMode: profile.registrationMode,
      registrationEndpoint: profile.registrationEndpoint,
      fields: row.pairing.registrationFields,
      now: viewer.now,
    }) === undefined;

  return [
    ...transitionActions(row.pairing.state, viewer.sides),
    ...(canRegister ? (["register"] as const) : []),
  ];
}

/** A pairing as the list shows it. */
export function pairingSummaryView(
  row: PairingWithSides,
  viewer: PairingViewer,
): PairingSummary {
  return {
    id: row.pairing.id,
    event: eventSummaryView(row.event),
    state: row.pairing.state,
    client: pairingSideView(row.client),
    server: pairingSideView(row.server),
    clientId: row.pairing.clientId,
    declineReason: row.pairing.declineReason,
    sides: [...viewer.sides],
    actions: [...pairingActions(row, viewer)],
    requestedAt: row.pairing.createdAt.toISOString(),
    updatedAt: row.pairing.updatedAt.toISOString(),
  };
}

/**
 * A minted software statement, as the console shows it (FR-023).
 *
 * The compact JWS is deliberately absent. It is served by its own route as a download
 * (FR-027), so a page that only displays the claims does not carry the signed artefact
 * through the browser.
 */
export function softwareStatementView(
  row: SoftwareStatementRow,
): SoftwareStatementView {
  return {
    jti: row.jti,
    keyId: row.keyId,
    // Copied rather than passed through: the domain's claim set carries readonly arrays and
    // the wire shape does not, and a cast would hide that they are the same fields.
    claims: {
      ...row.claims,
      redirect_uris: [...row.claims.redirect_uris],
      grant_types: [...row.claims.grant_types],
    },
    expiresAt: row.expiresAt.toISOString(),
    mintedAt: row.createdAt.toISOString(),
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
  viewer: PairingViewer,
  timeline: readonly PairingTimelineRow[],
  scopeWarning: ScopeWarning | null,
  statement: SoftwareStatementRow | undefined,
): PairingDetail {
  return {
    ...pairingSummaryView(row, viewer),
    registrationFields: row.pairing.registrationFields,
    timeline: timeline.map(pairingTimelineEntryView),
    statement:
      statement === undefined ? null : softwareStatementView(statement),
    scopeWarning,
  };
}

/**
 * One curated persona, as the public page and the admin table both read it (FR-031).
 *
 * The canonical link is derived from the event's configured source rather than stored, so an
 * admin who corrects the source address does not leave a page full of links to the old one -
 * and so a persona whose event has since had its source removed shows no link at all rather
 * than a broken one.
 *
 * The IHI's system rides along because a sixteen-digit string is not an identifier; the pair
 * is, and a reader copying a persona into their own server needs both.
 *
 * @param row - The persona.
 * @param event - Its event, for the configured source.
 * @param ihiSystem - The deployment's configured IHI namespace.
 * @returns The persona, as it appears on the wire.
 */
export function personaView(
  row: PersonaRow,
  event: EventRow,
  ihiSystem: string,
): PersonaView {
  return {
    id: row.id,
    display: row.display,
    ihi: row.ihi,
    ihiSystem,
    patientId: row.patientId,
    canonicalUrl:
      event.personaSourceUrl === null
        ? null
        : patientResourceUrl(event.personaSourceUrl, row.patientId),
    sourceStatus: row.sourceStatus,
    sourceCheckedAt: row.sourceCheckedAt?.toISOString() ?? null,
  };
}

/**
 * One column of the coverage grid.
 *
 * A deliberately smaller projection than {@link enrolledSystemView}: the grid needs a
 * heading and a way to link to the entry, and sending each server's whole profile with it
 * would multiply the page by the number of servers for something it does not show.
 *
 * @param row - The enrolment, its system and its owner.
 * @returns The column.
 */
export function personaCoverageServerView(
  row: EnrolledSystemRow,
): PersonaCoverageServer {
  return {
    enrolmentId: row.enrolment.id,
    systemId: row.system.id,
    systemName: row.system.name,
    organisation: organisationRefView(row.organisation),
  };
}

/**
 * One cell of the coverage grid (FR-032).
 *
 * @param row - The latest coverage row for one (persona, enrolment) pair.
 * @returns The cell, with the time the claim was made at - because a coverage claim with no
 *   time on it is a claim a reader cannot judge.
 */
export function personaCoverageCellView(
  row: PersonaCoverageRow,
): PersonaCoverageCell {
  return {
    personaId: row.personaId,
    enrolmentId: row.enrolmentId,
    outcome: row.outcome,
    detail: row.detail,
    checkedAt: row.checkedAt.toISOString(),
  };
}

/**
 * A search result an admin may not curate, and why (FR-031, scenario 2).
 *
 * @param assessment - The refused assessment.
 * @returns The refusal, as it appears on the wire.
 * @throws {Error} When handed an eligible assessment, which is a caller error rather than a
 *   state: an eligible patient belongs in the candidates.
 */
export function personaRefusalView(
  assessment: PersonaAssessment,
): PersonaRefusal {
  if (assessment.eligible) {
    throw new Error("An eligible candidate is not a refusal");
  }
  return {
    patientId: assessment.patientId,
    display: assessment.display,
    reason: assessment.reason,
    detail: assessment.detail,
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
