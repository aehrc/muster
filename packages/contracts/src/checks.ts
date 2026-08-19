import { z } from "zod";

import { checkFailureModeSchema, harnessVerdictSchema } from "./common.ts";

/**
 * The wire shapes of live verification: what a server was found to advertise,
 * where that disagrees with what it declared, and the scope warning a pairing
 * carries.
 *
 * Checks are public (SC-006): every shape in here is answered to an anonymous
 * caller, and none of them can carry a contact detail, because none of them has
 * a field for one.
 *
 * A drift flag names the field, the declared value and the advertised value, in
 * those three fields and no others (FR-018): a flag that said only "the token
 * endpoint is wrong" would leave a participant to go and find both values for
 * themselves, which is the round-trip verification exists to remove.
 *
 * @author John Grimes
 */

/** One disagreement between what a system declares and what it advertises. */
export const driftFlagSchema = z.object({
  /** the declared field the disagreement is about */
  field: z.string(),
  /** what the directory entry says */
  declared: z.string(),
  /** what the server says, or null when it says nothing at all */
  advertised: z.string().nullable(),
});

/** One disagreement between declared and advertised. */
export type DriftFlag = z.infer<typeof driftFlagSchema>;

/**
 * What a server's SMART configuration discovery document advertises.
 *
 * The highlights the event view shows and the pairing warning needs, rather than
 * the whole document: the endpoints, the scopes and the capabilities.
 */
export const discoveryHighlightsSchema = z.object({
  /** the issuer identifier */
  issuer: z.string().nullable(),
  /** where an app sends a user to authorize */
  authorizationEndpoint: z.string().nullable(),
  /** where an app exchanges a code for a token */
  tokenEndpoint: z.string().nullable(),
  /** where an app registers itself, when the server accepts registrations */
  registrationEndpoint: z.string().nullable(),
  /** the scopes the server says it supports */
  scopesSupported: z.array(z.string()),
  /** the SMART capabilities the server says it has */
  capabilities: z.array(z.string()),
});

/** What a server's discovery document advertises. */
export type DiscoveryHighlights = z.infer<typeof discoveryHighlightsSchema>;

/** What a server's FHIR capability statement advertises. */
export const capabilityHighlightsSchema = z.object({
  /** the FHIR version it implements */
  fhirVersion: z.string().nullable(),
  /** the software behind it, with its version when it names one */
  software: z.string().nullable(),
  /** the base URL the statement says the instance is at */
  implementationUrl: z.string().nullable(),
  /** the security services its REST interface names, as codes */
  securityServices: z.array(z.string()),
  /** the resource types its REST interface names */
  resourceTypes: z.array(z.string()),
});

/** What a server's capability statement advertises. */
export type CapabilityHighlights = z.infer<typeof capabilityHighlightsSchema>;

/** One recorded check of one enrolled server. */
export const checkResultSchema = z.object({
  id: z.string(),
  /** when the check ran */
  checkedAt: z.string(),
  /** whether the server answered either probe with a document */
  reachable: z.boolean(),
  /** why it did not, null when it did */
  failureMode: checkFailureModeSchema.nullable(),
  /**
   * the reason in words, present whenever a probe failed - including on a
   * reachable entry, because a guarded or unreadable probe is reported rather
   * than skipped
   */
  detail: z.string().nullable(),
  /** the discovery highlights, null when the document could not be read */
  discovery: discoveryHighlightsSchema.nullable(),
  /** the capability highlights, null when the statement could not be read */
  capability: capabilityHighlightsSchema.nullable(),
  /** where declared and advertised disagree */
  driftFlags: z.array(driftFlagSchema),
});

/** One recorded check. */
export type CheckResult = z.infer<typeof checkResultSchema>;

/**
 * An enrolled server's verification status.
 *
 * The last successful check is carried alongside the latest one because that is
 * what acceptance scenario 2 asks for: an entry that has stopped answering shows
 * when it last did.
 */
export const checkStatusSchema = z.object({
  /** the most recent check */
  latest: checkResultSchema,
  /** when the entry was last reached, null when it never has been */
  lastSuccessAt: z.string().nullable(),
});

/** An enrolled server's verification status. */
export type CheckStatus = z.infer<typeof checkStatusSchema>;

/**
 * An entry's conformance standing: the verdict of its latest harness run.
 *
 * Only a `passed` verdict earns the "DCR verified" badge, and any later failing
 * run replaces it, so the badge is never older than the newest evidence
 * (FR-030). The identifier is here so a reader can open the report the verdict
 * came from, which is what makes the badge checkable rather than decorative.
 *
 * It lives beside the check status rather than with the harness shapes because
 * the directory's own shapes carry it, and a conformance module that imported
 * them while they imported it would be a cycle.
 */
export const conformanceStatusSchema = z.object({
  /** the run the verdict came from */
  runId: z.string(),
  /** how it turned out */
  verdict: harnessVerdictSchema,
  /** when it ran */
  ranAt: z.string(),
});

/** An entry's conformance standing. */
export type ConformanceStatus = z.infer<typeof conformanceStatusSchema>;

/**
 * The warning a pairing carries when the client asks for scopes the server does
 * not advertise (FR-019).
 *
 * Both the unsupported scopes and the advertised set are named, so neither party
 * has to go and look the server's set up to act on the warning.
 */
export const scopeWarningSchema = z.object({
  /** the requested scopes absent from the advertised set */
  unsupportedScopes: z.array(z.string()),
  /** the whole set the server advertises */
  advertisedScopes: z.array(z.string()),
  /** when the advertised set was last read from the server */
  checkedAt: z.string(),
});

/** The warning a pairing carries about unsupported scopes. */
export type ScopeWarning = z.infer<typeof scopeWarningSchema>;
