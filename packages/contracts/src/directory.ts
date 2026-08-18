import { z } from "zod";

import { checkResultSchema, checkStatusSchema } from "./checks.ts";
import {
  accountStatusSchema,
  authorizationModeSchema,
  eventStatusSchema,
  registrationModeSchema,
} from "./common.ts";
import { httpsUrl, maximumTextLength } from "./fields.ts";

/**
 * The directory's wire shapes: accounts and sessions, organisations, systems,
 * events and enrolments.
 *
 * One definition validates a request on the server and types the response in
 * the browser, so the console cannot read a field the server does not send.
 * Contact details are a separate, optional field on every shape that can carry
 * them, because whether they appear is a decision about the caller and not
 * about the record (FR-007).
 *
 * @author John Grimes
 */

/** Shortest password accepted; a passphrase is the intended shape. */
const minimumPasswordLength = 12;

/** An email address, folded and trimmed by the server before it is stored. */
export const emailSchema = z.string().trim().min(3).max(320).includes("@");

/** A day, as `YYYY-MM-DD`. */
export const daySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must be a day as YYYY-MM-DD");

/** Whether a client can keep a secret. */
export const clientConfidentialitySchema = z.enum(["public", "confidential"]);

/** Whether a client can keep a secret. */
export type ClientConfidentiality = z.infer<typeof clientConfidentialitySchema>;

/**
 * A system's server side. The registration endpoint is required for trusted
 * DCR, because a server that says it accepts software statements without saying
 * where is not usable and the refusal belongs here rather than at mint time.
 *
 * The authorization and token endpoints are optional, and they are what a check
 * compares against the server's own discovery document (FR-018): a declared
 * value is the only thing drift can be detected from, so an entry that declares
 * neither is verified for reachability alone.
 */
export const serverProfileSchema = z
  .object({
    fhirBaseUrl: httpsUrl,
    authorizationMode: authorizationModeSchema,
    registrationMode: registrationModeSchema,
    authorizationEndpoint: httpsUrl.optional(),
    tokenEndpoint: httpsUrl.optional(),
    registrationEndpoint: httpsUrl.optional(),
    notes: z.string().max(maximumTextLength).default(""),
  })
  .refine(
    (profile) =>
      profile.registrationMode !== "trustedDcr" ||
      profile.registrationEndpoint !== undefined,
    {
      error:
        "registrationEndpoint is required when registrationMode is trustedDcr",
      path: ["registrationEndpoint"],
    },
  );

/** A system's server side. */
export type ServerProfile = z.infer<typeof serverProfileSchema>;

/** A system's client side: the standard SMART registration field set. */
export const clientProfileSchema = z.object({
  launchUrl: httpsUrl,
  redirectUris: z.array(httpsUrl).min(1),
  scopes: z.array(z.string().min(1)).default([]),
  confidentiality: clientConfidentialitySchema,
  launchContext: z.string().max(maximumTextLength).default(""),
  needsIntrospection: z.boolean().default(false),
});

/** A system's client side. */
export type ClientProfile = z.infer<typeof clientProfileSchema>;

/** What a system is: a server, a client, or both. */
export const systemKindSchema = z.enum(["server", "client"]);

/** What a system is. */
export type SystemKind = z.infer<typeof systemKindSchema>;

/** An account as the console sees it. The password hash is never in here. */
export const accountViewSchema = z.object({
  id: z.string(),
  email: z.string(),
  displayName: z.string(),
  status: accountStatusSchema,
  emailVerified: z.boolean(),
  isAdmin: z.boolean(),
});

/** An account as the console sees it. */
export type AccountView = z.infer<typeof accountViewSchema>;

/** One organisation an account belongs to. */
export const membershipSchema = z.object({
  organisationId: z.string(),
  name: z.string(),
});

/** One organisation an account belongs to. */
export type Membership = z.infer<typeof membershipSchema>;

/** Who the caller is: the answer to `/api/auth/me`. */
export const sessionViewSchema = z.object({
  account: accountViewSchema,
  memberships: z.array(membershipSchema),
});

/** Who the caller is. */
export type SessionView = z.infer<typeof sessionViewSchema>;

/** `POST /api/auth/sign-up`. */
export const signUpRequestSchema = z.object({
  email: emailSchema,
  displayName: z.string().trim().min(1).max(200),
  password: z.string().min(minimumPasswordLength).max(1024),
});

/** `POST /api/auth/sign-up`. */
export type SignUpRequest = z.infer<typeof signUpRequestSchema>;

/** `POST /api/auth/verify`. */
export const verifyRequestSchema = z.object({ token: z.string().min(1) });

/** `POST /api/auth/verify`. */
export type VerifyRequest = z.infer<typeof verifyRequestSchema>;

/** `POST /api/auth/sign-in`. */
export const signInRequestSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(1024),
});

/** `POST /api/auth/sign-in`. */
export type SignInRequest = z.infer<typeof signInRequestSchema>;

/** An organisation as any reader sees it. */
export const organisationSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
});

/** An organisation as any reader sees it. */
export type OrganisationSummary = z.infer<typeof organisationSummarySchema>;

/** A member's contact details. Never present in an anonymous response. */
export const contactSchema = z.object({
  accountId: z.string(),
  displayName: z.string(),
  email: z.string(),
});

/** A member's contact details. */
export type Contact = z.infer<typeof contactSchema>;

/** `POST /api/organisations`. */
export const createOrganisationRequestSchema = z.object({
  name: z.string().trim().min(1).max(200),
});

/** `POST /api/organisations`. */
export type CreateOrganisationRequest = z.infer<
  typeof createOrganisationRequestSchema
>;

/** `POST /api/organisations/{id}/members` and the admin reassignment. */
export const addMemberRequestSchema = z.object({ email: emailSchema });

/** `POST /api/organisations/{id}/members`. */
export type AddMemberRequest = z.infer<typeof addMemberRequestSchema>;

/** A system as any reader sees it: no contact details anywhere in here. */
export const systemRecordSchema = z.object({
  id: z.string(),
  organisationId: z.string(),
  name: z.string(),
  description: z.string(),
  kinds: z.array(systemKindSchema),
  serverProfile: serverProfileSchema.nullable(),
  clientProfile: clientProfileSchema.nullable(),
});

/** A system as any reader sees it. */
export type SystemRecord = z.infer<typeof systemRecordSchema>;

/** `POST /api/organisations/{id}/systems`. */
export const createSystemRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    description: z.string().max(maximumTextLength).default(""),
    serverProfile: serverProfileSchema.nullish(),
    clientProfile: clientProfileSchema.nullish(),
  })
  .refine(
    (system) => system.serverProfile != null || system.clientProfile != null,
    {
      error: "a system needs a server profile, a client profile, or both",
      path: ["serverProfile"],
    },
  );

/** `POST /api/organisations/{id}/systems`. */
export type CreateSystemRequest = z.infer<typeof createSystemRequestSchema>;

/** `PATCH /api/systems/{id}`; an absent field is left alone. */
export const updateSystemRequestSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(maximumTextLength).optional(),
  serverProfile: serverProfileSchema.nullish(),
  clientProfile: clientProfileSchema.nullish(),
});

/** `PATCH /api/systems/{id}`. */
export type UpdateSystemRequest = z.infer<typeof updateSystemRequestSchema>;

/** An event as a list shows it. */
export const eventSummarySchema = z.object({
  slug: z.string(),
  name: z.string(),
  startsOn: daySchema,
  endsOn: daySchema,
  status: eventStatusSchema,
});

/** An event as a list shows it. */
export type EventSummary = z.infer<typeof eventSummarySchema>;

/** An event with everything the event view needs. */
export const eventDetailSchema = eventSummarySchema.extend({
  capabilityTags: z.array(z.string()),
  personaSourceUrl: z.string().nullable(),
  graceDays: z.number().int(),
});

/** An event with everything the event view needs. */
export type EventDetail = z.infer<typeof eventDetailSchema>;

/** `POST /api/admin/events`. */
export const createEventRequestSchema = z.object({
  slug: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9-]*$/, "must be lower-case, digits and hyphens")
    .max(100),
  name: z.string().trim().min(1).max(200),
  startsOn: daySchema,
  endsOn: daySchema,
  status: eventStatusSchema.optional(),
  capabilityTags: z.array(z.string().min(1).max(100)).default([]),
  personaSourceUrl: httpsUrl.nullish(),
  graceDays: z.number().int().min(0).max(365).optional(),
});

/** `POST /api/admin/events`. */
export type CreateEventRequest = z.infer<typeof createEventRequestSchema>;

/** `PATCH /api/admin/events/{slug}`; an absent field is left alone. */
export const updateEventRequestSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  startsOn: daySchema.optional(),
  endsOn: daySchema.optional(),
  status: eventStatusSchema.optional(),
  capabilityTags: z.array(z.string().min(1).max(100)).optional(),
  personaSourceUrl: httpsUrl.nullish(),
  graceDays: z.number().int().min(0).max(365).optional(),
});

/** `PATCH /api/admin/events/{slug}`. */
export type UpdateEventRequest = z.infer<typeof updateEventRequestSchema>;

/** `POST /api/events/{slug}/enrolments`. */
export const createEnrolmentRequestSchema = z.object({
  systemId: z.string().uuid(),
  tags: z.array(z.string().min(1).max(100)).default([]),
});

/** `POST /api/events/{slug}/enrolments`. */
export type CreateEnrolmentRequest = z.infer<
  typeof createEnrolmentRequestSchema
>;

/** An enrolment as the console sees it after enrolling. */
export const enrolmentViewSchema = z.object({
  id: z.string(),
  eventSlug: z.string(),
  systemId: z.string(),
  tags: z.array(z.string()),
  confirmedAt: z.string(),
});

/** An enrolment as the console sees it. */
export type EnrolmentView = z.infer<typeof enrolmentViewSchema>;

/**
 * An enrolled system, as the event view and the system detail show it.
 *
 * `contacts` is present only for a signed-in approved member; an anonymous
 * reader gets the same shape without the field.
 *
 * `check` is the latest verification of a server entry, and null for a client
 * entry or for a server nothing has checked yet: staleness is stated rather than
 * implied (FR-017). `checkHistory` is present only on the system detail, which
 * is where a history belongs.
 */
export const enrolledSystemSchema = z.object({
  enrolmentId: z.string(),
  tags: z.array(z.string()),
  confirmedAt: z.string(),
  system: systemRecordSchema,
  organisation: organisationSummarySchema,
  contacts: z.array(contactSchema).optional(),
  check: checkStatusSchema.nullable(),
  checkHistory: z.array(checkResultSchema).optional(),
});

/** An enrolled system. */
export type EnrolledSystem = z.infer<typeof enrolledSystemSchema>;

/** `GET /api/events/{slug}/systems`. */
export const eventSystemsSchema = z.object({
  event: eventDetailSchema,
  systems: z.array(enrolledSystemSchema),
});

/** `GET /api/events/{slug}/systems`. */
export type EventSystems = z.infer<typeof eventSystemsSchema>;

/** `GET /api/events/{slug}/systems/{id}`. */
export const eventSystemSchema = z.object({
  event: eventDetailSchema,
  system: enrolledSystemSchema,
});

/** `GET /api/events/{slug}/systems/{id}`. */
export type EventSystem = z.infer<typeof eventSystemSchema>;

/** `GET /api/events`. */
export const eventsResponseSchema = z.object({
  events: z.array(eventSummarySchema),
});

/** `GET /api/events/{slug}`, and every event mutation. */
export const eventResponseSchema = z.object({ event: eventDetailSchema });

/** Every account mutation, and `POST /api/auth/sign-up`. */
export const accountResponseSchema = z.object({ account: accountViewSchema });

/** `GET /api/admin/accounts`. */
export const accountsResponseSchema = z.object({
  accounts: z.array(accountViewSchema),
});

/** `POST /api/organisations`. */
export const organisationResponseSchema = z.object({
  organisation: organisationSummarySchema,
});

/** Every membership change, and `GET /api/organisations/{id}/contacts`. */
export const contactsResponseSchema = z.object({
  contacts: z.array(contactSchema),
});

/** Every system mutation. */
export const systemResponseSchema = z.object({ system: systemRecordSchema });

/** `GET /api/organisations/{id}/systems`. */
export const systemsResponseSchema = z.object({
  systems: z.array(systemRecordSchema),
});

/** `POST /api/events/{slug}/enrolments`. */
export const enrolmentResponseSchema = z.object({
  enrolment: enrolmentViewSchema,
});

/** The profiles a stored system carries. */
type SystemProfiles = {
  /** the server profile, or null */
  readonly serverProfile: unknown;
  /** the client profile, or null */
  readonly clientProfile: unknown;
};

/**
 * Reads the kinds a stored system has, from the profiles it carries.
 *
 * @param system - the profiles as stored
 * @returns `server`, `client`, or both, in that order
 * @example
 * ```ts
 * systemKinds({ serverProfile: profile, clientProfile: null }); // ["server"]
 * ```
 */
export const systemKinds = (system: SystemProfiles): SystemKind[] => [
  ...(system.serverProfile == null ? [] : (["server"] as const)),
  ...(system.clientProfile == null ? [] : (["client"] as const)),
];
