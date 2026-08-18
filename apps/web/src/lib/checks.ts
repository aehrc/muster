import { describeAge } from "./format.ts";

import type { Detail } from "./systemDetails.ts";
import type {
  CheckResult,
  CheckStatus,
  DriftFlag,
  ScopeWarning,
} from "@muster/contracts";

/**
 * How a check reads on screen.
 *
 * The event view exists to be trusted, and the checks are what make it
 * trustworthy, so the wording lives here as pure functions over an injected clock
 * rather than inside the pages. Both the event view and the system detail read a
 * check, and a directory that called the same state two things would be worse
 * than one that said nothing.
 *
 * Two decisions are deliberate. An entry nothing has checked is its own verdict
 * rather than a pale version of a pass: an unverified entry has to look
 * unverified (FR-017). And a guarded target is its own verdict too, because it is
 * Muster's refusal rather than the server's failure, and the reader who has to act
 * on it is the entry's owner, not the server's operator.
 *
 * @author John Grimes
 */

/** What a reader is told about an entry's verification. */
export type CheckVerdict =
  "unchecked" | "reachable" | "drifted" | "unreachable" | "guarded";

/** What the console calls each verdict. */
export const checkVerdictWords: Record<CheckVerdict, string> = {
  unchecked: "Unchecked",
  reachable: "Reachable",
  drifted: "Drift",
  unreachable: "Unreachable",
  guarded: "Refused",
};

/** How the console colours each verdict. */
export const checkVerdictClass: Record<CheckVerdict, string> = {
  unchecked: "badge-soft",
  reachable: "badge-success",
  drifted: "badge-warning",
  unreachable: "badge-error",
  guarded: "badge-error",
};

/** What each verdict means for whoever is reading it. */
export const checkVerdictMeaning: Record<CheckVerdict, string> = {
  unchecked: "Nothing has verified this entry yet.",
  reachable:
    "The server answered, and what it advertises matches what this entry declares.",
  drifted:
    "The server answered, and some of what it advertises differs from what this entry declares.",
  unreachable: "The server did not answer when it was last checked.",
  guarded:
    "Muster refused to check this address, because it is private or internal. No request was made.",
};

/** How each drifting field reads, as a person would name it. */
const driftFieldWords: Record<string, string> = {
  fhirBaseUrl: "the FHIR base URL",
  authorizationEndpoint: "the authorization endpoint",
  tokenEndpoint: "the token endpoint",
  registrationEndpoint: "the registration endpoint",
  authorizationMode: "its authorization",
};

/**
 * Joins a list into a phrase a person would read.
 *
 * @param values - the values to join
 * @returns the values, comma-separated with an `and` before the last
 */
const asPhrase = (values: readonly string[]): string =>
  values.length <= 1
    ? (values[0] ?? "")
    : `${values.slice(0, -1).join(", ")} and ${values.at(-1) ?? ""}`;

/**
 * Reads the verdict of an entry's latest check.
 *
 * @param check - the entry's check status, or null when nothing has checked it
 * @returns the verdict
 * @example
 * ```tsx
 * <span className={checkVerdictClass[checkVerdict(entry.check)]} />
 * ```
 */
export const checkVerdict = (check: CheckStatus | null): CheckVerdict => {
  if (check === null) {
    return "unchecked";
  }
  if (!check.latest.reachable) {
    return check.latest.failureMode === "guarded" ? "guarded" : "unreachable";
  }
  return check.latest.driftFlags.length === 0 ? "reachable" : "drifted";
};

/**
 * Says when an entry was checked, and when it last worked.
 *
 * @param check - the entry's check status, or null
 * @param now - the current instant
 * @returns the sentence to show
 * @example
 * ```tsx
 * <p>{describeCheckedAt(entry.check, new Date())}</p>
 * ```
 */
export const describeCheckedAt = (
  check: CheckStatus | null,
  now: Date,
): string => {
  if (check === null) {
    return "Never checked.";
  }
  const checked = `Checked ${describeAge(check.latest.checkedAt, now)}`;
  if (check.latest.reachable) {
    return `${checked}.`;
  }
  // Acceptance scenario 2: the question a stale entry raises is when it last
  // worked, so the answer travels with the failure.
  return check.lastSuccessAt === null
    ? `${checked}, never reached.`
    : `${checked}, last reached ${describeAge(check.lastSuccessAt, now)}.`;
};

/**
 * Says what one disagreement is, naming both values (FR-018).
 *
 * @param flag - the drift flag
 * @returns the sentence to show
 * @example
 * ```ts
 * driftSentence(flag);
 * // "Declares the token endpoint as https://a, but advertises https://b."
 * ```
 */
export const driftSentence = (flag: DriftFlag): string =>
  `Declares ${driftFieldWords[flag.field] ?? flag.field} as ${flag.declared}, ` +
  `but advertises ${flag.advertised ?? "none"}.`;

/**
 * Describes what a server was found to advertise.
 *
 * A field the server said nothing about is left out rather than shown blank.
 *
 * @param check - the check whose highlights to describe
 * @returns the fields to show, empty when no document was read
 * @example
 * ```tsx
 * <DetailList details={advertisedDetails(entry.check.latest)} />
 * ```
 */
export const advertisedDetails = (check: CheckResult): readonly Detail[] => {
  const discovery = check.discovery;
  const capability = check.capability;
  const details: readonly Detail[] = [
    { label: "Issuer", value: discovery?.issuer ?? "", mono: true },
    {
      label: "Authorization endpoint",
      value: discovery?.authorizationEndpoint ?? "",
      mono: true,
    },
    {
      label: "Token endpoint",
      value: discovery?.tokenEndpoint ?? "",
      mono: true,
    },
    {
      label: "Registration endpoint",
      value: discovery?.registrationEndpoint ?? "",
      mono: true,
    },
    {
      label: "Scopes supported",
      value: discovery?.scopesSupported ?? [],
      mono: true,
    },
    { label: "SMART capabilities", value: discovery?.capabilities ?? [] },
    { label: "FHIR version", value: capability?.fhirVersion ?? "" },
    { label: "Software", value: capability?.software ?? "" },
    {
      label: "Advertised base URL",
      value: capability?.implementationUrl ?? "",
      mono: true,
    },
    { label: "Security services", value: capability?.securityServices ?? [] },
    { label: "Resource types", value: capability?.resourceTypes ?? [] },
  ];
  return details.filter((detail) =>
    typeof detail.value === "string"
      ? detail.value.trim().length > 0
      : detail.value.length > 0,
  );
};

/**
 * Says which requested scopes a server does not advertise (FR-019).
 *
 * @param warning - the warning the pairing carries
 * @param serverName - what the server is called
 * @param now - the current instant
 * @returns the sentence to show both parties
 * @example
 * ```tsx
 * <span>{scopeWarningSentence(warning, pairing.server.systemName, new Date())}</span>
 * ```
 */
export const scopeWarningSentence = (
  warning: ScopeWarning,
  serverName: string,
  now: Date,
): string =>
  `${serverName} did not advertise ${asPhrase(warning.unsupportedScopes)} ` +
  `when it was checked ${describeAge(warning.checkedAt, now)}.`;
