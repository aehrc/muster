/**
 * The directory's shapes: what a participant may send, and what the reader gets back.
 *
 * One module, shared by the server and the console, so that a field the console renders
 * cannot drift from the field the server stores. The request schemas are the validation
 * boundary - a body that fails one of them never reaches a repository - and the response
 * schemas exist for their inferred types, which is what stops a page from rendering a
 * property the API does not send.
 *
 * Two rules are encoded here rather than left to a route, because both are constraints
 * from `data-model.md` that more than one route has to hold: a system must carry at
 * least one profile, and a `trustedDcr` server must declare the endpoint it will be
 * registered at. A route that forgot either would accept a record no later phase can
 * use.
 *
 * **What is deliberately absent.** No response shape here carries an email address or
 * any other contact detail except {@link organisationContactsSchema} and
 * {@link sessionAccountSchema} - the members-only feed and the caller's own account.
 * That is constitution principle V made checkable: a new public field added to the wrong
 * schema is visible in this file.
 *
 * Author: John Grimes
 */

import { z } from "zod";

import {
  checkDetailSchema,
  checkStatusSchema,
  checkSummarySchema,
} from "./checks.js";
import {
  accountStatusSchema,
  authorizationModeSchema,
  confidentialitySchema,
  eventStatusSchema,
  registrationModeSchema,
  slugSchema,
} from "./common.js";

/**
 * An `https` URL a participant declares.
 *
 * Plain `http` is refused at the boundary rather than at fetch time, so a participant
 * finds out while they are looking at the form. The outbound guard refuses it again -
 * two checks, because this one is about the record being right and that one is about the
 * network Muster runs in.
 */
export const httpsUrlSchema = z.url({ protocol: /^https$/ });

/**
 * A URL a client launches or is redirected to.
 *
 * Not restricted to `https`: Muster never fetches these, and a participant testing
 * against `http://localhost:4000/callback` has a legitimate redirect URI that a server
 * may still accept.
 */
export const clientUrlSchema = z.url();

/**
 * A capability tag, as an event defines them.
 *
 * Lower case, because the tags are compared and filtered on and two spellings of one
 * tag would split a filter. Spaces are allowed - FR-008's own example is "form renderer
 * host" - and so are the hyphenated forms the wireframes use.
 */
export const capabilityTagSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9 -]*$/, {
    message: "Must be lower case alphanumeric with spaces or hyphens",
  });

/** Whether a system is a server, a client, or both. */
export const systemKindSchema = z.enum(["server", "client"]);

/**
 * What a participant declares about a system acting as a server (FR-006).
 *
 * `registrationEndpoint` is checked against `registrationMode` rather than left
 * optional: a `trustedDcr` server with nowhere to present a software statement is an
 * entry that promises zero-touch registration and cannot deliver it.
 */
export const serverProfileSchema = z
  .object({
    fhirBaseUrl: httpsUrlSchema,
    authorizationMode: authorizationModeSchema,
    registrationMode: registrationModeSchema,
    registrationEndpoint: httpsUrlSchema.nullable().default(null),
    /**
     * The authorization endpoint the owner says their server uses.
     *
     * Optional, and not in `data-model.md`'s original field list. It is here because
     * spec scenario 3 and quickstart scenario 5 both describe drift as "a declared
     * authorization endpoint differing from the discovery document" - which is not a
     * comparison a record with no declared endpoint can make. Declaring one is what
     * lets FR-018 name both values; leaving it null means the check has nothing to
     * disagree with and says nothing.
     */
    authorizationEndpoint: httpsUrlSchema.nullable().default(null),
    /** The token endpoint the owner says their server uses. See above. */
    tokenEndpoint: httpsUrlSchema.nullable().default(null),
    notes: z.string().max(4000).default(""),
  })
  .check((ctx) => {
    if (
      ctx.value.registrationMode === "trustedDcr" &&
      ctx.value.registrationEndpoint === null
    ) {
      ctx.issues.push({
        code: "custom",
        message:
          "A trusted DCR server must declare the registration endpoint statements are presented to",
        input: ctx.value,
        path: ["registrationEndpoint"],
      });
    }
  });

/** What a participant declares about a system acting as a client (FR-006). */
export const clientProfileSchema = z.object({
  launchUrl: clientUrlSchema,
  redirectUris: z.array(clientUrlSchema).min(1).max(20),
  /**
   * At least one. A client entry with no scopes tells a server owner nothing about what
   * it would ask for, which is the one thing the pairing workflow needs from it.
   */
  scopes: z.array(z.string().trim().min(1).max(200)).min(1).max(100),
  confidentiality: confidentialitySchema,
  /** Free text: which launch context the client needs the server to supply. */
  launchContext: z.string().max(2000).default(""),
  needsIntrospection: z.boolean(),
});

/**
 * A system as its owner submits it, on create and on edit.
 *
 * The same shape serves both: the console's form holds the whole record, and a PATCH
 * carrying every editable field is one code path rather than two - the second of which
 * would be the partial-update path nobody tests.
 */
export const systemInputSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    description: z.string().max(4000).default(""),
    serverProfile: serverProfileSchema.nullable().default(null),
    clientProfile: clientProfileSchema.nullable().default(null),
  })
  .check((ctx) => {
    if (ctx.value.serverProfile === null && ctx.value.clientProfile === null) {
      ctx.issues.push({
        code: "custom",
        message: "A system must be a server, a client, or both",
        input: ctx.value,
        path: ["serverProfile"],
      });
    }
  });

/** Creating an organisation. The caller becomes its first member. */
export const organisationInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
});

/** Inviting an already-approved account into an organisation, by address. */
export const organisationInviteSchema = z.object({
  email: z.email().max(320),
});

/** An event as an admin creates it (FR-008). */
export const eventInputSchema = z
  .object({
    slug: slugSchema,
    name: z.string().trim().min(1).max(200),
    startsOn: z.iso.date(),
    endsOn: z.iso.date(),
    capabilityTags: z.array(capabilityTagSchema).max(50).default([]),
    personaSourceUrl: httpsUrlSchema.nullable().default(null),
    /** Days past `endsOn` that statements and tickets may still be valid for. */
    graceDays: z.number().int().min(0).max(90).default(7),
  })
  .check((ctx) => {
    if (ctx.value.endsOn < ctx.value.startsOn) {
      ctx.issues.push({
        code: "custom",
        message: "An event cannot end before it starts",
        input: ctx.value,
        path: ["endsOn"],
      });
    }
  });

/**
 * The fields an admin may change on an existing event.
 *
 * `slug` is absent: every public address for an event is built from it, so changing one
 * would break the links already handed out. `status` is here because opening and closing
 * an event is an edit rather than a separate verb, per `contracts/http-api.md`.
 */
export const eventPatchSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  startsOn: z.iso.date().optional(),
  endsOn: z.iso.date().optional(),
  capabilityTags: z.array(capabilityTagSchema).max(50).optional(),
  personaSourceUrl: httpsUrlSchema.nullable().optional(),
  graceDays: z.number().int().min(0).max(90).optional(),
  status: eventStatusSchema.optional(),
});

/** Enrolling a system into an event, confirming its details are current (FR-009). */
export const enrolmentInputSchema = z.object({
  systemId: z.uuid(),
  tags: z.array(capabilityTagSchema).max(50).default([]),
});

/** Adding a member to an organisation whose own members have all left. */
export const reassignInputSchema = z.object({
  email: z.email().max(320),
});

/** Signing up. The account is created pending, with its address unverified. */
export const signUpSchema = z.object({
  email: z.email().max(320),
  displayName: z.string().trim().min(1).max(200),
  /**
   * Twelve characters, and no composition rules.
   *
   * Length is the only requirement that reliably buys anything; character-class rules
   * mostly buy `Password1!`. There is no upper bound worth enforcing beyond stopping a
   * megabyte from reaching the hasher.
   */
  password: z.string().min(12).max(200),
});

/** Redeeming a verification link. */
export const verifyEmailSchema = z.object({
  token: z.string().min(1).max(200),
});

/** Asking for another verification link. */
export const resendVerificationSchema = z.object({
  email: z.email().max(320),
});

/** Signing in. */
export const signInSchema = z.object({
  email: z.email().max(320),
  password: z.string().min(1).max(200),
});

// ---------------------------------------------------------------------------
// What the reader gets back.
// ---------------------------------------------------------------------------

/** An organisation, named just enough to attribute a system to it. */
export const organisationRefSchema = z.object({
  id: z.uuid(),
  name: z.string(),
});

/** An event in a list. */
export const eventSummarySchema = z.object({
  slug: z.string(),
  name: z.string(),
  startsOn: z.string(),
  endsOn: z.string(),
  status: eventStatusSchema,
});

/** An event on its own page, with the tags its enrolments may choose from. */
export const eventDetailSchema = eventSummarySchema.extend({
  capabilityTags: z.array(z.string()),
  personaSourceUrl: z.string().nullable(),
  graceDays: z.number().int(),
});

/**
 * An enrolled system, as the public event view and the public JSON API present it.
 *
 * Carries no contact detail of any kind (FR-007). The owning organisation appears as a
 * name, because two organisations may hold systems with the same name and the reader has
 * to be able to tell them apart (spec edge case).
 *
 * The DCR-verified badge is not here yet: no harness has run, and a badge for a server
 * nobody has tested would be a claim rather than an absence. User Story 6 adds it.
 */
export const enrolledSystemSchema = z.object({
  systemId: z.uuid(),
  enrolmentId: z.uuid(),
  name: z.string(),
  description: z.string(),
  organisation: organisationRefSchema,
  kinds: z.array(systemKindSchema),
  serverProfile: serverProfileSchema.nullable(),
  clientProfile: clientProfileSchema.nullable(),
  tags: z.array(z.string()),
  /** When the owner last confirmed the details were current. */
  confirmedAt: z.string(),
  /**
   * The latest verification check, or null when none has run (FR-017).
   *
   * Null rather than a manufactured failure: a server nobody has looked at has not been
   * found unreachable, and saying so would be a claim rather than an absence. A client
   * that is not also a server is never checked, so its entry carries null for good.
   */
  check: checkStatusSchema.nullable(),
});

/**
 * One enrolled system on its own page, with the whole of its verification record.
 *
 * The advertised documents and the check history are here and not on the listing: twenty
 * servers' scopes and resource types would multiply the listing's size for a page that
 * shows a badge and a time.
 */
export const enrolledSystemDetailSchema = enrolledSystemSchema.extend({
  check: checkDetailSchema.nullable(),
  /** Newest first. The history is retained, per `data-model.md`. */
  checkHistory: z.array(checkSummarySchema),
});

/** One person's contact details. Members only, never public (FR-007). */
export const contactSchema = z.object({
  accountId: z.uuid(),
  displayName: z.string(),
  email: z.string(),
  joinedAt: z.string(),
});

/** An organisation's contact details: who to talk to, and how. */
export const organisationContactsSchema = z.object({
  organisation: organisationRefSchema,
  members: z.array(contactSchema),
});

/** One of an organisation's systems, with where it is enrolled. */
export const organisationSystemSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  description: z.string(),
  kinds: z.array(systemKindSchema),
  serverProfile: serverProfileSchema.nullable(),
  clientProfile: clientProfileSchema.nullable(),
  enrolments: z.array(
    z.object({
      id: z.uuid(),
      eventSlug: z.string(),
      eventName: z.string(),
      eventStatus: eventStatusSchema,
      tags: z.array(z.string()),
      confirmedAt: z.string(),
    }),
  ),
});

/** An organisation the caller belongs to, with everything its page shows. */
export const myOrganisationSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  members: z.array(contactSchema),
  systems: z.array(organisationSystemSchema),
});

/** Which organisations an account belongs to. */
export const membershipSchema = z.object({
  organisationId: z.uuid(),
  organisationName: z.string(),
  joinedAt: z.string(),
});

/** The caller's own account, as `GET /api/auth/me` reports it. */
export const sessionAccountSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  displayName: z.string(),
  status: accountStatusSchema,
  isAdmin: z.boolean(),
  emailVerified: z.boolean(),
  /**
   * Why this account may not create or edit content, or null when it may.
   *
   * Sent rather than derived in the browser so that the console's banner and the
   * server's refusal cannot disagree about why (FR-037).
   */
  writeRefusal: z.string().nullable(),
});

/**
 * Who the caller is.
 *
 * `account` is null for an anonymous visitor, and the status code is still 200: every
 * public page asks this question on load, and answering a visitor's ordinary state with
 * an error would make the console treat browsing without an account as a failure.
 */
export const meSchema = z.object({
  account: sessionAccountSchema.nullable(),
  memberships: z.array(membershipSchema),
});

/** An account in the admin queue, with the memberships it has accumulated. */
export const adminAccountSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  displayName: z.string(),
  status: accountStatusSchema,
  isAdmin: z.boolean(),
  emailVerifiedAt: z.string().nullable(),
  createdAt: z.string(),
  approvedAt: z.string().nullable(),
  organisations: z.array(organisationRefSchema),
});

/**
 * The outcome of creating or editing an event.
 *
 * `lapsedPairings` is part of the answer rather than a detail: closing an event retires other
 * people's open pairing requests (FR-011), and an admin who did that should see how many rather
 * than find out from the notifications (FR-037).
 */
export const eventChangeSchema = z.object({
  event: eventDetailSchema,
  lapsedPairings: z.number().int(),
});

/**
 * The outcome of approving or revoking an account.
 *
 * `notified` is part of the answer, not a detail: an admin who approves somebody is
 * telling them by email, and an approval whose notification bounced has to say so rather
 * than report plain success (FR-003, FR-037).
 */
export const accountDecisionSchema = z.object({
  account: adminAccountSchema,
  notified: z.boolean(),
});

/** An https URL a participant declares. */
export type HttpsUrl = z.infer<typeof httpsUrlSchema>;
/** A capability tag, as an event defines them. */
export type CapabilityTag = z.infer<typeof capabilityTagSchema>;
/** Whether a system is a server, a client, or both. */
export type SystemKind = z.infer<typeof systemKindSchema>;
/** What a participant declares about a system acting as a server. */
export type ServerProfile = z.infer<typeof serverProfileSchema>;
/** What a participant declares about a system acting as a client. */
export type ClientProfile = z.infer<typeof clientProfileSchema>;
/** A system as its owner submits it. */
export type SystemInput = z.infer<typeof systemInputSchema>;
/** Creating an organisation. */
export type OrganisationInput = z.infer<typeof organisationInputSchema>;
/** Inviting an approved account into an organisation. */
export type OrganisationInvite = z.infer<typeof organisationInviteSchema>;
/** An event as an admin creates it. */
export type EventInput = z.infer<typeof eventInputSchema>;
/** The fields an admin may change on an existing event. */
export type EventPatch = z.infer<typeof eventPatchSchema>;
/** Enrolling a system into an event. */
export type EnrolmentInput = z.infer<typeof enrolmentInputSchema>;
/** Adding a member to an orphaned organisation. */
export type ReassignInput = z.infer<typeof reassignInputSchema>;
/** Signing up. */
export type SignUp = z.infer<typeof signUpSchema>;
/** Redeeming a verification link. */
export type VerifyEmail = z.infer<typeof verifyEmailSchema>;
/** Asking for another verification link. */
export type ResendVerification = z.infer<typeof resendVerificationSchema>;
/** Signing in. */
export type SignIn = z.infer<typeof signInSchema>;
/** An organisation, named just enough to attribute a system to it. */
export type OrganisationRef = z.infer<typeof organisationRefSchema>;
/** An event in a list. */
export type EventSummary = z.infer<typeof eventSummarySchema>;
/** An event on its own page. */
export type EventDetail = z.infer<typeof eventDetailSchema>;
/** An enrolled system, as the public surfaces present it. */
export type EnrolledSystem = z.infer<typeof enrolledSystemSchema>;
/** One enrolled system on its own page, with its whole verification record. */
export type EnrolledSystemDetail = z.infer<typeof enrolledSystemDetailSchema>;
/** One person's contact details. */
export type Contact = z.infer<typeof contactSchema>;
/** An organisation's contact details. */
export type OrganisationContacts = z.infer<typeof organisationContactsSchema>;
/** One of an organisation's systems, with where it is enrolled. */
export type OrganisationSystem = z.infer<typeof organisationSystemSchema>;
/** An organisation the caller belongs to. */
export type MyOrganisation = z.infer<typeof myOrganisationSchema>;
/** Which organisations an account belongs to. */
export type Membership = z.infer<typeof membershipSchema>;
/** The caller's own account. */
export type SessionAccount = z.infer<typeof sessionAccountSchema>;
/** Who the caller is. */
export type Me = z.infer<typeof meSchema>;
/** An account in the admin queue. */
export type AdminAccount = z.infer<typeof adminAccountSchema>;
/** The outcome of creating or editing an event. */
export type EventChange = z.infer<typeof eventChangeSchema>;
/** The outcome of approving or revoking an account. */
export type AccountDecision = z.infer<typeof accountDecisionSchema>;
