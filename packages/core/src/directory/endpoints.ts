import { refuse } from "../accounts/rules.ts";

import type { AuthorisationDecision } from "../accounts/rules.ts";

/**
 * The rule about the scheme of a participant's endpoint.
 *
 * A participant's endpoint is an https URL. Muster posts signed software
 * statements to it, reads discovery documents from it and quotes what it read
 * back to the whole event, so plaintext is not good enough: an endpoint anybody
 * on the path can rewrite is an endpoint nothing can be vouched for.
 *
 * The one relaxation is tied to deliberate configuration. A host named in
 * `MUSTER_OUTBOUND_ALLOWLIST` may be reached over http, because that variable is
 * already the operator's statement that the host is one Muster may reach on
 * addresses the SSRF guard would otherwise refuse - the local stack's stubs, and
 * nothing else. The allowlist is empty in a deployment, so an http endpoint is
 * refused there, which is the deny-by-default direction.
 *
 * Pure, and it is the same host matching the guard itself applies
 * ({@link allowlistedHost} is what `outboundFetch` uses), so an endpoint that
 * may be recorded is exactly one the guard would go on to reach.
 *
 * @author John Grimes
 */

/** The schemes an endpoint may use at all. */
const fetchableSchemes: readonly string[] = ["http:", "https:"];

/**
 * Reports whether a URL's host is named in the outbound allowlist.
 *
 * An entry of `host` matches that host on any port; `host:port` matches only
 * that port. Host names are compared folded, since they are case-insensitive.
 *
 * Deny by default: a value that is not a URL matches nothing, because the rule
 * cannot vouch for what it could not read.
 *
 * @param url - the URL to classify, as text or already parsed
 * @param allowedHosts - the configured allowlist
 * @returns true when the allowlist names the URL's host
 * @example
 * ```ts
 * allowlistedHost("http://register-stub:9090/register", ["register-stub:9090"]);
 * // true
 * ```
 */
export const allowlistedHost = (
  url: string | URL,
  allowedHosts: readonly string[],
): boolean => {
  let target: URL;
  try {
    target = typeof url === "string" ? new URL(url) : url;
  } catch {
    return false;
  }
  const hostname = target.hostname.toLowerCase();
  const authority =
    target.port === "" ? hostname : `${hostname}:${target.port}`;
  return allowedHosts.some((entry) => {
    const candidate = entry.trim().toLowerCase();
    return candidate === hostname || candidate === authority;
  });
};

/**
 * Decides whether a set of participant endpoints may be recorded.
 *
 * An absent endpoint is not the rule's business: the optional ones are optional.
 * Everything present must be an absolute https URL, or an http URL whose host
 * the allowlist names. The first offender is reported, with its field, its value
 * and the variable that would permit it, because a refusal that named none of
 * the three leaves a member guessing.
 *
 * @param endpoints - the endpoints by the field name each arrived under
 * @param allowedHosts - the configured allowlist
 * @returns the decision, refusing with the first endpoint that failed
 * @example
 * ```ts
 * const decision = authoriseParticipantEndpoints(
 *   { fhirBaseUrl: profile.fhirBaseUrl, registrationEndpoint: profile.registrationEndpoint },
 *   config.outbound.allowedHosts,
 * );
 * if (!decision.ok) {
 *   throw refusalError(decision.refusal);
 * }
 * ```
 */
export const authoriseParticipantEndpoints = (
  endpoints: Readonly<Record<string, string | null | undefined>>,
  allowedHosts: readonly string[],
): AuthorisationDecision => {
  for (const [field, value] of Object.entries(endpoints)) {
    if (value === undefined || value === null || value.trim() === "") {
      continue;
    }
    let target: URL;
    try {
      target = new URL(value);
    } catch {
      return refuse(
        "insecure_endpoint",
        `${field} must be an absolute https URL, and ${value} is not a URL at all.`,
      );
    }
    if (!fetchableSchemes.includes(target.protocol)) {
      return refuse(
        "insecure_endpoint",
        `${field} must be an absolute https URL, and ${value} is not one: ` +
          `${target.protocol} is not a scheme Muster can reach. ` +
          "An http URL is accepted only for a host named in MUSTER_OUTBOUND_ALLOWLIST.",
      );
    }
    if (target.protocol === "http:" && !allowlistedHost(target, allowedHosts)) {
      return refuse(
        "insecure_endpoint",
        `${field} must be an https URL, and ${value} is not: ` +
          "Muster posts signed artefacts to a participant's endpoints and quotes " +
          "what it reads from them, so plaintext is refused. An http URL is " +
          `accepted only while ${target.host} is named in MUSTER_OUTBOUND_ALLOWLIST, ` +
          "which is how the local stack reaches its stubs.",
      );
    }
  }
  return { ok: true };
};
