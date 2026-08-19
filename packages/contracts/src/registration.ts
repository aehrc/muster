import { z } from "zod";

import { signingPurposeSchema } from "./common.ts";

/**
 * The trusted dynamic client registration profile's wire shapes: the published
 * keys, the software statement's claims, and the record of a registration run.
 *
 * These are `contracts/registration-profile.md` expressed as schemas. A vendor
 * implements against that document, so the claim names here are the document's
 * own - snake_case, as they appear in the signed artefact - and the server
 * validates what it produces against these schemas before answering, which is
 * what stops the published profile and the minted statement drifting apart.
 *
 * @author John Grimes
 */

/**
 * One published key.
 *
 * ES256 only, because that is what the profile tells an implementer to expect.
 * `muster_purpose` is an additional member, which JWK permits and a verifier is
 * free to ignore: it is there so that a reader of the JWKS can tell which key
 * signs statements and which signs permission tickets without asking.
 */
export const publicJwkSchema = z.object({
  kty: z.literal("EC"),
  crv: z.literal("P-256"),
  x: z.string().min(1),
  y: z.string().min(1),
  alg: z.literal("ES256"),
  use: z.literal("sig"),
  kid: z.string().min(1),
  muster_purpose: signingPurposeSchema,
});

/** One published key. */
export type PublicJwk = z.infer<typeof publicJwkSchema>;

/** `GET /.well-known/jwks.json`: every key a verifier may still need. */
export const jwksSchema = z.object({ keys: z.array(publicJwkSchema) });

/** Every key a verifier may still need. */
export type Jwks = z.infer<typeof jwksSchema>;

/** The claims a software statement carries, per the registration profile. */
export const statementClaimsSchema = z.object({
  iss: z.string().min(1),
  sub: z.string().min(1),
  software_id: z.string().min(1),
  jti: z.string().min(1),
  iat: z.number().int(),
  exp: z.number().int(),
  muster_event: z.string().min(1),
  client_name: z.string().min(1),
  redirect_uris: z.array(z.string()).min(1),
  grant_types: z.array(z.string()).min(1),
  token_endpoint_auth_method: z.string().min(1),
  scope: z.string(),
  smart_launch_url: z.string(),
});

/** The claims a software statement carries. */
export type StatementClaims = z.infer<typeof statementClaimsSchema>;

/**
 * A minted statement as either party reads it.
 *
 * The claims and the download path, never the client secret: the secret belongs
 * to the response of the one run that produced it and is not part of any record.
 */
export const softwareStatementViewSchema = z.object({
  jti: z.string(),
  keyId: z.string(),
  expiresAt: z.string(),
  claims: statementClaimsSchema,
  /** where to fetch the identical artefact (FR-027) */
  downloadPath: z.string(),
});

/** A minted statement as either party reads it. */
export type SoftwareStatementView = z.infer<typeof softwareStatementViewSchema>;

/** How one step of a registration run turned out. */
export const dcrStepOutcomeSchema = z.enum(["succeeded", "failed", "skipped"]);

/** How one step of a registration run turned out. */
export type DcrStepOutcome = z.infer<typeof dcrStepOutcomeSchema>;

/**
 * One step of a registration run, as the console reports it (FR-037).
 *
 * The run is three things happening in sequence - the statement is minted, it is
 * presented to the server, the outcome is recorded against the pairing - and a
 * member watching it needs to know which of them they are waiting for, and which
 * of them failed.
 */
export const dcrRunStepSchema = z.object({
  name: z.string(),
  outcome: dcrStepOutcomeSchema,
  detail: z.string(),
});

/** One step of a registration run. */
export type DcrRunStep = z.infer<typeof dcrRunStepSchema>;

/** The server's refusal, in RFC 7591's own vocabulary. */
export const registrationErrorSchema = z.object({
  error: z.string(),
  errorDescription: z.string().optional(),
});

/** The server's refusal. */
export type RegistrationError = z.infer<typeof registrationErrorSchema>;
