/**
 * What a permission ticket says about itself, on the wire.
 *
 * Three decisions worth stating.
 *
 * **The claim set is spelled out rather than left as a bag.** These are the claims a data
 * holder reads, tabulated in `contracts/ticket-profile.md`, so the playground showing them
 * and the server signing them agree on the vocabulary by construction. A `z.record` would
 * have let a renamed claim through both, and the contract is what Signet's
 * `002-trusted-dcr-tickets` implements against.
 *
 * **The compact JWT appears here and on no read surface.** It is the response of the mint
 * that produced it and nothing else, because there is no read surface it could be on: the
 * ticket is displayed once and not stored (`data-model.md`, constitution principle IV). That
 * is the opposite arrangement from a software statement, which is stored and downloadable -
 * a statement is presented to a registration endpoint by its owner, and a ticket is a
 * bearer credential for somebody's health record.
 *
 * **The validity a member asks for is a calendar date, not an instant.** The form is a date
 * picker and the cap is derived from the event's last day, so both sides of the comparison
 * are days. What the ticket carries is still an instant, derived from the day.
 *
 * Author: John Grimes
 */

import { z } from "zod";

import { slugSchema } from "./common.js";

/** The ticket types Muster mints. Only patient self-access is in scope (spec assumptions). */
export const permissionTicketTypeSchema = z.enum(["patient-self-access"]);

/** How a ticket names its subject: a FHIR-style system and value, never a value alone. */
export const ticketSubjectSchema = z.object({
  identifier: z.object({
    /** The IHI namespace, fixed by configuration for the deployment. */
    system: z.string(),
    value: z.string(),
  }),
});

/**
 * The claims of a permission ticket, per `contracts/ticket-profile.md`.
 *
 * snake_case, because they are JWT claims rather than TypeScript fields.
 */
export const permissionTicketClaimsSchema = z.object({
  /** The issuer identifier: Muster's public URL. */
  iss: z.string(),
  /** The ticket identifier, unique across every ticket Muster has minted. */
  jti: z.string(),
  iat: z.number().int(),
  /** Never later than event end plus the event's grace period (FR-033). */
  exp: z.number().int(),
  ticket_type: permissionTicketTypeSchema,
  subject: ticketSubjectSchema,
  /** Space-separated scope constraints, as chosen at mint. */
  smart_scopes: z.string(),
  muster_event: slugSchema,
});

/**
 * A minted ticket, as the playground displays it (FR-034).
 *
 * The compact JWT beside its decoded claims, which is the requirement: a member has to be
 * able to copy the artefact into their client and to see what it says without decoding it
 * themselves.
 */
export const mintedTicketSchema = z.object({
  /** The compact JWS. Shown once; Muster does not store it and cannot show it again. */
  jwt: z.string(),
  jti: z.string(),
  /** The `kid` of the key it was signed with, so a reader can match it to the JWKS. */
  keyId: z.string(),
  claims: permissionTicketClaimsSchema,
  expiresAt: z.string(),
  mintedAt: z.string(),
  /** The persona the subject was bound to, so the panel can name who it is about. */
  personaId: z.uuid(),
});

/**
 * What a mint asks for.
 *
 * `validUntil` is a request rather than an instruction: the expiry is derived from the
 * event and the smaller of the two wins, so a date beyond the event's grace yields the cap
 * rather than a refusal.
 */
export const ticketMintInputSchema = z.object({
  personaId: z.uuid(),
  ticketType: permissionTicketTypeSchema.default("patient-self-access"),
  scopes: z.array(z.string().min(1)),
  /** The last day the ticket should be good for, as `YYYY-MM-DD`, or null for the cap. */
  validUntil: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, { message: "Must be a date, as YYYY-MM-DD" })
    .nullable()
    .default(null),
});

/** A ticket type Muster mints. */
export type PermissionTicketType = z.infer<typeof permissionTicketTypeSchema>;
/** How a ticket names its subject. */
export type TicketSubject = z.infer<typeof ticketSubjectSchema>;
/** The claims of a permission ticket. */
export type PermissionTicketClaimsView = z.infer<
  typeof permissionTicketClaimsSchema
>;
/** A minted ticket, as the playground displays it. */
export type MintedTicket = z.infer<typeof mintedTicketSchema>;
/** What a mint asks for. */
export type TicketMintInput = z.infer<typeof ticketMintInputSchema>;
