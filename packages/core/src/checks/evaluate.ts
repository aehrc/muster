/**
 * What a verification check concludes.
 *
 * Every claim User Story 3 puts on a public page is decided here: whether a server
 * answered, why it did not, what it advertises, where that disagrees with what its owner
 * declared, and which of a client's scopes it will not honour. None of that involves I/O -
 * the scheduler in `apps/server` fetches two documents through the SSRF guard and hands the
 * outcomes to {@link evaluateCheck} - so all of it is pure, per constitution principle II,
 * and exhaustively testable without standing anything up.
 *
 * ## Reachable and failed are one fact
 *
 * `reachable` is true exactly when `failureMode` is null, and the database holds that as a
 * check constraint. The alternative - a reachable server carrying a timeout - would put
 * "Reachable" and "timed out" on the same line of the event view, and a reader would
 * rightly stop believing either.
 *
 * A server is reachable when at least one of the two documents came back usable. Not both:
 * an open FHIR endpoint has no `smart-configuration` to serve and is not thereby
 * unreachable, and a server that serves a SMART configuration but no CapabilityStatement is
 * still answering. What is *not* reachable is a server that answered with nothing usable at
 * either address, which is recorded as `invalid` rather than as a refusal: the connection
 * worked and the content did not.
 *
 * ## Drift is a comparison of two stated things
 *
 * A flag is raised only where the owner declared a value, the server advertised one, and the
 * two differ. Absence is not disagreement: a server that serves no discovery
 * document has said nothing about its token endpoint, and flagging that would put a drift
 * badge on every open FHIR endpoint in the directory. Two spellings of one URL are
 * agreement, because a flag whose two values look identical to a reader teaches them to
 * ignore the flags that matter.
 *
 * `authorizationEndpoint` and `tokenEndpoint` are declared fields that `data-model.md`'s
 * original table does not carry. They are there because spec scenario 3 and quickstart
 * scenario 5 both describe drift as a declared authorization or token endpoint differing
 * from the discovery document, which is not a comparison a record with no such field can
 * make.
 *
 * Author: John Grimes
 */

import type { CapabilityStatement } from "fhir/r4";

/** Why a verification check produced no usable result. */
export type CheckFailureMode = "timeout" | "refused" | "guarded" | "invalid";

/**
 * Why the outbound guard did not produce a response.
 *
 * The same vocabulary as `OutboundRefusal` in `apps/server`, declared here because this
 * package is the domain and may not depend on the server that fetches for it.
 */
export type OutboundFailureReason =
  | "not-a-url"
  | "insecure-scheme"
  | "userinfo"
  | "blocked-address"
  | "unresolvable"
  | "redirect-not-followed"
  | "too-many-redirects"
  | "timeout"
  | "refused"
  | "too-large";

/**
 * The smart-configuration highlights a check records.
 *
 * A fixed projection rather than the document as served: the body came from a participant's
 * server, and storing it whole would republish whatever else they chose to put in it.
 */
export interface DiscoveryHighlights {
  readonly issuer: string | null;
  readonly authorizationEndpoint: string | null;
  readonly tokenEndpoint: string | null;
  readonly registrationEndpoint: string | null;
  readonly introspectionEndpoint: string | null;
  readonly jwksUri: string | null;
  readonly scopesSupported: readonly string[];
  readonly capabilities: readonly string[];
  readonly grantTypesSupported: readonly string[];
  /**
   * `smart_permission_ticket_types_supported`.
   *
   * Recorded now and surfaced by the ticket playground (FR-034), so that "which servers
   * accept a ticket?" is answered from a recorded fact rather than by re-fetching every
   * server when somebody opens the playground.
   */
  readonly permissionTicketTypesSupported: readonly string[];
}

/** The CapabilityStatement highlights a check records. */
export interface CapabilityHighlights {
  readonly fhirVersion: string | null;
  readonly softwareName: string | null;
  readonly softwareVersion: string | null;
  /** `implementation.url`: the server's own statement of where it lives. */
  readonly implementationUrl: string | null;
  readonly resourceTypes: readonly string[];
  readonly smartAuthorizationEndpoint: string | null;
  readonly smartTokenEndpoint: string | null;
  readonly smartRegisterEndpoint: string | null;
}

/** One disagreement between a declared detail and an advertised one (FR-018). */
export interface DriftFlag {
  readonly field: string;
  readonly declared: string;
  readonly advertised: string;
}

/** What a participant declared about a server, as the drift rules read it. */
export interface DeclaredServerDetails {
  readonly fhirBaseUrl: string;
  readonly authorizationMode: "open" | "smart";
  readonly authorizationEndpoint?: string | null;
  readonly tokenEndpoint?: string | null;
  readonly registrationEndpoint?: string | null;
}

/** One document fetch, as the guard reported it. */
export type CheckFetch =
  | { readonly ok: true; readonly status: number; readonly body: string }
  | {
      readonly ok: false;
      readonly reason: OutboundFailureReason;
      readonly description?: string;
    };

/** What one check has to judge. */
export interface CheckEvaluationInput {
  readonly declared: DeclaredServerDetails;
  /** The `.well-known/smart-configuration` fetch. */
  readonly discovery: CheckFetch;
  /** The `metadata` fetch. */
  readonly capability: CheckFetch;
}

/** What one check concluded. */
export interface CheckEvaluation {
  readonly reachable: boolean;
  /** Null exactly when `reachable`. */
  readonly failureMode: CheckFailureMode | null;
  /** What went wrong, or what was missing, in words a server owner can act on. */
  readonly detail: string | null;
  readonly discovery: DiscoveryHighlights | null;
  readonly capability: CapabilityHighlights | null;
  readonly driftFlags: readonly DriftFlag[];
}

/** The SMART configuration's well-known path, relative to a FHIR base URL. */
const SMART_CONFIGURATION_PATH = ".well-known/smart-configuration";

/** The CapabilityStatement's path, relative to a FHIR base URL. */
const CAPABILITY_STATEMENT_PATH = "metadata";

/** The extension carrying a server's SMART endpoints in its CapabilityStatement. */
const OAUTH_URIS_EXTENSION =
  "http://fhir-registry.smarthealthit.org/StructureDefinition/oauth-uris";

/**
 * Which cause to report when the two fetches failed differently.
 *
 * `guarded` first because it is the only one that says Muster sent nothing: the entry is
 * what needs fixing, and no detail about the other fetch changes that. `invalid` last
 * because "answered with something unusable" is the weakest claim of the four.
 */
const FAILURE_PRECEDENCE: readonly CheckFailureMode[] = [
  "guarded",
  "timeout",
  "refused",
  "invalid",
];

/** How each guard refusal is classified. */
const FAILURE_MODES: Readonly<Record<OutboundFailureReason, CheckFailureMode>> =
  {
    // The spec's own edge case: a slow server and a dead one are different problems.
    timeout: "timeout",
    refused: "refused",
    // A name with no address is nothing to reach, which is the same class of problem as a
    // connection that failed. Calling it `guarded` would tell the owner their address is
    // private or internal, which for a typo is a false accusation.
    unresolvable: "refused",
    // Every one of these is the guard deciding, so no request was made (FR-020).
    "not-a-url": "guarded",
    "insecure-scheme": "guarded",
    userinfo: "guarded",
    "blocked-address": "guarded",
    "redirect-not-followed": "guarded",
    "too-many-redirects": "guarded",
    // The connection worked; what came back was unusable.
    "too-large": "invalid",
  };

/** Joins a path onto a base URL without doubling the separator. */
function underBase(fhirBaseUrl: string, path: string): string {
  return `${fhirBaseUrl.trim().replace(/\/+$/, "")}/${path}`;
}

/**
 * Where a server's SMART configuration lives (FR-017).
 *
 * @param fhirBaseUrl - The declared FHIR base URL, with or without a trailing slash.
 * @returns The absolute address to fetch.
 * @example
 * ```ts
 * smartConfigurationUrl("https://fhir.example.com/r4");
 * // "https://fhir.example.com/r4/.well-known/smart-configuration"
 * ```
 */
export function smartConfigurationUrl(fhirBaseUrl: string): string {
  return underBase(fhirBaseUrl, SMART_CONFIGURATION_PATH);
}

/**
 * Where a server's CapabilityStatement lives (FR-017).
 *
 * @param fhirBaseUrl - The declared FHIR base URL, with or without a trailing slash.
 * @returns The absolute address to fetch.
 */
export function capabilityStatementUrl(fhirBaseUrl: string): string {
  return underBase(fhirBaseUrl, CAPABILITY_STATEMENT_PATH);
}

/**
 * How a guard refusal is reported on the entry.
 *
 * @param reason - Why the guard produced no response.
 * @returns The failure mode a check records.
 * @example
 * ```ts
 * checkFailureMode("blocked-address"); // "guarded"
 * ```
 */
export function checkFailureMode(
  reason: OutboundFailureReason,
): CheckFailureMode {
  return FAILURE_MODES[reason];
}

/** A JSON object, or `undefined` when the body is not one. */
function parseObject(body: string): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : undefined;
}

/**
 * A string field, or null.
 *
 * A value of the wrong type is treated as absent rather than coerced. A server answering
 * `token_endpoint: 42` has broken the contract, and `"42"` on the page would be a claim
 * Muster invented.
 */
function stringField(
  document: Record<string, unknown>,
  name: string,
): string | null {
  const value = document[name];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * The string members of a list field.
 *
 * A non-array is an empty list, not a one-element one. `scopes_supported: "launch openid"`
 * read as one scope would feed a scope warning naming every scope the client asked for.
 */
function stringList(
  document: Record<string, unknown>,
  name: string,
): readonly string[] {
  const value = document[name];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

/**
 * The highlights of a `.well-known/smart-configuration` document.
 *
 * @param body - The response body, as served.
 * @returns The highlights, or `undefined` when the body is not a JSON object - which for
 *   this address usually means a single-page application's catch-all answered instead.
 * @example
 * ```ts
 * const discovery = extractDiscoveryHighlights(response.body);
 * ```
 */
export function extractDiscoveryHighlights(
  body: string,
): DiscoveryHighlights | undefined {
  const document = parseObject(body);
  if (document === undefined) {
    return undefined;
  }
  return {
    issuer: stringField(document, "issuer"),
    authorizationEndpoint: stringField(document, "authorization_endpoint"),
    tokenEndpoint: stringField(document, "token_endpoint"),
    registrationEndpoint: stringField(document, "registration_endpoint"),
    introspectionEndpoint: stringField(document, "introspection_endpoint"),
    jwksUri: stringField(document, "jwks_uri"),
    scopesSupported: stringList(document, "scopes_supported"),
    capabilities: stringList(document, "capabilities"),
    grantTypesSupported: stringList(document, "grant_types_supported"),
    permissionTicketTypesSupported: stringList(
      document,
      "smart_permission_ticket_types_supported",
    ),
  };
}

/** The SMART endpoints a CapabilityStatement's `oauth-uris` extension advertises. */
function smartEndpoints(statement: CapabilityStatement) {
  const nested = (statement.rest ?? [])
    .flatMap((rest) => rest.security?.extension ?? [])
    .filter((extension) => extension.url === OAUTH_URIS_EXTENSION)
    .flatMap((extension) => extension.extension ?? []);
  const uri = (name: string): string | null =>
    nested.find((extension) => extension.url === name)?.valueUri ?? null;
  return {
    smartAuthorizationEndpoint: uri("authorize"),
    smartTokenEndpoint: uri("token"),
    smartRegisterEndpoint: uri("register"),
  };
}

/**
 * The highlights of a FHIR CapabilityStatement.
 *
 * The resource types are sorted, so two checks of an unchanged server produce identical
 * records and a reader comparing them sees no difference where there is none.
 *
 * @param body - The response body, as served.
 * @returns The highlights, or `undefined` when the body is not a CapabilityStatement - an
 *   `OperationOutcome` at `/metadata` has told us nothing about what the server supports,
 *   and empty highlights would say it supports nothing.
 * @example
 * ```ts
 * const capability = extractCapabilityHighlights(response.body);
 * ```
 */
export function extractCapabilityHighlights(
  body: string,
): CapabilityHighlights | undefined {
  const document = parseObject(body);
  if (
    document === undefined ||
    document["resourceType"] !== "CapabilityStatement"
  ) {
    return undefined;
  }
  const statement = document as unknown as CapabilityStatement;
  const resourceTypes = [
    ...new Set(
      (statement.rest ?? []).flatMap((rest) =>
        (rest.resource ?? []).map((resource) => resource.type),
      ),
    ),
  ].toSorted();

  return {
    fhirVersion: statement.fhirVersion ?? null,
    softwareName: statement.software?.name ?? null,
    softwareVersion: statement.software?.version ?? null,
    implementationUrl: statement.implementation?.url ?? null,
    resourceTypes,
    ...smartEndpoints(statement),
  };
}

/**
 * A URL reduced to the parts that decide whether two spellings are one address.
 *
 * `URL` lower-cases the scheme and host for us; the trailing slash and the fragment are
 * dropped here. An unparseable value is compared as the text it is, because a participant
 * who typed something malformed should still see it flagged against what the server says.
 */
function normaliseUrl(raw: string): string {
  const trimmed = raw.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return trimmed;
  }
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}${url.search}`;
}

/** One comparison the drift rules make, in the order the flags are reported. */
interface DriftComparison {
  readonly field: string;
  readonly declared: string | null | undefined;
  readonly advertised: string | null | undefined;
  /** Whether the two values are URLs, and so compared as addresses. */
  readonly asUrl: boolean;
}

/**
 * Every disagreement between what an owner declared and what their server advertises.
 *
 * @param declared - The server profile's own claims.
 * @param discovery - The smart-configuration highlights, or null when none was served.
 * @param capability - The CapabilityStatement highlights, or null when none was served.
 * @returns The flags, in a fixed order so that two checks of an unchanged pair produce
 *   identical records.
 * @example
 * ```ts
 * const driftFlags = detectDrift(system.serverProfile, discovery, capability);
 * ```
 */
export function detectDrift(
  declared: DeclaredServerDetails,
  discovery: DiscoveryHighlights | null,
  capability: CapabilityHighlights | null,
): readonly DriftFlag[] {
  const comparisons: readonly DriftComparison[] = [
    {
      field: "fhirBaseUrl",
      declared: declared.fhirBaseUrl,
      advertised: capability?.implementationUrl,
      asUrl: true,
    },
    {
      // An entry saying "no authorization needed" in front of a server with a token
      // endpoint sends every app owner down the wrong path.
      field: "authorizationMode",
      declared: declared.authorizationMode,
      advertised:
        discovery?.tokenEndpoint === null ||
        discovery?.tokenEndpoint === undefined
          ? null
          : "smart",
      asUrl: false,
    },
    {
      field: "authorizationEndpoint",
      declared: declared.authorizationEndpoint,
      advertised: discovery?.authorizationEndpoint,
      asUrl: true,
    },
    {
      field: "tokenEndpoint",
      declared: declared.tokenEndpoint,
      advertised: discovery?.tokenEndpoint,
      asUrl: true,
    },
    {
      // The one that matters most for User Story 5: a statement presented to an endpoint
      // the server does not advertise is a registration attempt against nothing.
      field: "registrationEndpoint",
      declared: declared.registrationEndpoint,
      advertised: discovery?.registrationEndpoint,
      asUrl: true,
    },
  ];

  return comparisons.flatMap((comparison) => {
    const { declared: left, advertised: right } = comparison;
    if (
      left === null ||
      left === undefined ||
      right === null ||
      right === undefined
    ) {
      return [];
    }
    const same = comparison.asUrl
      ? normaliseUrl(left) === normaliseUrl(right)
      : left === right;
    return same
      ? []
      : [{ field: comparison.field, declared: left, advertised: right }];
  });
}

/** A FHIR resource scope, parsed into the three things that decide coverage. */
interface FhirScope {
  readonly compartment: string;
  /** A resource type, or `*`. */
  readonly resource: string;
  /** Version 2 permission letters, with the version 1 spellings expanded. */
  readonly permissions: string;
}

/**
 * The version 2 permission letters a spelling denotes.
 *
 * SMART 2.0's own mapping of the version 1 forms: `.read` is `.rs`, `.write` is `.cud`,
 * and `.*` is everything. A server still advertising version 1 scopes supports the version
 * 2 spelling of the same thing, and a warning that said otherwise would be false.
 *
 * @see https://hl7.org/fhir/smart-app-launch/scopes-and-launch-context.html
 */
function expandPermissions(raw: string): string | undefined {
  if (raw === "*") {
    return "cruds";
  }
  if (raw === "read") {
    return "rs";
  }
  if (raw === "write") {
    return "cud";
  }
  return /^[cruds]+$/.test(raw) ? raw : undefined;
}

/** A scope of the form `compartment/Resource.permissions`, or `undefined`. */
function parseFhirScope(scope: string): FhirScope | undefined {
  const match = /^(patient|user|system)\/([A-Za-z]+|\*)\.([A-Za-z*]+)$/.exec(
    scope.trim(),
  );
  if (match === null) {
    return undefined;
  }
  const [, compartment = "", resource = "", raw = ""] = match;
  const permissions = expandPermissions(raw);
  return permissions === undefined
    ? undefined
    : { compartment, resource, permissions };
}

/**
 * Whether one advertised scope covers one requested scope.
 *
 * Exact equality first, which is the whole answer for `launch`, `openid` and the rest. A
 * wildcard resource is honoured because a server advertising `patient/*.rs` does support
 * reading any resource in the patient compartment, and naming one as unsupported would
 * cost somebody an afternoon at a connectathon.
 */
function scopeCovers(advertised: string, requested: string): boolean {
  if (advertised.trim() === requested.trim()) {
    return true;
  }
  const offered = parseFhirScope(advertised);
  const wanted = parseFhirScope(requested);
  if (offered === undefined || wanted === undefined) {
    return false;
  }
  if (offered.compartment !== wanted.compartment) {
    return false;
  }
  if (offered.resource !== "*" && offered.resource !== wanted.resource) {
    return false;
  }
  return [...wanted.permissions].every((letter) =>
    offered.permissions.includes(letter),
  );
}

/**
 * The requested scopes a server does not advertise (FR-019).
 *
 * @param requested - The scopes the pairing's registration snapshot asks for.
 * @param supported - `scopes_supported` from the server's latest check, or null when no
 *   check has run.
 * @returns The unsupported scopes, deduplicated, in the order they were requested. Empty
 *   when the server has advertised nothing: a warning naming every scope the client asked
 *   for would be a claim rather than an absence.
 * @example
 * ```ts
 * const unsupported = unsupportedScopes(
 *   pairing.registrationFields.scopes,
 *   check?.discovery?.scopesSupported ?? null,
 * );
 * ```
 */
export function unsupportedScopes(
  requested: readonly string[],
  supported: readonly string[] | null,
): readonly string[] {
  if (supported === null || supported.length === 0) {
    return [];
  }
  return [...new Set(requested)].filter(
    (scope) => !supported.some((offered) => scopeCovers(offered, scope)),
  );
}

/**
 * The permission ticket types a server's latest check found it advertising (FR-034).
 *
 * Null is an empty list rather than a refusal, because the two absences the playground has
 * to render - a server nobody has checked, and one whose check found no such field - are
 * both "nothing is known", and neither is a claim that the server refuses tickets.
 *
 * @param discovery - The smart-configuration highlights, or null when none was recorded.
 * @returns The advertised types, as the server listed them.
 * @example
 * ```ts
 * advertisedPermissionTicketTypes(status?.latest.discovery ?? null);
 * ```
 */
export function advertisedPermissionTicketTypes(
  discovery: DiscoveryHighlights | null,
): readonly string[] {
  return discovery?.permissionTicketTypesSupported ?? [];
}

/**
 * Whether a server advertises a particular permission ticket type (FR-034, scenario 3).
 *
 * @param discovery - The smart-configuration highlights, or null when none was recorded.
 * @param ticketType - The type a member wants to mint.
 * @returns `true` when the server has said it accepts that type.
 * @example
 * ```ts
 * supportsPermissionTicketType(system.check?.discovery ?? null, "patient-self-access");
 * ```
 */
export function supportsPermissionTicketType(
  discovery: DiscoveryHighlights | null,
  ticketType: string,
): boolean {
  return advertisedPermissionTicketTypes(discovery).includes(ticketType);
}

/** What one document fetch amounted to. */
interface DocumentOutcome<T> {
  readonly label: string;
  readonly highlights: T | undefined;
  /** Why the document is unusable, or `undefined` when it is usable. */
  readonly problem:
    { readonly mode: CheckFailureMode; readonly text: string } | undefined;
}

/**
 * Judges one fetch: what it produced, and if nothing usable, why.
 *
 * A non-2xx status and an unparseable 2xx body are both `invalid`: the connection worked
 * and the content did not, which is a different thing from the server being unreachable.
 */
function judge<T>(
  fetched: CheckFetch,
  label: string,
  extract: (body: string) => T | undefined,
): DocumentOutcome<T> {
  if (!fetched.ok) {
    return {
      label,
      highlights: undefined,
      problem: {
        mode: checkFailureMode(fetched.reason),
        text: fetched.description ?? fetched.reason,
      },
    };
  }
  if (fetched.status < 200 || fetched.status >= 300) {
    return {
      label,
      highlights: undefined,
      problem: {
        mode: "invalid",
        text: `answered HTTP ${String(fetched.status)}`,
      },
    };
  }
  const highlights = extract(fetched.body);
  return {
    label,
    highlights,
    problem:
      highlights === undefined
        ? {
            mode: "invalid",
            text: "answered with something that is not a usable document",
          }
        : undefined,
  };
}

/**
 * The sentence recorded beside a check.
 *
 * Two identical problems - which is what a guarded address produces, because the guard
 * refuses on the host and both addresses share it - are reported once and unlabelled.
 */
function describeProblems(
  outcomes: readonly DocumentOutcome<unknown>[],
): string | null {
  const problems = outcomes.filter((outcome) => outcome.problem !== undefined);
  if (problems.length === 0) {
    return null;
  }
  const texts = new Set(problems.map((outcome) => outcome.problem?.text));
  if (texts.size === 1) {
    return [...texts][0] ?? null;
  }
  return problems
    .map((outcome) => `${outcome.label}: ${outcome.problem?.text ?? ""}`)
    .join("; ");
}

/**
 * Everything one check concluded, from the two documents it fetched.
 *
 * @param input - What the owner declared, and how each of the two fetches went.
 * @returns The check, ready to be recorded and rendered.
 * @example
 * ```ts
 * const evaluation = evaluateCheck({
 *   declared: system.serverProfile,
 *   discovery: toCheckFetch(await outboundFetch(smartConfigurationUrl(baseUrl), options)),
 *   capability: toCheckFetch(await outboundFetch(capabilityStatementUrl(baseUrl), options)),
 * });
 * ```
 */
export function evaluateCheck(input: CheckEvaluationInput): CheckEvaluation {
  const discovery = judge(
    input.discovery,
    "SMART configuration",
    extractDiscoveryHighlights,
  );
  const capability = judge(
    input.capability,
    "CapabilityStatement",
    extractCapabilityHighlights,
  );
  const outcomes = [discovery, capability];

  const reachable =
    discovery.highlights !== undefined || capability.highlights !== undefined;
  const failureMode = reachable
    ? null
    : (FAILURE_PRECEDENCE.find((mode) =>
        outcomes.some((outcome) => outcome.problem?.mode === mode),
      ) ?? "invalid");

  return {
    reachable,
    failureMode,
    detail: describeProblems(outcomes),
    discovery: discovery.highlights ?? null,
    capability: capability.highlights ?? null,
    // Nothing was advertised, so nothing disagrees: a drift flag against a server Muster
    // could not reach would blame the owner for the check having failed.
    driftFlags: reachable
      ? detectDrift(
          input.declared,
          discovery.highlights ?? null,
          capability.highlights ?? null,
        )
      : [],
  };
}
