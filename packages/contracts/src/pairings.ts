/*
 * Copyright © 2026 Commonwealth Scientific and Industrial Research Organisation
 * (CSIRO) ABN 41 687 119 230. Licensed under the Apache License, Version 2.0.
 */

import { z } from "zod";

import { scopeWarningSchema } from "./checks.ts";
import {
  errorEnvelopeSchema,
  eventStatusSchema,
  pairingStateSchema,
  registrationModeSchema,
} from "./common.ts";
import { clientProfileSchema, organisationSummarySchema } from "./directory.ts";
import { maximumTextLength } from "./fields.ts";
import {
  dcrRunStepSchema,
  registrationErrorSchema,
  softwareStatementViewSchema,
} from "./registration.ts";

/**
 * The pairing tracker's wire shapes: the registration field set, a pairing as
 * either party sees it, its timeline, and the three requests that move it.
 *
 * Both organisations read the same shape, because the whole point of the tracker
 * is that neither party has to ask the other what state the pairing is in
 * (FR-013, SC-002). Which side the caller is on is a field on the pairing rather
 * than a different shape per reader, so a member of both organisations sees both
 * sides of one record.
 *
 * @author John Grimes
 */

/** Longest client identifier accepted; a server issues an identifier, not a document. */
const maximumClientIdLength = 200;

/** Longest client name accepted, matching a system's own name. */
const maximumClientNameLength = 200;

/**
 * The standard SMART registration field set (FR-012).
 *
 * Snapshot into the pairing when it is requested: the client's own record can
 * change afterwards, and what the server was asked to register must not change
 * under it.
 */
export const registrationFieldsSchema = clientProfileSchema.extend({
  clientName: z.string().trim().min(1).max(maximumClientNameLength),
});

/** The standard SMART registration field set. */
export type RegistrationFields = z.infer<typeof registrationFieldsSchema>;

/** Which side of a pairing an organisation is on. */
export const pairingSideSchema = z.enum(["client", "server"]);

/** Which side of a pairing an organisation is on. */
export type PairingSide = z.infer<typeof pairingSideSchema>;

/** One side of a pairing: the enrolled system and the organisation behind it. */
export const pairingPartySchema = z.object({
  enrolmentId: z.string(),
  systemId: z.string(),
  systemName: z.string(),
  organisation: organisationSummarySchema,
});

/** One side of a pairing. */
export type PairingParty = z.infer<typeof pairingPartySchema>;

/**
 * What a timeline entry records beyond the states it moved between.
 *
 * Kept to the two facts a transition can carry, so the timeline is renderable
 * without a reader having to interpret arbitrary JSON.
 */
export const pairingEventDetailSchema = z.object({
  clientId: z.string().optional(),
  reason: z.string().optional(),
});

/** What a timeline entry records beyond the states. */
export type PairingEventDetail = z.infer<typeof pairingEventDetailSchema>;

/**
 * One entry in a pairing's timeline: who did what, when, and for which
 * organisation (FR-013).
 *
 * The actor and the organisation are both nullable because a lapse is Muster's
 * own doing rather than a party's, and a member of both organisations needs the
 * timeline to say which side each of their actions was taken for.
 */
export const pairingEventSchema = z.object({
  id: z.string(),
  at: z.string(),
  fromState: pairingStateSchema.nullable(),
  toState: pairingStateSchema,
  actorDisplayName: z.string().nullable(),
  actingFor: organisationSummarySchema.nullable(),
  detail: pairingEventDetailSchema,
});

/** One entry in a pairing's timeline. */
export type PairingEvent = z.infer<typeof pairingEventSchema>;

/** A pairing as the list shows it. */
export const pairingSummarySchema = z.object({
  id: z.string(),
  eventSlug: z.string(),
  /** the event's status: what a pairing may still do depends on it (FR-011) */
  eventStatus: eventStatusSchema,
  state: pairingStateSchema,
  client: pairingPartySchema,
  server: pairingPartySchema,
  registrationMode: registrationModeSchema,
  clientId: z.string().nullable(),
  declineReason: z.string().nullable(),
  requestedAt: z.string(),
  updatedAt: z.string(),
  /** the sides the reader acts for; both when they belong to both organisations */
  sides: z.array(pairingSideSchema),
});

/** A pairing as the list shows it. */
export type PairingSummary = z.infer<typeof pairingSummarySchema>;

/**
 * A pairing in full: the field set the server was handed, and the timeline.
 *
 * `scopeWarning` is the same value for both parties, because FR-019 warns both:
 * an app owner who is about to waste a morning on a scope the server never
 * supported, and a server owner about to be asked for one.
 */
export const pairingDetailSchema = pairingSummarySchema.extend({
  registrationFields: registrationFieldsSchema,
  timeline: z.array(pairingEventSchema),
  scopeWarning: scopeWarningSchema.nullable(),
  /**
   * The newest software statement minted for the pairing, when one has been.
   *
   * Both parties see it: it is what Muster vouched for, and the server's
   * organisation has as much reason to read that as the app's owner. It carries
   * no secret - the secret a server issues in exchange is never part of any
   * record.
   */
  statement: softwareStatementViewSchema.nullable(),
});

/** A pairing in full. */
export type PairingDetail = z.infer<typeof pairingDetailSchema>;

/** `POST /api/pairings`. */
export const createPairingRequestSchema = z.object({
  eventSlug: z.string().min(1),
  clientEnrolmentId: z.string().uuid(),
  serverEnrolmentId: z.string().uuid(),
  registrationFields: registrationFieldsSchema,
});

/** `POST /api/pairings`. */
export type CreatePairingRequest = z.infer<typeof createPairingRequestSchema>;

/** `POST /api/pairings/{id}/fulfil`. */
export const fulfilPairingRequestSchema = z.object({
  clientId: z.string().trim().min(1).max(maximumClientIdLength),
});

/** `POST /api/pairings/{id}/fulfil`. */
export type FulfilPairingRequest = z.infer<typeof fulfilPairingRequestSchema>;

/** `POST /api/pairings/{id}/decline`. */
export const declinePairingRequestSchema = z.object({
  reason: z.string().trim().min(1).max(maximumTextLength),
});

/** `POST /api/pairings/{id}/decline`. */
export type DeclinePairingRequest = z.infer<typeof declinePairingRequestSchema>;

/** `GET /api/pairings?event={slug}`. */
export const pairingsResponseSchema = z.object({
  pairings: z.array(pairingSummarySchema),
});

/** `GET /api/pairings/{id}`, and every pairing mutation. */
export const pairingResponseSchema = z.object({ pairing: pairingDetailSchema });

/**
 * The refusal of a duplicate request (FR-015).
 *
 * The envelope plus the identifier of the pairing that already exists, so the
 * console can offer the existing pairing rather than only saying no.
 */
export const pairingConflictSchema = errorEnvelopeSchema.extend({
  pairingId: z.string(),
});

/** The refusal of a duplicate request. */
export type PairingConflict = z.infer<typeof pairingConflictSchema>;

/**
 * `POST /api/pairings/{id}/register`: the report of one trusted-DCR run.
 *
 * The whole run in one answer, because the run is the operation and its parts are
 * what the member is watching (FR-037): the steps say what happened in order, the
 * pairing says where it left the record, and `serverError` carries the server's
 * own refusal when it refused.
 *
 * `clientSecret` is present exactly once, in the response to the run that
 * obtained it, and is never stored (the constitution). Its absence from every
 * other shape in this file is deliberate.
 */
export const dcrRunResponseSchema = z.object({
  pairing: pairingDetailSchema,
  statement: softwareStatementViewSchema,
  steps: z.array(dcrRunStepSchema),
  clientId: z.string().nullable(),
  clientSecret: z.string().optional(),
  registeredMetadata: z.record(z.string(), z.unknown()).nullable(),
  serverError: registrationErrorSchema.nullable(),
});

/** The report of one trusted-DCR run. */
export type DcrRunResponse = z.infer<typeof dcrRunResponseSchema>;
