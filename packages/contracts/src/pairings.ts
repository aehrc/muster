/**
 * The pairing tracker's shapes: what a participant sends, and what both sides read back.
 *
 * The registration field set is the centre of it. FR-012 fixes the fields - client name,
 * launch URL, redirect URIs, scopes, confidentiality, launch context, introspection - and
 * `data-model.md` makes the submitted set a snapshot taken at request time, which is what
 * lets a server's registration mode change while a pairing is open without changing the
 * workflow that pairing is already following.
 *
 * The minimums are deliberately not here. "At least one redirect URI" and "at least one
 * scope" are domain rules held by `registrationFieldRefusal` in `@muster/core`, because the
 * same rules have to hold for a snapshot read back out of the database - which never passes
 * through this schema. This module validates shape: that a URI is a URI, that a name is not a
 * novel. One rule, one place.
 *
 * **What is deliberately absent.** No shape here carries an email address. The timeline names
 * the person who acted by display name so that both organisations can read the same history
 * (`data-model.md`: append-only, identical for both), and naming them is not the same as
 * publishing how to reach them - which stays behind `GET /api/organisations/{id}/contacts`.
 *
 * Author: John Grimes
 */

import { z } from "zod";

import { scopeWarningSchema } from "./checks.js";
import {
  confidentialitySchema,
  pairingStateSchema,
  slugSchema,
} from "./common.js";
import {
  clientUrlSchema,
  eventSummarySchema,
  organisationRefSchema,
} from "./directory.js";

/** Which half of a pairing something belongs to. */
export const pairingSideNameSchema = z.enum(["client", "server"]);

/**
 * The standard registration field set (FR-012).
 *
 * Prefilled from the client's own record and editable before submission, which is why this
 * is a body a participant sends rather than something the server derives: a client entry
 * describes what an app usually asks for, and one pairing may need less than all of it.
 */
export const registrationFieldsSchema = z.object({
  clientName: z.string().trim().max(200),
  launchUrl: clientUrlSchema,
  redirectUris: z.array(clientUrlSchema).max(20),
  scopes: z.array(z.string().trim().min(1).max(200)).max(100),
  confidentiality: confidentialitySchema,
  /** Free text: which launch context the client needs the server to supply. */
  launchContext: z.string().max(2000).default(""),
  needsIntrospection: z.boolean(),
});

/**
 * Requesting a pairing.
 *
 * Both sides are named by enrolment rather than by system, because a pairing exists inside
 * one event (FR-012, scenario 6) and an enrolment is what ties a system to an event. Naming
 * systems would leave "which event?" to be answered by the slug alone, and a request naming
 * two systems enrolled in two different events would look valid.
 */
export const pairingRequestSchema = z.object({
  eventSlug: slugSchema,
  clientEnrolmentId: z.uuid(),
  serverEnrolmentId: z.uuid(),
  registrationFields: registrationFieldsSchema,
});

/** Fulfilling a request: the identifier the server issued for the client. */
export const pairingFulfilmentSchema = z.object({
  clientId: z.string().trim().min(1).max(200),
});

/**
 * Declining a request.
 *
 * The reason is required. A decline with no reason leaves the app owner with nothing to fix
 * and turns the tracker back into the email thread it replaces (FR-014, scenario 3).
 */
export const pairingDeclineSchema = z.object({
  reason: z.string().trim().min(1).max(2000),
});

// ---------------------------------------------------------------------------
// What the reader gets back.
// ---------------------------------------------------------------------------

/** One half of a pairing: the enrolled system, and who owns it. */
export const pairingSideSchema = z.object({
  enrolmentId: z.uuid(),
  systemId: z.uuid(),
  name: z.string(),
  organisation: organisationRefSchema,
});

/** What a member may do to a pairing next. */
export const pairingActionSchema = z.enum(["fulfil", "decline"]);

/**
 * A pairing as the list shows it.
 *
 * `sides` and `actions` are computed by the server from the pure rules rather than derived in
 * the browser, so the Respond action the console offers and the transition the server would
 * admit cannot disagree. A member of both organisations holds both sides (spec edge case).
 */
export const pairingSummarySchema = z.object({
  id: z.uuid(),
  event: eventSummarySchema,
  state: pairingStateSchema,
  client: pairingSideSchema,
  server: pairingSideSchema,
  /** The identifier the server issued. Null until the pairing is fulfilled. */
  clientId: z.string().nullable(),
  declineReason: z.string().nullable(),
  /** Which sides the caller's organisations hold. Both, when they own both. */
  sides: z.array(pairingSideNameSchema),
  /** What the caller may do now, given their side and the pairing's state. */
  actions: z.array(pairingActionSchema),
  requestedAt: z.string(),
  updatedAt: z.string(),
});

/**
 * One recorded transition (FR-013).
 *
 * Append-only, and identical for both organisations: `actingFor` is the organisation the
 * action was taken for, which is the only way to read the history of a pairing where one
 * person belongs to both organisations (spec edge case).
 *
 * `notifies` is who the transition told, derived from the transition itself, so the timeline
 * says the same thing to both parties. Whether the message was accepted for delivery is
 * reported to the actor by the mutation's own response, not recorded here - the timeline is
 * a record of what happened to the pairing.
 */
export const pairingTimelineEntrySchema = z.object({
  id: z.uuid(),
  at: z.string(),
  /** Null for the request that created the pairing: it came from no prior state. */
  fromState: pairingStateSchema.nullable(),
  toState: pairingStateSchema,
  /** Null when nothing a person did caused it. */
  actorDisplayName: z.string().nullable(),
  /** Null when the actor acted as a track admin rather than for an organisation. */
  actingFor: organisationRefSchema.nullable(),
  /** What changed: the issued identifier, for a fulfilment. */
  clientId: z.string().nullable(),
  /** What changed: the reason, for a decline. */
  reason: z.string().nullable(),
  notifies: z.array(pairingSideNameSchema),
});

/**
 * What one recorded transition changed.
 *
 * Stored beside the transition rather than only on the pairing, because the pairing carries
 * only its latest answer: a decline followed by nothing keeps its reason, but a timeline that
 * read the reason off the pairing would attribute whatever is there now to whichever row the
 * reader was looking at.
 */
export const pairingEventDetailSchema = z.object({
  clientId: z.string().optional(),
  reason: z.string().optional(),
});

/**
 * A pairing in full: its registration snapshot, its whole history, and its warnings.
 *
 * `scopeWarning` is the same value for both organisations, because FR-019 warns both
 * parties: an app owner who cannot see it goes on believing the pairing will work, and a
 * server owner who cannot see it is asked to register something their server will refuse.
 */
export const pairingDetailSchema = pairingSummarySchema.extend({
  registrationFields: registrationFieldsSchema,
  timeline: z.array(pairingTimelineEntrySchema),
  /**
   * The requested scopes the server does not advertise, or null when there is nothing to
   * say - no check has run, or the server advertises no scopes, or every scope is
   * supported. Null rather than an empty list, so a console cannot render a warning box
   * with nothing in it.
   */
  scopeWarning: scopeWarningSchema.nullable(),
});

/**
 * What a mutation answers with.
 *
 * `notified` is part of the answer rather than a detail. FR-014 requires the counterparty to
 * be told on every transition, and a fulfilment whose notification bounced is not the same
 * outcome as one that arrived - so the response says which instead of reporting plain success
 * and leaving it to be discovered at the connectathon (FR-037).
 */
export const pairingOutcomeSchema = z.object({
  pairing: pairingDetailSchema,
  notified: z.boolean(),
});

/**
 * The refusal a duplicate request gets (FR-015).
 *
 * The one place Muster's error envelope carries a third field, and it is carried because the
 * requirement is to link to the existing pairing rather than to mention that one exists: a
 * console that had only prose would have to find the pairing again by guessing at the list.
 */
export const pairingConflictSchema = z.object({
  error: z.literal("pairing_exists"),
  detail: z.string(),
  pairingId: z.uuid(),
});

/** Which half of a pairing something belongs to. */
export type PairingSideName = z.infer<typeof pairingSideNameSchema>;
/** The standard registration field set. */
export type RegistrationFieldsInput = z.infer<typeof registrationFieldsSchema>;
/** Requesting a pairing. */
export type PairingRequest = z.infer<typeof pairingRequestSchema>;
/** Fulfilling a request. */
export type PairingFulfilment = z.infer<typeof pairingFulfilmentSchema>;
/** Declining a request. */
export type PairingDecline = z.infer<typeof pairingDeclineSchema>;
/** One half of a pairing. */
export type PairingSideView = z.infer<typeof pairingSideSchema>;
/** What a member may do to a pairing next. */
export type PairingAction = z.infer<typeof pairingActionSchema>;
/** A pairing as the list shows it. */
export type PairingSummary = z.infer<typeof pairingSummarySchema>;
/** One recorded transition. */
export type PairingTimelineEntry = z.infer<typeof pairingTimelineEntrySchema>;
/** What one recorded transition changed. */
export type PairingEventDetail = z.infer<typeof pairingEventDetailSchema>;
/** A pairing in full. */
export type PairingDetail = z.infer<typeof pairingDetailSchema>;
/** What a pairing mutation answers with. */
export type PairingOutcome = z.infer<typeof pairingOutcomeSchema>;
/** The refusal a duplicate request gets. */
export type PairingConflict = z.infer<typeof pairingConflictSchema>;
