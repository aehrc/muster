import { z } from "zod";

/**
 * The permission ticket playground's wire shapes: what a member asks for, and
 * what Muster answers with.
 *
 * These are `contracts/ticket-profile.md` expressed as schemas, following the
 * SMART Permission Tickets draft 0.1.0. The claim names are the document's own -
 * snake_case, as they appear in the signed artefact - and the server parses what it
 * minted against these schemas before answering, which is what stops the published
 * profile and the minted ticket drifting apart.
 *
 * The compact JWT appears in exactly one place: the answer to the mint that
 * produced it. It is not part of the record, because the record is the claims (the
 * data model's `ticket` table) and the artefact is the member's to keep.
 *
 * @author John Grimes
 */

/** How many scope constraints one ticket may carry. */
const maximumScopes = 50;

/**
 * The ticket types in scope.
 *
 * Patient self-access only, as the specification states: the draft is 0.1.0 and
 * this is the shape it and the companion data-holder feature agree on.
 */
export const ticketTypeSchema = z.enum(["patient-self-access"]);

/** A ticket type. */
export type TicketType = z.infer<typeof ticketTypeSchema>;

/**
 * The subject of a ticket, bound by identifier.
 *
 * Nested rather than a bare string, as the profile states: a data holder resolves
 * the identifier against its own patients and needs the system as well as the
 * value to know what it is resolving.
 */
export const ticketSubjectSchema = z.object({
  identifier: z.object({
    /** the identifier system the value is asserted under */
    system: z.string().min(1),
    /** the identifier value, which is the persona's IHI */
    value: z.string().min(1),
  }),
});

/** The subject of a ticket. */
export type TicketSubject = z.infer<typeof ticketSubjectSchema>;

/** The claims a permission ticket carries, per the ticket profile. */
export const ticketClaimsSchema = z.object({
  iss: z.string().min(1),
  jti: z.string().min(1),
  iat: z.number().int(),
  exp: z.number().int(),
  ticket_type: ticketTypeSchema,
  subject: ticketSubjectSchema,
  smart_scopes: z.string().min(1),
  muster_event: z.string().min(1),
});

/** The claims a permission ticket carries. */
export type TicketClaims = z.infer<typeof ticketClaimsSchema>;

/**
 * A minted ticket as the record holds it.
 *
 * The claims, the key, the persona and the moment - and no artefact. What was
 * signed is reconstructible from the claims for a reader who wants to check them;
 * what was handed over is not stored at all.
 */
export const ticketRecordSchema = z.object({
  jti: z.string(),
  keyId: z.string(),
  personaId: z.string(),
  /** when it was minted, and by implication who by: the member who asked */
  mintedAt: z.string(),
  expiresAt: z.string(),
  claims: ticketClaimsSchema,
});

/** A minted ticket as the record holds it. */
export type TicketRecord = z.infer<typeof ticketRecordSchema>;

/**
 * `POST /api/events/{slug}/tickets`.
 *
 * `validUntil` is a ceiling request rather than a setting: Muster caps it at the
 * event's end plus its grace days, and a request without one takes the cap
 * (FR-033).
 */
export const createTicketRequestSchema = z.object({
  personaId: z.string().uuid(),
  ticketType: ticketTypeSchema.default("patient-self-access"),
  scopes: z.array(z.string().trim().min(1).max(200)).min(1).max(maximumScopes),
  validUntil: z.iso.datetime().optional(),
});

/** `POST /api/events/{slug}/tickets`. */
export type CreateTicketRequest = z.infer<typeof createTicketRequestSchema>;

/**
 * The answer to a mint: the compact ticket, and its record.
 *
 * Both, because the playground shows the decoded claims beside the compact form
 * (FR-034) and because this is the only time the artefact is available: it is
 * never stored, never logged and never retrievable.
 */
export const ticketResponseSchema = z.object({
  /** the compact JWS, shown this once */
  jwt: z.string().min(1),
  ticket: ticketRecordSchema,
});

/** The answer to a mint. */
export type TicketResponse = z.infer<typeof ticketResponseSchema>;
