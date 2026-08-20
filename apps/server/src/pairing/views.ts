/*
 * Copyright © 2026 Commonwealth Scientific and Industrial Research Organisation
 * (CSIRO) ABN 41 687 119 230. Licensed under the Apache License, Version 2.0.
 */

import {
  pairingEventDetailSchema,
  registrationFieldsSchema,
  serverProfileSchema,
  statementClaimsSchema,
} from "@muster/contracts";

import type {
  PairingDetail,
  PairingEvent,
  PairingParty,
  PairingSide,
  PairingSummary,
  ScopeWarning,
  SoftwareStatementView,
} from "@muster/contracts";
import type {
  PairingEventRow,
  PairingPartyRow,
  PairingRecordRow,
  SoftwareStatementRow,
} from "@muster/db";

/**
 * How a stored pairing becomes the shape on the wire.
 *
 * One shape serves both parties, because the tracker's whole purpose is that the
 * app owner and the server owner are looking at the same record (SC-002). The
 * only thing that varies by reader is `sides`, which says which side or sides
 * they are on - and that is a fact about the reader, so it arrives as an argument
 * rather than being looked up here.
 *
 * The stored field set and the server's profile are parsed against their contract
 * schemas on the way out rather than passed through: what a party receives is what
 * the contract says, or the request fails.
 *
 * @author John Grimes
 */

/**
 * Renders one side of a pairing.
 *
 * @param party - the side as stored
 * @returns the side
 */
const pairingParty = (party: PairingPartyRow): PairingParty => ({
  enrolmentId: party.enrolmentId,
  systemId: party.systemId,
  systemName: party.systemName,
  organisation: { id: party.organisationId, name: party.organisationName },
});

/**
 * Reads which sides of a pairing a reader is on.
 *
 * A member of both organisations is on both sides, which is the specification's
 * edge case: they see both, and each action they take is recorded against the
 * organisation it was taken for.
 *
 * @param record - the pairing and its two sides
 * @param organisationIds - the organisations the reader belongs to
 * @returns the sides, client before server; empty when the reader is on neither
 * @example
 * ```ts
 * const sides = pairingSides(record, memberships.map((m) => m.organisationId));
 * ```
 */
export const pairingSides = (
  record: PairingRecordRow,
  organisationIds: readonly string[],
): PairingSide[] => [
  ...(organisationIds.includes(record.client.organisationId)
    ? (["client"] as const)
    : []),
  ...(organisationIds.includes(record.server.organisationId)
    ? (["server"] as const)
    : []),
];

/**
 * Renders a pairing for a list.
 *
 * @param record - the pairing and its two sides
 * @param sides - the sides the reader is on
 * @returns the summary
 * @throws {Error} when the stored server profile does not satisfy the contract
 * @example
 * ```ts
 * context.json({ pairings: records.map((record) => pairingSummary(record, sides)) });
 * ```
 */
export const pairingSummary = (
  record: PairingRecordRow,
  sides: readonly PairingSide[],
): PairingSummary => ({
  id: record.pairing.id,
  eventSlug: record.eventSlug,
  eventStatus: record.eventStatus,
  state: record.pairing.state,
  client: pairingParty(record.client),
  server: pairingParty(record.server),
  registrationMode: serverProfileSchema.parse(record.serverProfile)
    .registrationMode,
  clientId: record.pairing.clientId,
  declineReason: record.pairing.declineReason,
  requestedAt: record.pairing.createdAt.toISOString(),
  updatedAt: record.pairing.updatedAt.toISOString(),
  sides: [...sides],
});

/**
 * Renders one timeline entry.
 *
 * @param row - the entry as stored
 * @returns the entry
 */
const pairingEvent = (row: PairingEventRow): PairingEvent => ({
  id: row.id,
  at: row.at.toISOString(),
  fromState: row.fromState,
  toState: row.toState,
  actorDisplayName: row.actorDisplayName,
  actingFor:
    row.actingForOrganisationId === null
      ? null
      : {
          id: row.actingForOrganisationId,
          name: row.actingForOrganisationName ?? "",
        },
  detail: pairingEventDetailSchema.parse(row.detail ?? {}),
});

/**
 * Renders a minted statement for either party.
 *
 * The claims, the key and where to fetch the artefact - and nothing else. The
 * client secret a server issued in exchange for it is not part of the record and
 * so cannot be part of this shape (the constitution).
 *
 * @param row - the statement as stored
 * @returns the statement as both parties read it
 * @throws {Error} when the stored claims do not satisfy the profile's contract
 * @example
 * ```ts
 * const view = statementView(statement);
 * ```
 */
export const statementView = (
  row: SoftwareStatementRow,
): SoftwareStatementView => ({
  jti: row.jti,
  keyId: row.keyId,
  expiresAt: row.expiresAt.toISOString(),
  claims: statementClaimsSchema.parse(row.claims),
  downloadPath: `/api/pairings/${row.pairingId}/statement`,
});

/**
 * Renders a pairing in full.
 *
 * @param record - the pairing and its two sides
 * @param sides - the sides the reader is on
 * @param timeline - the pairing's transitions, oldest first
 * @param warning - the scope warning, when the server's advertised set does not
 *   cover what the client asked for; the same value for both parties (FR-019)
 * @param statement - the newest software statement minted for the pairing, when
 *   one has been
 * @returns the detail
 * @throws {Error} when the stored field set does not satisfy the contract
 * @example
 * ```ts
 * context.json({
 *   pairing: pairingDetail(record, sides, timeline, warning, statement),
 * });
 * ```
 */
export const pairingDetail = (
  record: PairingRecordRow,
  sides: readonly PairingSide[],
  timeline: readonly PairingEventRow[],
  warning: ScopeWarning | undefined,
  statement: SoftwareStatementRow | undefined,
): PairingDetail => ({
  ...pairingSummary(record, sides),
  registrationFields: registrationFieldsSchema.parse(
    record.pairing.registrationFields,
  ),
  timeline: timeline.map(pairingEvent),
  scopeWarning: warning ?? null,
  statement: statement === undefined ? null : statementView(statement),
});
