/**
 * What a verification check says about a server, on the wire.
 *
 * These shapes are read by anybody: the check summary rides on every enrolled system in
 * the public event listing, and the detail rides on the public system page (constitution
 * principle V). Nothing here carries a contact detail, and nothing here carries anything
 * a participant typed into a private field - a check records what a server told the whole
 * internet when asked.
 *
 * The summary and the detail are split because the event view lists tens of systems and
 * needs a badge, a time and the drift flags, while the system page needs the whole
 * advertised document. Sending the documents with the listing would multiply its size by
 * the number of servers for a page that shows none of it.
 *
 * `lastSuccessAt` sits on the summary rather than being derived from the history for one
 * reason: FR-017 and scenario 2 require an unreachable server to be shown *with the time
 * of the last successful check*, and the latest row cannot carry that - it is the row
 * that failed.
 *
 * Author: John Grimes
 */

import { z } from "zod";

import { checkFailureModeSchema } from "./common.js";

/**
 * One disagreement between what an owner declared and what their server advertises
 * (FR-018).
 *
 * Both values, always. "There is drift" is not something an owner can act on, and the
 * wireframe's own drift box shows the declared value above the advertised one.
 */
export const driftFlagSchema = z.object({
  /** The declared field the disagreement is about, for example `tokenEndpoint`. */
  field: z.string(),
  declared: z.string(),
  advertised: z.string(),
});

/**
 * The smart-configuration highlights a check recorded.
 *
 * A fixed projection rather than the document as served, because the document is a
 * participant-supplied body and echoing it whole would republish whatever else the server
 * chose to put in it.
 */
export const discoveryHighlightsSchema = z.object({
  issuer: z.string().nullable(),
  authorizationEndpoint: z.string().nullable(),
  tokenEndpoint: z.string().nullable(),
  registrationEndpoint: z.string().nullable(),
  introspectionEndpoint: z.string().nullable(),
  jwksUri: z.string().nullable(),
  scopesSupported: z.array(z.string()).readonly(),
  capabilities: z.array(z.string()).readonly(),
  grantTypesSupported: z.array(z.string()).readonly(),
  /**
   * The permission ticket types the server advertises.
   *
   * Recorded by the checks and surfaced by the ticket playground (FR-034), so that
   * "which servers accept a ticket?" is answered from a recorded fact rather than by
   * re-fetching every server when somebody opens the playground.
   */
  permissionTicketTypesSupported: z.array(z.string()).readonly(),
});

/** The CapabilityStatement highlights a check recorded. */
export const capabilityHighlightsSchema = z.object({
  fhirVersion: z.string().nullable(),
  softwareName: z.string().nullable(),
  softwareVersion: z.string().nullable(),
  /** `implementation.url`: the server's own statement of where it lives. */
  implementationUrl: z.string().nullable(),
  resourceTypes: z.array(z.string()).readonly(),
  smartAuthorizationEndpoint: z.string().nullable(),
  smartTokenEndpoint: z.string().nullable(),
  smartRegisterEndpoint: z.string().nullable(),
});

/**
 * A check as a badge: enough for the event view's status column.
 *
 * `reachable` and `failureMode` are two views of one fact - a reachable check carries no
 * failure mode and an unreachable one always carries one - and both are sent because the
 * badge reads the first and the sentence beside it reads the second.
 */
export const checkSummarySchema = z.object({
  checkedAt: z.string(),
  reachable: z.boolean(),
  failureMode: checkFailureModeSchema.nullable(),
  /** What went wrong, or what was missing, in words a server owner can act on. */
  detail: z.string().nullable(),
  driftFlags: z.array(driftFlagSchema).readonly(),
});

/**
 * The latest check on an enrolment, with the last time one succeeded.
 *
 * The two times are different rows. Scenario 2 asks for an unreachable server to be shown
 * with the time of the last successful check, which is the only thing that distinguishes
 * "down for ten minutes" from "never worked".
 */
export const checkStatusSchema = checkSummarySchema.extend({
  /** When a check last succeeded, or null when none ever has. */
  lastSuccessAt: z.string().nullable(),
  /**
   * The permission ticket types the server advertises (FR-034, scenario 3).
   *
   * On the status rather than only on the detail, because the event view has to surface
   * which enrolled servers accept a ticket and the event view reads the status. Empty for
   * a server that advertised none, which reads as "no support detected" rather than as a
   * refusal: a server that has said nothing has not said no.
   */
  permissionTicketTypesSupported: z.array(z.string()).readonly(),
});

/** The latest check in full, with everything the server advertised. */
export const checkDetailSchema = checkStatusSchema.extend({
  discovery: discoveryHighlightsSchema.nullable(),
  capability: capabilityHighlightsSchema.nullable(),
});

/**
 * The scopes a server does not advertise, for a pairing that asks for them (FR-019).
 *
 * Carries the check's time, because the warning is only as current as the check behind it
 * and a server that has since added the scope should not be argued with.
 */
export const scopeWarningSchema = z.object({
  unsupportedScopes: z.array(z.string()).readonly(),
  checkedAt: z.string(),
});

/** One disagreement between a declared detail and an advertised one. */
export type DriftFlag = z.infer<typeof driftFlagSchema>;
/** The smart-configuration highlights a check recorded. */
export type DiscoveryHighlights = z.infer<typeof discoveryHighlightsSchema>;
/** The CapabilityStatement highlights a check recorded. */
export type CapabilityHighlights = z.infer<typeof capabilityHighlightsSchema>;
/** A check as a badge. */
export type CheckSummary = z.infer<typeof checkSummarySchema>;
/** The latest check, with the last time one succeeded. */
export type CheckStatus = z.infer<typeof checkStatusSchema>;
/** The latest check in full. */
export type CheckDetail = z.infer<typeof checkDetailSchema>;
/** The scopes a server does not advertise. */
export type ScopeWarning = z.infer<typeof scopeWarningSchema>;
