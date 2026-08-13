/**
 * The shapes the server and the console both depend on.
 *
 * Two kinds of thing live here. The error envelope and the page query are the
 * conventions every route follows, so they are defined once rather than per route. The
 * enums are the state vocabularies from `data-model.md`: a value that fails one of
 * these is a spelling drift between the server and the console, and the failure it
 * would otherwise cause - a badge that never appears, a filter that matches nothing -
 * is the kind that is noticed at a connectathon rather than in a test.
 *
 * Author: John Grimes
 */

import { z } from "zod";

/**
 * How every refusal arrives: a code to branch on, and a sentence to read.
 *
 * `error` is a stable machine-readable code (`not_found`, `forbidden`,
 * `guarded_address`); `detail` is for a person and may name specific values. Nothing
 * else is in the envelope, per `contracts/http-api.md`.
 */
export const errorEnvelopeSchema = z.object({
  error: z.string().min(1),
  detail: z.string().optional(),
});

/**
 * The page a list request asks for.
 *
 * Coerced, because a query string carries strings and pushing that conversion into
 * every route is how one of them ends up parsing `limit` differently. Out-of-range
 * values are refused rather than clamped: a caller who asked for a thousand rows and
 * silently received fifty draws the wrong conclusion from a short page.
 */
export const pageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

/**
 * A URL-safe slug, as event addresses are built from.
 *
 * Public URLs (`/api/events/{slug}/brands.json`) are built by concatenation, so
 * anything needing escaping is refused rather than encoded.
 */
export const slugSchema = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, {
    message: "Must be lower-case alphanumeric with internal hyphens",
  });

/** An account's standing: pending until an admin approves it, revocable after. */
export const accountStatusSchema = z.enum(["pending", "approved", "revoked"]);

/** An event's lifecycle. Closing stops enrolment, pairing, minting and vouching. */
export const eventStatusSchema = z.enum(["draft", "open", "closed"]);

/** Where a pairing has got to (FR-013). */
export const pairingStateSchema = z.enum([
  "requested",
  "fulfilled",
  "declined",
  "failed",
  "lapsed",
]);

/**
 * What a server requires of a client before it will talk to it.
 *
 * `open` needs no registration at all, so no pairing is offered (FR-016); `manual` is
 * the human round trip the tracker replaces; `trustedDcr` is the zero-touch ceiling.
 */
export const registrationModeSchema = z.enum(["open", "manual", "trustedDcr"]);

/** Whether a server requires authorization for FHIR reads. */
export const authorizationModeSchema = z.enum(["open", "smart"]);

/** Whether a client can keep a secret. */
export const confidentialitySchema = z.enum(["public", "confidential"]);

/**
 * Why a verification check did not produce a result.
 *
 * `timeout` and `refused` are deliberately distinct: a slow server and a dead one are
 * different problems for its owner (spec edge cases). `guarded` means the address was
 * refused by the outbound guard and no request was made at all.
 */
export const checkFailureModeSchema = z.enum([
  "timeout",
  "refused",
  "guarded",
  "invalid",
]);

/** A conformance run's overall outcome; only `passed` earns the badge (FR-030). */
export const harnessVerdictSchema = z.enum(["passed", "failed"]);

/**
 * Whether a server holds a persona.
 *
 * `unverifiable` rather than a guess for a server that will not answer an
 * unauthenticated search: a false claim of coverage is worse than an absent one
 * (FR-032).
 */
export const personaCoverageOutcomeSchema = z.enum([
  "found",
  "missing",
  "unverifiable",
]);

/** Whether a curated persona is still present on the source server. */
export const personaSourceStatusSchema = z.enum(["present", "missing"]);

/** What a signing key signs. One active key per purpose. */
export const signingKeyPurposeSchema = z.enum(["statements", "tickets"]);

/**
 * A signing key's standing.
 *
 * A superseded key stays published until everything signed with it has expired, so
 * rotation does not invalidate outstanding artefacts (FR-024).
 */
export const signingKeyStatusSchema = z.enum(["active", "superseded"]);

/** How every refusal arrives. */
export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;
/** The page a list request asks for. */
export type PageQuery = z.infer<typeof pageQuerySchema>;
/** A URL-safe slug. */
export type Slug = z.infer<typeof slugSchema>;
/** An account's standing. */
export type AccountStatus = z.infer<typeof accountStatusSchema>;
/** An event's lifecycle position. */
export type EventStatus = z.infer<typeof eventStatusSchema>;
/** Where a pairing has got to. */
export type PairingState = z.infer<typeof pairingStateSchema>;
/** What a server requires before it will talk to a client. */
export type RegistrationMode = z.infer<typeof registrationModeSchema>;
/** Whether a server requires authorization for FHIR reads. */
export type AuthorizationMode = z.infer<typeof authorizationModeSchema>;
/** Whether a client can keep a secret. */
export type Confidentiality = z.infer<typeof confidentialitySchema>;
/** Why a verification check produced no result. */
export type CheckFailureMode = z.infer<typeof checkFailureModeSchema>;
/** A conformance run's overall outcome. */
export type HarnessVerdict = z.infer<typeof harnessVerdictSchema>;
/** Whether a server holds a persona. */
export type PersonaCoverageOutcome = z.infer<
  typeof personaCoverageOutcomeSchema
>;
/** Whether a curated persona is still present at its source. */
export type PersonaSourceStatus = z.infer<typeof personaSourceStatusSchema>;
/** What a signing key signs. */
export type SigningKeyPurpose = z.infer<typeof signingKeyPurposeSchema>;
/** A signing key's standing. */
export type SigningKeyStatus = z.infer<typeof signingKeyStatusSchema>;
