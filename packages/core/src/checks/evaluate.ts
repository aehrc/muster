import type {
  CapabilityHighlights,
  CheckFailureMode,
  DiscoveryHighlights,
  DriftFlag,
  ScopeWarning,
  ServerProfile,
} from "@muster/contracts";
import type { CapabilityStatement } from "fhir/r4";

/**
 * Evaluating a check: what a server advertises, where that disagrees with what
 * it declared, and which requested scopes it does not support.
 *
 * Pure. The fetching happens in `apps/server/src/scheduler`, through the SSRF
 * guard; what arrives here is the outcome of each probe and what leaves is the
 * row to persist. That split is what lets every rule below be tested without a
 * network: a guarded address, a server that never answers and a server that
 * answers with nonsense are three inputs rather than three stubs.
 *
 * Deny by default applies to reading a document as much as to anything else. A
 * value that is not a SMART configuration is not read as one, and a resource
 * that is not a `CapabilityStatement` is not read as one: both come back
 * undefined and are recorded as `invalid`, because an entry the directory
 * cannot verify must not look verified.
 *
 * @author John Grimes
 */

/** How a probe of a server ended. */
export type ProbeOutcome =
  /** the server answered with a document, parsed but not yet validated */
  | { readonly ok: true; readonly document: unknown }
  /** nothing usable was obtained, and this is why */
  | {
      readonly ok: false;
      readonly failureMode: CheckFailureMode;
      readonly detail: string;
    };

/** What evaluating one check of one enrolled server needs. */
export type CheckInput = {
  /** the server profile the entry declares */
  readonly declared: ServerProfile;
  /** the SMART configuration probe */
  readonly discovery: ProbeOutcome;
  /** the capability statement probe */
  readonly capability: ProbeOutcome;
};

/** An evaluated check, in the shape the row records. */
export type CheckEvaluation = {
  /** whether the server answered either probe with a usable document */
  readonly reachable: boolean;
  /** why it did not, null when it did */
  readonly failureMode: CheckFailureMode | null;
  /** the reason a probe failed, null when neither did */
  readonly detail: string | null;
  /** what the discovery document advertises, null when it could not be read */
  readonly discovery: DiscoveryHighlights | null;
  /** what the capability statement advertises, null when it could not be read */
  readonly capability: CapabilityHighlights | null;
  /** where declared and advertised disagree */
  readonly driftFlags: readonly DriftFlag[];
};

/** A refusal that stopped a check before either probe could answer. */
export type CheckRefusal = {
  /** the classification, as `checkResult.failureMode` records it */
  readonly failureMode: CheckFailureMode;
  /** the reason, fit to show the member who reads the entry */
  readonly detail: string;
};

/** What computing a scope warning needs. */
export type ScopeWarningFacts = {
  /** the scopes the client asks for */
  readonly requested: readonly string[];
  /** the scopes the server advertises */
  readonly advertised: readonly string[];
  /** when the advertised set was read */
  readonly checkedAt: string;
};

/**
 * Which failure to report when the two probes fail differently.
 *
 * The guard's refusal comes first: it is the only one that says Muster itself
 * declined to make a request, which the reader has to know in order to fix the
 * entry rather than the server.
 */
const failurePrecedence: readonly CheckFailureMode[] = [
  "guarded",
  "timeout",
  "refused",
  "invalid",
];

/** What a probe's failure is called when the answer was unreadable. */
const unreadable = {
  discovery: "The SMART configuration was not a discovery document",
  capability: "The capability statement was not a CapabilityStatement",
} as const;

/**
 * Narrows a value to a JSON object.
 *
 * @param value - the value to narrow
 * @returns the object, or undefined when the value is not one
 */
const asObject = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/**
 * Reads a value that must be a non-blank string.
 *
 * @param value - the value to read
 * @returns the string, or null when it is absent or blank
 */
const asText = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value : null;

/**
 * Reads the string entries of a list.
 *
 * A list with a stray number in it is read for the entries that are strings:
 * discarding a whole usable document over one bad entry would tell the reader
 * less, not more.
 *
 * @param value - the value to read
 * @returns its string entries, or an empty list when it is not a list
 */
const asTextList = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];

/**
 * Drops the repeats from a list, keeping the order.
 *
 * @param values - the values
 * @returns the values, once each, in the order they first appeared
 */
const once = (values: readonly string[]): string[] => [...new Set(values)];

/**
 * Normalises a URL for comparison.
 *
 * A trailing slash is not drift. Flagging one would teach participants to
 * ignore the flags, which is worse than having none.
 *
 * @param url - the URL as declared or advertised
 * @returns the URL without a trailing slash or surrounding space
 */
const comparableUrl = (url: string): string => url.trim().replace(/\/+$/, "");

/**
 * Reads the highlights out of a SMART configuration discovery document.
 *
 * A document that names neither an authorization endpoint nor a token endpoint
 * is not a discovery document, whatever else it holds: those are the two things
 * every SMART server publishes and the two an app cannot proceed without.
 *
 * @param document - the document as fetched
 * @returns the highlights, or undefined when it is not a discovery document
 * @example
 * ```ts
 * const highlights = discoveryHighlights(await response.json());
 * ```
 */
export const discoveryHighlights = (
  document: unknown,
): DiscoveryHighlights | undefined => {
  const body = asObject(document);
  if (body === undefined) {
    return undefined;
  }
  const authorizationEndpoint = asText(body["authorization_endpoint"]);
  const tokenEndpoint = asText(body["token_endpoint"]);
  if (authorizationEndpoint === null && tokenEndpoint === null) {
    return undefined;
  }
  return {
    issuer: asText(body["issuer"]),
    authorizationEndpoint,
    tokenEndpoint,
    registrationEndpoint: asText(body["registration_endpoint"]),
    scopesSupported: asTextList(body["scopes_supported"]),
    capabilities: asTextList(body["capabilities"]),
  };
};

/**
 * Reads the highlights out of a FHIR capability statement.
 *
 * @param document - the resource as fetched
 * @returns the highlights, or undefined when it is not a CapabilityStatement
 * @example
 * ```ts
 * const highlights = capabilityHighlights(await response.json());
 * ```
 */
export const capabilityHighlights = (
  document: unknown,
): CapabilityHighlights | undefined => {
  const body = asObject(document);
  if (body === undefined || body["resourceType"] !== "CapabilityStatement") {
    return undefined;
  }
  const statement = body as unknown as CapabilityStatement;
  const rest = statement.rest ?? [];
  const softwareName = asText(statement.software?.name);
  const softwareVersion = asText(statement.software?.version);
  return {
    fhirVersion: asText(statement.fhirVersion),
    software:
      softwareName === null
        ? null
        : softwareVersion === null
          ? softwareName
          : `${softwareName} ${softwareVersion}`,
    implementationUrl: asText(statement.implementation?.url),
    securityServices: once(
      rest
        .flatMap((one) => one.security?.service ?? [])
        .flatMap((service) => service.coding ?? [])
        .map((coding) => asText(coding.code))
        .filter((code): code is string => code !== null),
    ),
    resourceTypes: once(
      rest
        .flatMap((one) => one.resource ?? [])
        .map((resource) => asText(resource.type))
        .filter((type): type is string => type !== null),
    ),
  };
};

/** One declared value, and what the server says about it. */
type Comparison = {
  /** the declared field the comparison is about */
  readonly field: string;
  /** what the entry declares, undefined when it declares nothing */
  readonly declared: string | undefined;
  /**
   * what the server advertises: a value, null when the source was read and said
   * nothing, or undefined when there was no source to read
   */
  readonly advertised: string | null | undefined;
  /** whether the server saying nothing is itself a disagreement */
  readonly flagWhenAbsent: boolean;
};

/**
 * Compares one declared value with one advertised value.
 *
 * @param comparison - the field, the two values, and how to read an absence
 * @returns the flag, or undefined when there is nothing to flag
 */
const compare = (comparison: Comparison): DriftFlag | undefined => {
  const { declared, advertised } = comparison;
  if (declared === undefined || advertised === undefined) {
    return undefined;
  }
  if (advertised === null) {
    return comparison.flagWhenAbsent
      ? { field: comparison.field, declared, advertised: null }
      : undefined;
  }
  return comparableUrl(declared) === comparableUrl(advertised)
    ? undefined
    : { field: comparison.field, declared, advertised };
};

/**
 * Finds where a declared entry disagrees with what the server advertises.
 *
 * The discovery document is treated as the authoritative list of a server's
 * endpoints, so an endpoint the entry declares and the document omits is
 * flagged. `implementation.url` is not treated that way: plenty of servers omit
 * it, and its absence says nothing about the base URL.
 *
 * @param declared - the server profile the entry declares
 * @param discovery - the discovery highlights, or null when none were read
 * @param capability - the capability highlights, or null when none were read
 * @returns one flag per disagreement, each naming both values (FR-018)
 * @example
 * ```ts
 * driftFlags(profile, discovery, capability);
 * // [{ field: "tokenEndpoint", declared: "...", advertised: "..." }]
 * ```
 */
export const driftFlags = (
  declared: ServerProfile,
  discovery: DiscoveryHighlights | null,
  capability: CapabilityHighlights | null,
): readonly DriftFlag[] => {
  const comparisons: readonly Comparison[] = [
    {
      field: "fhirBaseUrl",
      declared: declared.fhirBaseUrl,
      advertised: capability?.implementationUrl ?? undefined,
      flagWhenAbsent: false,
    },
    {
      field: "authorizationEndpoint",
      declared: declared.authorizationEndpoint,
      advertised:
        discovery === null ? undefined : discovery.authorizationEndpoint,
      flagWhenAbsent: true,
    },
    {
      field: "tokenEndpoint",
      declared: declared.tokenEndpoint,
      advertised: discovery === null ? undefined : discovery.tokenEndpoint,
      flagWhenAbsent: true,
    },
    {
      field: "registrationEndpoint",
      declared: declared.registrationEndpoint,
      advertised:
        discovery === null ? undefined : discovery.registrationEndpoint,
      flagWhenAbsent: true,
    },
  ];

  const flags = comparisons
    .map(compare)
    .filter((flag): flag is DriftFlag => flag !== undefined);

  // The other direction: an entry claiming no authorization at a server that
  // publishes SMART endpoints. An app owner needs that before writing a launch.
  return declared.authorizationMode === "open" && discovery !== null
    ? [
        ...flags,
        { field: "authorizationMode", declared: "open", advertised: "smart" },
      ]
    : flags;
};

/** What one probe yielded: highlights, or the failure that stopped it. */
type ProbeReading<Highlights> = {
  /** the highlights read, or null */
  readonly highlights: Highlights | null;
  /** the failure, or null when the probe succeeded */
  readonly failure: CheckRefusal | null;
};

/**
 * Reads one probe's outcome into highlights or a failure.
 *
 * @param outcome - how the probe ended
 * @param read - the extractor for this probe's document
 * @param unreadableDetail - what to say when the document could not be read
 * @returns the highlights, or the failure that stopped them
 */
const readProbe = <Highlights>(
  outcome: ProbeOutcome,
  read: (document: unknown) => Highlights | undefined,
  unreadableDetail: string,
): ProbeReading<Highlights> => {
  if (!outcome.ok) {
    return {
      highlights: null,
      failure: { failureMode: outcome.failureMode, detail: outcome.detail },
    };
  }
  const highlights = read(outcome.document);
  return highlights === undefined
    ? {
        highlights: null,
        failure: { failureMode: "invalid", detail: unreadableDetail },
      }
    : { highlights, failure: null };
};

/**
 * Joins the reasons a check is not clean into one sentence.
 *
 * @param details - the distinct reasons, in probe order
 * @returns the sentence, or null when there are no reasons
 */
const joinDetails = (details: readonly string[]): string | null => {
  const [first, ...rest] = once(details);
  if (first === undefined) {
    return null;
  }
  if (rest.length === 0) {
    return first;
  }
  const tail = rest
    .map((detail) => detail.charAt(0).toLowerCase() + detail.slice(1))
    .join(", and ");
  const sentence = `${first}, and ${tail}`;
  return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`;
};

/**
 * Evaluates one check of one enrolled server.
 *
 * One document is enough to call the entry reachable: a server with open access
 * publishes no SMART configuration, and refusing to call it reachable for that
 * reason would flag a correct entry. The other probe's failure is still reported
 * rather than swallowed, because a probe that was refused is news.
 *
 * @param input - the declared profile and the outcome of each probe
 * @returns the evaluation to persist
 * @example
 * ```ts
 * const evaluation = evaluateCheck({ declared, discovery, capability });
 * await insertCheckResult(sql, { enrolmentId, ...evaluation });
 * ```
 */
export const evaluateCheck = (input: CheckInput): CheckEvaluation => {
  const discovery = readProbe(
    input.discovery,
    discoveryHighlights,
    unreadable.discovery,
  );
  const capability = readProbe(
    input.capability,
    capabilityHighlights,
    unreadable.capability,
  );

  const failures = [discovery.failure, capability.failure].filter(
    (failure): failure is CheckRefusal => failure !== null,
  );
  const reachable =
    discovery.highlights !== null || capability.highlights !== null;
  const failureMode = reachable
    ? null
    : (failurePrecedence.find((mode) =>
        failures.some((failure) => failure.failureMode === mode),
      ) ?? null);

  // Only the reported failure's reasons are shown: when a guarded refusal and a
  // timeout arrive together, the guard's reason is the one that explains both.
  const reported =
    failureMode === null
      ? failures
      : failures.filter((failure) => failure.failureMode === failureMode);

  return {
    reachable,
    failureMode,
    detail: joinDetails(reported.map((failure) => failure.detail)),
    discovery: discovery.highlights,
    capability: capability.highlights,
    driftFlags: driftFlags(
      input.declared,
      discovery.highlights,
      capability.highlights,
    ),
  };
};

/**
 * Builds the evaluation of a refusal that stopped both probes.
 *
 * A target the guard refuses is recorded as a check rather than skipped: the
 * entry is flagged with the reason, which is what acceptance scenario 5 asks for
 * and what FR-020 forbids doing quietly.
 *
 * @param refusal - the failure mode and the reason
 * @returns the evaluation to persist
 * @example
 * ```ts
 * evaluateCheckFailure({ failureMode: "guarded", detail: refusal.detail });
 * ```
 */
export const evaluateCheckFailure = (
  refusal: CheckRefusal,
): CheckEvaluation => ({
  reachable: false,
  failureMode: refusal.failureMode,
  detail: refusal.detail,
  discovery: null,
  capability: null,
  driftFlags: [],
});

/** A SMART v2 resource scope, taken apart. */
type ResourceScope = {
  /** the context: `patient`, `user` or `system` */
  readonly context: string;
  /** the resource type, or `*` for every type */
  readonly resource: string;
  /** the interactions asked for, as their letters */
  readonly letters: readonly string[];
};

/** The interactions `.*` stands for. */
const everyInteraction = "cruds";

/** A SMART v2 resource scope: `patient/Observation.rs`, `user/*.cruds`. */
const resourceScopePattern =
  /^(patient|user|system)\/([A-Za-z]+|\*)\.(\*|[cruds]+)$/;

/**
 * Takes a SMART v2 resource scope apart.
 *
 * @param scope - the scope as written
 * @returns its parts, or undefined when it is not a v2 resource scope
 */
const parseResourceScope = (scope: string): ResourceScope | undefined => {
  const found = resourceScopePattern.exec(scope.trim());
  if (found === null) {
    return undefined;
  }
  const interactions = found[3] === "*" ? everyInteraction : (found[3] ?? "");
  return {
    context: found[1] ?? "",
    resource: found[2] ?? "",
    letters: [...interactions],
  };
};

/**
 * Reports whether one advertised scope covers one requested scope.
 *
 * @param requested - the scope the client asks for
 * @param advertised - the scope the server advertises
 * @returns true when the advertised scope grants the requested one
 */
const covers = (requested: string, advertised: string): boolean => {
  if (requested.trim() === advertised.trim()) {
    return true;
  }
  const asked = parseResourceScope(requested);
  const offered = parseResourceScope(advertised);
  if (asked === undefined || offered === undefined) {
    // Anything that is not a v2 resource scope - `launch`, `openid`, a v1
    // `.read` - is matched literally. Interpreting it would risk a confident
    // wrong answer, and a wrong "supported" is worse than no answer.
    return false;
  }
  return (
    asked.context === offered.context &&
    (offered.resource === "*" || offered.resource === asked.resource) &&
    asked.letters.every((letter) => offered.letters.includes(letter))
  );
};

/**
 * Finds the requested scopes a server does not support.
 *
 * An empty advertised set means the server has not said, so nothing is
 * unsupported: a warning drawn from silence would be a guess.
 *
 * @param requested - the scopes the client asks for
 * @param advertised - the scopes the server advertises
 * @returns the requested scopes nothing advertised covers
 * @example
 * ```ts
 * unsupportedScopes(["patient/Condition.rs"], ["patient/Patient.rs"]);
 * // ["patient/Condition.rs"]
 * ```
 */
export const unsupportedScopes = (
  requested: readonly string[],
  advertised: readonly string[],
): readonly string[] =>
  advertised.length === 0
    ? []
    : requested.filter(
        (scope) => !advertised.some((offered) => covers(scope, offered)),
      );

/**
 * Computes the warning a pairing carries about unsupported scopes (FR-019).
 *
 * @param facts - the requested scopes, the advertised scopes and the check time
 * @returns the warning, or undefined when every requested scope is supported
 * @example
 * ```ts
 * const warning = scopeWarning({
 *   requested: fields.scopes,
 *   advertised: check.discovery.scopesSupported,
 *   checkedAt: check.checkedAt,
 * });
 * ```
 */
export const scopeWarning = (
  facts: ScopeWarningFacts,
): ScopeWarning | undefined => {
  const unsupported = unsupportedScopes(facts.requested, facts.advertised);
  return unsupported.length === 0
    ? undefined
    : {
        unsupportedScopes: [...unsupported],
        advertisedScopes: [...facts.advertised],
        checkedAt: facts.checkedAt,
      };
};
