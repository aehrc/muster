/**
 * What a conformance run says about itself, on the wire.
 *
 * Three decisions worth stating, and the first two are security decisions rather than
 * shape decisions.
 *
 * **The request evidence never carries the statement itself.** A valid software statement
 * is a bearer artefact: it names no audience, so whoever holds one can present it at any
 * server that trusts Muster. A run's evidence is a public read surface (SC-005 asks for
 * evidence a vendor can share), so the request body is recorded with the statement
 * described - its identifier and its key - rather than reproduced.
 *
 * **The response evidence is scrubbed rather than omitted.** A registration response for a
 * confidential client carries a `client_secret`, which constitution principle IV forbids
 * storing. Dropping the body would lose the evidence FR-030 requires, so the body is kept
 * with credential-bearing members redacted before anything is written or answered with.
 *
 * **Advisories are separate from outcomes.** The profile's error vocabulary is a SHOULD, so
 * a server that refuses the right statements with the wrong error code has not failed the
 * profile - it has done something worth reporting. An advisory says so without removing the
 * badge, which is reserved for the MUSTs (FR-030).
 *
 * Author: John Grimes
 */

import { z } from "zod";

import { harnessVerdictSchema } from "./common.js";
import { dcrServerAnswerSchema } from "./statements.js";

/** The checks a run reports, in the order it runs them (FR-029). */
export const harnessCheckNameSchema = z.enum([
  "valid-statement",
  "tampered-signature",
  "expired-statement",
  "replayed-statement",
  "metadata-fidelity",
  "statement-only",
]);

/** How one check went. */
export const harnessCheckOutcomeSchema = z.enum(["passed", "failed"]);

/** What the harness sent. The statement is described, never reproduced. */
export const harnessRequestEvidenceSchema = z.object({
  method: z.string(),
  url: z.string(),
  body: z.string(),
});

/**
 * What came back, with credentials redacted.
 *
 * Deliberately the same shape as a trusted-DCR run's answer, and deliberately the same schema:
 * both record what one registration endpoint said, and a second declaration of the same four
 * facts would be a second thing to keep in step. What differs is provenance rather than
 * structure - this body has been through `scrubCredentials`, because it is stored.
 */
export const harnessResponseEvidenceSchema = dcrServerAnswerSchema;

/** One check, with the exchange that decided it (FR-030, scenario 1). */
export const harnessCheckSchema = z.object({
  name: harnessCheckNameSchema,
  outcome: harnessCheckOutcomeSchema,
  /** What the check concluded, in words a vendor can act on. */
  detail: z.string(),
  /** Profile SHOULDs that were not met. These do not affect the verdict. */
  advisories: z.array(z.string()).readonly(),
  request: harnessRequestEvidenceSchema,
  /** Null when nothing came back. */
  response: harnessResponseEvidenceSchema.nullable(),
  /** Why nothing came back. Null when something did. */
  failure: z.string().nullable(),
});

/** One recorded run. */
export const harnessRunSchema = z.object({
  id: z.uuid(),
  enrolmentId: z.uuid(),
  /** When the run happened (scenario 1). */
  ranAt: z.string(),
  verdict: harnessVerdictSchema,
  /** Where the statements were presented. */
  registrationEndpoint: z.string(),
  checks: z.array(harnessCheckSchema),
  /** What was deleted, and what was left behind (scenario 4). */
  cleanup: z.string(),
});

/**
 * Why a run is not on offer, or null when it is.
 *
 * Sent rather than left to the console to work out, so the sentence a reader sees and the
 * refusal the server would answer with cannot disagree (FR-037).
 */
export const harnessRunRefusalSchema = z.enum([
  "not_signed_in",
  "email_unverified",
  "awaiting_approval",
  "revoked_member",
  "not_the_server_owner",
  "event_not_open",
  "not_trusted_dcr",
  "no_registration_endpoint",
  "vouching_window_closed",
]);

/** The entry a run is aimed at, and whether the caller may aim one. */
export const harnessTargetSchema = z.object({
  enrolmentId: z.uuid(),
  systemId: z.uuid(),
  systemName: z.string(),
  organisationName: z.string(),
  eventSlug: z.string(),
  eventName: z.string(),
  /** Null when the entry declares none, which is itself a refusal to run. */
  registrationEndpoint: z.string().nullable(),
  canRun: z.boolean(),
  refusal: harnessRunRefusalSchema.nullable(),
});

/** The target and its runs, newest first. */
export const harnessRunsSchema = z.object({
  target: harnessTargetSchema,
  runs: z.array(harnessRunSchema),
});

/** What a run answers with: the run, and the target as it now stands. */
export const harnessRunResultSchema = z.object({
  target: harnessTargetSchema,
  run: harnessRunSchema,
});

/**
 * The DCR-verified badge (FR-030, scenario 2).
 *
 * Present only while the latest run passed: any failing run removes it, which is why this
 * carries the date of the run that earned it rather than a boolean somebody has to keep in
 * step.
 */
export const dcrVerifiedSchema = z.object({
  verifiedAt: z.string(),
  /** The run behind the badge, so a reader can read the evidence. */
  runId: z.uuid(),
});

/** One of the checks. */
export type HarnessCheckName = z.infer<typeof harnessCheckNameSchema>;
/** How one check went. */
export type HarnessCheckOutcome = z.infer<typeof harnessCheckOutcomeSchema>;
/** What the harness sent. */
export type HarnessRequestEvidence = z.infer<
  typeof harnessRequestEvidenceSchema
>;
/** What came back. */
export type HarnessResponseEvidence = z.infer<
  typeof harnessResponseEvidenceSchema
>;
/** One check, with its evidence. */
export type HarnessCheckView = z.infer<typeof harnessCheckSchema>;
/** One recorded run. */
export type HarnessRunView = z.infer<typeof harnessRunSchema>;
/** Why a run is not on offer. */
export type HarnessRunRefusalCode = z.infer<typeof harnessRunRefusalSchema>;
/** The entry a run is aimed at. */
export type HarnessTarget = z.infer<typeof harnessTargetSchema>;
/** The target and its runs. */
export type HarnessRuns = z.infer<typeof harnessRunsSchema>;
/** What a run answers with. */
export type HarnessRunResult = z.infer<typeof harnessRunResultSchema>;
/** The DCR-verified badge. */
export type DcrVerified = z.infer<typeof dcrVerifiedSchema>;
