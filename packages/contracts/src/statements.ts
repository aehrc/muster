/**
 * What a trusted-DCR run says about itself, and what a software statement looks like.
 *
 * Three decisions worth stating.
 *
 * **The claim set is spelled out rather than left as a bag.** These are the claims a
 * vendor's server reads, tabulated in `contracts/registration-profile.md`, so the console
 * showing them for review and the server signing them agree on the vocabulary by
 * construction. A `z.record` would have let a renamed claim through both.
 *
 * **The run reports its steps.** FR-037 and the wireframe both ask for stepwise progress
 * rather than a spinner and a verdict: minting, presenting and recording are three things
 * that fail differently, and the person watching needs to know which one did.
 *
 * **The run's response wrapper lives in `pairings.ts`.** It carries a pairing detail, and
 * a pairing detail carries the statement declared here - so the dependency runs one way
 * only and neither module has to be evaluated before the other.
 *
 * **`clientSecret` appears exactly here and nowhere else.** It is present on the response
 * of the run that produced it and on no read surface, because there is no read surface it
 * could be on - Muster does not store it (constitution principle IV, FR-026). A console
 * that navigated away has lost it, which is what the panel beside it has to say.
 *
 * Author: John Grimes
 */

import { z } from "zod";

import { slugSchema } from "./common.js";

/**
 * The claims of a software statement, per `contracts/registration-profile.md`.
 *
 * snake_case, because they are OAuth client metadata rather than TypeScript fields.
 */
export const softwareStatementClaimsSchema = z.object({
  /** The trust anchor's issuer identifier. */
  iss: z.string(),
  /** Muster's identifier for the client system. */
  sub: z.string(),
  software_id: z.string(),
  /** The statement identifier. Single registration use. */
  jti: z.string(),
  iat: z.number().int(),
  /** Never later than event end plus the event's grace period. */
  exp: z.number().int(),
  muster_event: slugSchema,
  client_name: z.string(),
  redirect_uris: z.array(z.string()),
  grant_types: z.array(z.string()),
  token_endpoint_auth_method: z.string(),
  /** Space-separated. */
  scope: z.string(),
  smart_launch_url: z.string(),
});

/**
 * A minted statement as the console shows it.
 *
 * The compact JWS is deliberately absent: it is served by its own route as a downloadable
 * artefact (FR-027), so a page that only wants to display the claims does not carry the
 * signed token through the browser's memory and history.
 */
export const softwareStatementViewSchema = z.object({
  jti: z.string(),
  /** The `kid` of the key it was signed with, so a reader can match it to the JWKS. */
  keyId: z.string(),
  claims: softwareStatementClaimsSchema,
  expiresAt: z.string(),
  mintedAt: z.string(),
});

/** The three things a run does, in order. */
export const dcrRunStepNameSchema = z.enum(["mint", "present", "record"]);

/** How one step went. */
export const dcrRunStepOutcomeSchema = z.enum(["done", "failed", "skipped"]);

/** One step of a run, with something a person can read about it. */
export const dcrRunStepSchema = z.object({
  name: dcrRunStepNameSchema,
  outcome: dcrRunStepOutcomeSchema,
  detail: z.string(),
});

/**
 * How the run ended.
 *
 * `refused` and `unreachable` are separate because they are different problems for
 * different people: a refusal is the server disagreeing with the statement, and
 * unreachable is the endpoint not answering at all.
 */
export const dcrRunOutcomeSchema = z.enum([
  "registered",
  "refused",
  "unreachable",
]);

/** What the far end said, when it said anything. */
export const dcrServerAnswerSchema = z.object({
  status: z.number().int(),
  /** The RFC 7591 error code, when the response carried one. */
  error: z.string().nullable(),
  errorDescription: z.string().nullable(),
  /** The response body, truncated, as evidence for the person reading the run. */
  body: z.string(),
});

/**
 * One trusted-DCR run (FR-026).
 *
 * Returned by the run itself and by nothing else. The pairing's own state carries what
 * outlives the run - the issued client identifier, or the failure in its timeline.
 */
export const dcrRunSchema = z.object({
  outcome: dcrRunOutcomeSchema,
  steps: z.array(dcrRunStepSchema),
  /** The statement that was presented. Always present: nothing is presented unminted. */
  statement: softwareStatementViewSchema,
  /** Where it was presented. */
  registrationEndpoint: z.string(),
  /** What came back, or null when nothing did. */
  answer: dcrServerAnswerSchema.nullable(),
  /** The identifier the server issued, on success. */
  clientId: z.string().nullable(),
  /**
   * The secret the server issued, for a confidential client.
   *
   * Shown once. Muster does not store it and cannot show it again (principle IV).
   */
  clientSecret: z.string().nullable(),
});

/** The claims of a software statement. */
export type SoftwareStatementClaimsView = z.infer<
  typeof softwareStatementClaimsSchema
>;
/** A minted statement as the console shows it. */
export type SoftwareStatementView = z.infer<typeof softwareStatementViewSchema>;
/** One step of a run. */
export type DcrRunStep = z.infer<typeof dcrRunStepSchema>;
/** How the run ended. */
export type DcrRunOutcome = z.infer<typeof dcrRunOutcomeSchema>;
/** What the far end said. */
export type DcrServerAnswer = z.infer<typeof dcrServerAnswerSchema>;
/** One trusted-DCR run. */
export type DcrRun = z.infer<typeof dcrRunSchema>;
