/*
 * Copyright © 2026 Commonwealth Scientific and Industrial Research Organisation
 * (CSIRO) ABN 41 687 119 230. Licensed under the Apache License, Version 2.0.
 */

import { createPairingRequestSchema } from "@muster/contracts";
import { applyPairingAction, prefillRegistrationFields } from "@muster/core";

import { joinList, parseRequest, splitList } from "./forms.ts";

import type { ParseOutcome } from "./forms.ts";
import type {
  ClientConfidentiality,
  CreatePairingRequest,
  EnrolledSystem,
  PairingEvent,
  PairingState,
  PairingSummary,
} from "@muster/contracts";
import type { PairingAction } from "@muster/core";

/**
 * Reading and writing pairings, as the console needs them.
 *
 * Two things are kept out of the pages here. What a pairing may do next is asked
 * of `@muster/core` - the same state machine the server asks - so the console
 * cannot offer a button the server would refuse, or withhold one it would allow.
 * And the registration field set is prefilled by the same pure function the
 * specification describes (FR-012), so what the app owner sees in the form is
 * their own client record, editable.
 *
 * The wording of each state is here rather than in the pages because both the
 * list and the detail show it, and a directory that called the same state two
 * things would be worse than one that called it nothing.
 *
 * @author John Grimes
 */

/** What the console calls each state. */
export const pairingStateWords: Record<PairingState, string> = {
  requested: "Requested",
  fulfilled: "Fulfilled",
  declined: "Declined",
  failed: "Failed",
  lapsed: "Lapsed",
};

/** How the console colours each state. */
export const pairingStateClass: Record<PairingState, string> = {
  requested: "badge-info",
  fulfilled: "badge-success",
  declined: "badge-warning",
  failed: "badge-error",
  lapsed: "badge-soft",
};

/** What each state means for whoever is reading it. */
export const pairingStateMeaning: Record<PairingState, string> = {
  requested: "Waiting for the server's organisation to register the client.",
  fulfilled: "Registered: the server has issued a client identifier.",
  declined: "The server's organisation declined, with a reason.",
  failed: "An automated registration attempt was refused by the server.",
  lapsed: "The event closed while this request was still open.",
};

/** Every field of the pairing request form, as text and checkboxes. */
export type PairingFormValues = {
  /** the enrolled client to register */
  readonly clientEnrolmentId: string;
  /** the enrolled server to register it at */
  readonly serverEnrolmentId: string;
  /** what the client is called, as the server should record it */
  readonly clientName: string;
  /** the client's launch URL */
  readonly launchUrl: string;
  /** the client's redirect URIs, one per line */
  readonly redirectUris: string;
  /** the scopes the client asks for */
  readonly scopes: string;
  /** whether the client can keep a secret */
  readonly confidentiality: ClientConfidentiality;
  /** the launch context the client needs */
  readonly launchContext: string;
  /** whether the client needs token introspection */
  readonly needsIntrospection: boolean;
};

/** An empty request form. */
export const emptyPairingForm: PairingFormValues = {
  clientEnrolmentId: "",
  serverEnrolmentId: "",
  clientName: "",
  launchUrl: "",
  redirectUris: "",
  scopes: "",
  confidentiality: "public",
  launchContext: "",
  needsIntrospection: false,
};

/**
 * The enrolled servers a pairing can be requested from.
 *
 * FR-016: a server whose registration mode is `open` needs no registration, so it
 * is not offered - the console does not show a button the server would refuse.
 *
 * @param systems - the event's enrolled systems
 * @returns the enrolled servers that register clients
 * @example
 * ```ts
 * const servers = pairableServers(data.systems);
 * ```
 */
export const pairableServers = (
  systems: readonly EnrolledSystem[],
): readonly EnrolledSystem[] =>
  systems.filter(
    (entry) =>
      entry.system.serverProfile !== null &&
      entry.system.serverProfile.registrationMode !== "open",
  );

/**
 * The enrolled clients the reader's own organisations own.
 *
 * @param systems - the event's enrolled systems
 * @param organisationIds - the organisations the reader belongs to
 * @returns the enrolled clients the reader may request a pairing for
 * @example
 * ```ts
 * const clients = ownClients(data.systems, memberships.map((one) => one.organisationId));
 * ```
 */
export const ownClients = (
  systems: readonly EnrolledSystem[],
  organisationIds: readonly string[],
): readonly EnrolledSystem[] =>
  systems.filter(
    (entry) =>
      entry.system.clientProfile !== null &&
      organisationIds.includes(entry.organisation.id),
  );

/**
 * Fills the request form from an enrolled client (FR-012).
 *
 * @param client - the enrolled client being registered
 * @param serverEnrolmentId - the enrolled server to register it at
 * @returns the form values, prefilled from the client's own record
 * @example
 * ```ts
 * setValues(pairingFormFor(client, server.enrolmentId));
 * ```
 */
export const pairingFormFor = (
  client: EnrolledSystem,
  serverEnrolmentId: string,
): PairingFormValues => {
  if (client.system.clientProfile === null) {
    return { ...emptyPairingForm, serverEnrolmentId };
  }
  const fields = prefillRegistrationFields(
    client.system.name,
    client.system.clientProfile,
  );
  return {
    clientEnrolmentId: client.enrolmentId,
    serverEnrolmentId,
    clientName: fields.clientName,
    launchUrl: fields.launchUrl,
    redirectUris: joinList(fields.redirectUris),
    scopes: joinList(fields.scopes),
    confidentiality: fields.confidentiality,
    launchContext: fields.launchContext,
    needsIntrospection: fields.needsIntrospection,
  };
};

/**
 * Builds a pairing request.
 *
 * @param eventSlug - the event the pairing belongs to
 * @param values - the form values, as edited
 * @returns the request, or one issue per offending field
 * @example
 * ```ts
 * const outcome = buildPairingRequest(event.slug, values);
 * if (outcome.ok) {
 *   await muster.post("/api/pairings", outcome.value, pairingResponseSchema);
 * }
 * ```
 */
export const buildPairingRequest = (
  eventSlug: string,
  values: PairingFormValues,
): ParseOutcome<CreatePairingRequest> =>
  parseRequest(createPairingRequestSchema, {
    eventSlug,
    clientEnrolmentId: values.clientEnrolmentId,
    serverEnrolmentId: values.serverEnrolmentId,
    registrationFields: {
      clientName: values.clientName,
      launchUrl: values.launchUrl,
      redirectUris: splitList(values.redirectUris),
      scopes: splitList(values.scopes),
      confidentiality: values.confidentiality,
      launchContext: values.launchContext,
      needsIntrospection: values.needsIntrospection,
    },
  });

/**
 * Whether the reader may take an action on a pairing.
 *
 * Asks the state machine rather than restating it, so the console offers exactly
 * the actions the server would accept: from the state the pairing is in, for the
 * sides the reader is on, in an event that is still open.
 *
 * @param pairing - the pairing as the console received it
 * @param action - the action being offered
 * @returns true when the action would be accepted
 * @example
 * ```ts
 * {mayTake(pairing, "fulfil") ? <FulfilForm /> : null}
 * ```
 */
export const mayTake = (
  pairing: PairingSummary,
  action: PairingAction,
): boolean =>
  applyPairingAction({
    action,
    state: pairing.state,
    sides: pairing.sides,
    eventStatus: pairing.eventStatus,
  }).ok;

/**
 * Narrows a list of pairings to one state.
 *
 * @param pairings - the pairings the reader can see
 * @param state - the state to show, or `all` for every state
 * @returns the pairings in that state
 * @example
 * ```ts
 * const shown = filterPairings(pairings, "requested");
 * ```
 */
export const filterPairings = (
  pairings: readonly PairingSummary[],
  state: PairingState | "all",
): readonly PairingSummary[] =>
  state === "all"
    ? pairings
    : pairings.filter((pairing) => pairing.state === state);

/**
 * Finds the pairing that already joins a client and a server, if any.
 *
 * FR-015: the console offers the existing pairing rather than a request that would
 * be refused as a duplicate.
 *
 * @param pairings - the pairings the reader can see
 * @param clientEnrolmentId - the client side
 * @param serverEnrolmentId - the server side
 * @returns the existing pairing, or undefined when there is none
 * @example
 * ```ts
 * const existing = existingPairing(pairings, values.clientEnrolmentId, values.serverEnrolmentId);
 * ```
 */
export const existingPairing = (
  pairings: readonly PairingSummary[],
  clientEnrolmentId: string,
  serverEnrolmentId: string,
): PairingSummary | undefined =>
  pairings.find(
    (pairing) =>
      pairing.client.enrolmentId === clientEnrolmentId &&
      pairing.server.enrolmentId === serverEnrolmentId,
  );

/**
 * Says what one timeline entry records.
 *
 * Both parties read the same timeline, so it names the organisation each action
 * was taken for: a member of both organisations needs to see which side they were
 * acting as (the specification's edge case).
 *
 * @param entry - the timeline entry
 * @returns the sentence to show for it
 * @example
 * ```ts
 * describeTimelineEntry(entry); // "Fulfilled by A Member for MediRecords"
 * ```
 */
export const describeTimelineEntry = (entry: PairingEvent): string =>
  [
    pairingStateWords[entry.toState],
    entry.actorDisplayName === null ? "" : ` by ${entry.actorDisplayName}`,
    entry.actingFor === null ? "" : ` for ${entry.actingFor.name}`,
  ].join("");
