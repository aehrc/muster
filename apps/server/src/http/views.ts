import {
  capabilityHighlightsSchema,
  clientProfileSchema,
  discoveryHighlightsSchema,
  driftFlagSchema,
  harnessCheckSchema,
  personaDisplaySchema,
  serverProfileSchema,
  systemKinds,
  ticketClaimsSchema,
} from "@muster/contracts";
import { z } from "zod";

import type {
  AccountView,
  CheckResult,
  CheckStatus,
  ConformanceStatus,
  Contact,
  EnrolledSystem,
  EventDetail,
  EventSummary,
  HarnessRun,
  Persona,
  PersonaCoverage,
  SystemRecord,
  TicketRecord,
} from "@muster/contracts";
import type {
  AccountRow,
  CheckResultRow,
  CheckStatusRow,
  EnrolledSystemRow,
  EventRow,
  HarnessRunRow,
  PersonaCoverageRow,
  PersonaRow,
  SystemRow,
  TicketRow,
} from "@muster/db";

/**
 * How stored rows become the shapes on the wire.
 *
 * One module, shared by the routes a member drives and the public read API, so
 * a field cannot appear in one and be missing from the other. The profiles are
 * parsed against the contract schemas on the way out rather than passed through:
 * what the console receives is what the contract says, or the request fails.
 *
 * Contact details are a parameter here and never a lookup: a view can only
 * carry them if its caller has already decided the reader may see them, which
 * is what keeps FR-007 in one place.
 *
 * @author John Grimes
 */

/**
 * Renders a system.
 *
 * @param system - the system as stored
 * @returns the system record, with its kinds derived from its profiles
 * @throws {Error} when a stored profile does not satisfy the contract
 * @example
 * ```ts
 * context.json({ system: systemRecord(row) });
 * ```
 */
export const systemRecord = (system: SystemRow): SystemRecord => ({
  id: system.id,
  organisationId: system.organisationId,
  name: system.name,
  description: system.description,
  kinds: systemKinds(system),
  serverProfile:
    system.serverProfile == null
      ? null
      : serverProfileSchema.parse(system.serverProfile),
  clientProfile:
    system.clientProfile == null
      ? null
      : clientProfileSchema.parse(system.clientProfile),
});

/**
 * Renders an event for a list.
 *
 * @param event - the event as stored
 * @returns the summary
 */
export const eventSummary = (event: EventRow): EventSummary => ({
  slug: event.slug,
  name: event.name,
  startsOn: event.startsOn,
  endsOn: event.endsOn,
  status: event.status,
});

/**
 * Renders an event with everything the event view needs.
 *
 * @param event - the event as stored
 * @returns the detail
 */
export const eventDetail = (event: EventRow): EventDetail => ({
  ...eventSummary(event),
  capabilityTags: [...event.capabilityTags],
  personaSourceUrl: event.personaSourceUrl,
  graceDays: event.graceDays,
});

/**
 * Renders one recorded check.
 *
 * The stored highlights and flags are parsed against their contract schemas on
 * the way out, so a row written by an older evaluation cannot put a shape on the
 * wire that the console does not understand.
 *
 * @param row - the check as stored
 * @returns the check
 * @throws {Error} when a stored value does not satisfy the contract
 */
export const checkResult = (row: CheckResultRow): CheckResult => ({
  id: row.id,
  checkedAt: row.checkedAt.toISOString(),
  reachable: row.reachable,
  failureMode: row.failureMode,
  detail: row.detail,
  discovery:
    row.discovery == null
      ? null
      : discoveryHighlightsSchema.parse(row.discovery),
  capability:
    row.capability == null
      ? null
      : capabilityHighlightsSchema.parse(row.capability),
  driftFlags: z.array(driftFlagSchema).parse(row.driftFlags ?? []),
});

/**
 * Renders an enrolled server's check status.
 *
 * @param row - the latest check and when the server was last reached
 * @returns the status
 * @throws {Error} when a stored value does not satisfy the contract
 */
export const checkStatus = (row: CheckStatusRow): CheckStatus => ({
  latest: checkResult(row.latest),
  lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
});

/**
 * Renders one conformance run, with its evidence.
 *
 * The per-check report is parsed against the contract schema on the way out, so a
 * row written by an older run cannot put a shape on the wire that the console does
 * not understand - and the evidence in it was redacted before it was ever stored.
 *
 * @param row - the run as stored
 * @returns the run
 * @throws {Error} when a stored check does not satisfy the contract
 * @example
 * ```ts
 * context.json({ run: harnessRun(row) });
 * ```
 */
export const harnessRun = (row: HarnessRunRow): HarnessRun => ({
  id: row.id,
  enrolmentId: row.enrolmentId,
  ranAt: row.createdAt.toISOString(),
  verdict: row.verdict,
  checks: z.array(harnessCheckSchema).parse(row.checks ?? []),
  cleanup: row.cleanup,
});

/**
 * Renders an entry's conformance standing: the verdict of its latest run.
 *
 * The verdict travels with the identifier of the run it came from, so a reader
 * who does not take the badge on trust can open the evidence it was earned with
 * (FR-030). The per-check report is not here: it belongs to the report route,
 * which serves it in full to anybody.
 *
 * @param row - the latest run as stored
 * @returns the standing
 * @example
 * ```ts
 * conformanceStatus(latestRun);
 * ```
 */
export const conformanceStatus = (row: HarnessRunRow): ConformanceStatus => ({
  runId: row.id,
  verdict: row.verdict,
  ranAt: row.createdAt.toISOString(),
});

/** What an enrolled system is rendered with, beyond the row itself. */
export type EnrolledSystemExtras = {
  /**
   * the owning organisation's contacts, when the reader may see them; omitted
   * otherwise, and then absent from the response
   */
  readonly contacts?: readonly Contact[];
  /** the latest check, when the entry is a server something has checked */
  readonly check?: CheckStatusRow;
  /** the check history, on the surfaces that show one */
  readonly history?: readonly CheckResultRow[];
  /** the latest conformance run, when one has been run against the entry */
  readonly conformance?: HarnessRunRow;
};

/**
 * Renders an enrolled system.
 *
 * `check` is null rather than absent when nothing has checked the entry: an
 * unverified entry has to look unverified rather than look like a pass (FR-017).
 *
 * @param row - the enrolment joined to its system and organisation
 * @param extras - the contacts, the check status and the history to include
 * @returns the enrolled system
 * @example
 * ```ts
 * enrolledSystem(row, { contacts: visible ? contacts : undefined, check });
 * ```
 */
export const enrolledSystem = (
  row: EnrolledSystemRow,
  extras: EnrolledSystemExtras = {},
): EnrolledSystem => ({
  enrolmentId: row.enrolmentId,
  tags: [...row.tags],
  confirmedAt: row.confirmedAt.toISOString(),
  system: systemRecord(row.system),
  organisation: row.organisation,
  ...(extras.contacts === undefined ? {} : { contacts: [...extras.contacts] }),
  check: extras.check === undefined ? null : checkStatus(extras.check),
  ...(extras.history === undefined
    ? {}
    : { checkHistory: extras.history.map(checkResult) }),
  conformance:
    extras.conformance === undefined
      ? null
      : conformanceStatus(extras.conformance),
});

/**
 * Renders an account for the console.
 *
 * @param account - the account as stored
 * @returns the account view, which never carries the password hash
 * @example
 * ```ts
 * context.json({ account: accountView(account) });
 * ```
 */
export const accountView = (account: AccountRow): AccountView => ({
  id: account.id,
  email: account.email,
  displayName: account.displayName,
  status: account.status,
  emailVerified: account.emailVerifiedAt !== null,
  isAdmin: account.isAdmin,
});

/**
 * Renders one curated persona.
 *
 * The demographics are parsed against the contract schema on the way out, like
 * every other stored document, so a row written by an earlier curation cannot put
 * a shape on the wire the console does not understand.
 *
 * @param row - the persona as stored
 * @returns the persona
 * @throws {Error} when the stored demographics do not satisfy the contract
 * @example
 * ```ts
 * context.json({ persona: persona(row) });
 * ```
 */
export const persona = (row: PersonaRow): Persona => ({
  id: row.id,
  patientId: row.patientId,
  ihi: row.ihi,
  display: personaDisplaySchema.parse(row.display),
  sourceUrl: row.sourceUrl,
  sourceStatus: row.sourceStatus,
  sourceCheckedAt: row.sourceCheckedAt?.toISOString() ?? null,
  addedAt: row.createdAt.toISOString(),
});

/**
 * Renders one cell of the coverage grid.
 *
 * @param row - the observation as stored
 * @returns the cell
 * @example
 * ```ts
 * context.json({ coverage: rows.map(personaCoverage) });
 * ```
 */
export const personaCoverage = (row: PersonaCoverageRow): PersonaCoverage => ({
  personaId: row.personaId,
  enrolmentId: row.enrolmentId,
  outcome: row.outcome,
  detail: row.detail,
  checkedAt: row.checkedAt.toISOString(),
});

/**
 * Renders one minted permission ticket.
 *
 * The claims are parsed against the contract schema on the way out, like every
 * other stored document. The compact artefact is not here because it is not
 * stored: it belongs to the answer of the mint that produced it, once (the
 * constitution).
 *
 * @param row - the ticket as stored
 * @returns the record
 * @throws {Error} when the stored claims do not satisfy the contract
 * @example
 * ```ts
 * context.json({ jwt, ticket: ticketRecord(row) }, 201);
 * ```
 */
export const ticketRecord = (row: TicketRow): TicketRecord => ({
  jti: row.jti,
  keyId: row.keyId,
  personaId: row.personaId,
  mintedAt: row.createdAt.toISOString(),
  expiresAt: row.expiresAt.toISOString(),
  claims: ticketClaimsSchema.parse(row.claims),
});
