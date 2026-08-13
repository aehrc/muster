/**
 * What the conformance harness asks of a server, and what its answers amount to.
 *
 * This module is the whole of the harness's judgement, and it is pure on purpose. A run is a
 * public claim about somebody else's product - a badge on their event entry, or its absence -
 * so what counts as conformant has to be auditable and exhaustively testable without a
 * network, a database or a clock of its own (constitution principle II). The server module
 * beside it presents the statements and does the I/O; nothing here knows how.
 *
 * Five decisions are worth stating.
 *
 * **The checks are the profile's MUSTs, and only those.**
 * `contracts/registration-profile.md` lists the rules a server must apply, and each check
 * corresponds to one of them: a valid statement is accepted, a tampered signature is refused,
 * an expired statement is refused, a replayed identifier is refused, the registered metadata
 * is the vouched metadata, and metadata asserted outside the statement is refused or ignored.
 * The sixth is a MUST in the contract's "Registration request" section rather than a line in
 * its summary table, and it is checked because it is the gap that vouching exists to close.
 *
 * **A SHOULD produces an advisory, never a failure.** The contract asks servers to
 * distinguish `invalid_software_statement` from `invalid_client_metadata`, and says the
 * harness checks that they do - so it does, and reports the discrepancy without removing the
 * badge. FR-030 ties the badge to the checks, and a badge withheld for a SHOULD would be
 * Muster inventing a requirement that the document a vendor implemented does not contain.
 *
 * **Refusal is judged by behaviour, not by status code alone.** A server has refused when it
 * did not create a client. A 400 that nonetheless returned a `client_id`, and a 200 that
 * returned nothing, are both failures: the first registered something it said it would not,
 * and the second neither refused nor registered, which leaves a vendor unable to tell what
 * their own server did.
 *
 * **Fidelity is compared field by field, and order is not a difference.** A server is
 * entitled to store a set in whatever order it likes, so `redirect_uris`, `grant_types` and
 * `scope` are compared as sets. A flag whose two values look identical to a reader teaches
 * them to ignore the flags that matter.
 *
 * **Credentials are redacted from evidence rather than dropped with it.** FR-030 requires the
 * request and response evidence, and principle IV forbids storing a client secret. Both hold
 * at once because {@link scrubCredentials} replaces the value of every credential-bearing
 * member before the evidence leaves this package's caller - so the body a reader sees is the
 * body the server sent, with the credential replaced by a marker rather than the whole
 * response replaced by nothing.
 *
 * Author: John Grimes
 */

import { writeRefusal } from "../accounts/rules.js";
import {
  buildSoftwareStatementClaims,
  declaresRegistrationEndpoint,
  vouchingWindowClosed,
} from "../statements/build.js";

import type { AccountStanding, WriteRefusal } from "../accounts/rules.js";
import type { EventStatus } from "../events/rules.js";
import type { RegistrationFields } from "../pairing/registrationFields.js";
import type { RegistrationMode } from "../pairing/stateMachine.js";
import type { SoftwareStatementClaims } from "../statements/build.js";

/** Every check the harness runs, in the order it runs them (FR-029). */
export const HARNESS_CHECK_NAMES = [
  "valid-statement",
  "tampered-signature",
  "expired-statement",
  "replayed-statement",
  "metadata-fidelity",
  "statement-only",
] as const;

/** One of the checks. */
export type HarnessCheckName = (typeof HARNESS_CHECK_NAMES)[number];

/** How one check went. */
export type HarnessCheckOutcome = "passed" | "failed";

/** How the whole run went. Only `passed` earns the badge (FR-030). */
export type HarnessVerdict = "passed" | "failed";

/** What the harness sent, as evidence. The statement is described, never reproduced. */
export interface HarnessRequestEvidence {
  readonly method: string;
  readonly url: string;
  readonly body: string;
}

/** What came back, as evidence, with credentials already redacted. */
export interface HarnessResponseEvidence {
  readonly status: number;
  /** The RFC 7591 error code, when the response carried one. */
  readonly error: string | null;
  readonly errorDescription: string | null;
  readonly body: string;
}

/** One request and its answer. */
export interface HarnessExchange {
  readonly request: HarnessRequestEvidence;
  /** Null when nothing came back. */
  readonly response: HarnessResponseEvidence | null;
  /** Why nothing came back. Null when something did. */
  readonly failure: string | null;
}

/** One check's outcome, with the exchange that decided it. */
export interface HarnessCheck {
  readonly name: HarnessCheckName;
  readonly outcome: HarnessCheckOutcome;
  /** What the check concluded, in words a vendor can act on. */
  readonly detail: string;
  /** Profile SHOULDs that were not met. These do not affect the verdict. */
  readonly advisories: readonly string[];
  readonly request: HarnessRequestEvidence;
  readonly response: HarnessResponseEvidence | null;
  readonly failure: string | null;
}

/** The client metadata a registration response echoed. Null where it echoed none. */
export interface RegisteredClientMetadata {
  readonly clientName: string | null;
  readonly redirectUris: readonly string[] | null;
  readonly grantTypes: readonly string[] | null;
  readonly tokenEndpointAuthMethod: string | null;
  readonly scope: string | null;
  readonly softwareId: string | null;
}

/** What a registration response carried. */
export interface RegistrationResponse {
  readonly clientId: string | null;
  /** Relayed nowhere and stored nowhere. Read only so that it can be redacted. */
  readonly clientSecret: string | null;
  /** RFC 7592's client configuration endpoint, which is how a client is deleted. */
  readonly registrationClientUri: string | null;
  readonly registrationAccessToken: string | null;
  readonly metadata: RegisteredClientMetadata;
}

/** One field where the registered metadata differs from the vetted metadata. */
export interface MetadataDivergence {
  readonly field: string;
  readonly vetted: string;
  readonly registered: string;
}

/** Which statement a harness exchange presents. */
export type HarnessStatementKind = "valid" | "expired";

/** What the harness's statement builder needs. */
export interface HarnessStatementInput {
  readonly kind: HarnessStatementKind;
  /** The trust anchor's issuer identifier. */
  readonly issuer: string;
  /** The statement identifier. Generated by the caller, which owns the randomness. */
  readonly jti: string;
  readonly eventSlug: string;
  readonly eventEndsOn: string;
  readonly graceDays: number;
  /** The vetted metadata of the throwaway client. */
  readonly fields: RegistrationFields;
  readonly now: Date;
}

/** Why Muster will not run the harness. */
export type HarnessRunRefusal =
  | WriteRefusal
  | "not_signed_in"
  | "not_the_server_owner"
  | "event_not_open"
  | "not_trusted_dcr"
  | "no_registration_endpoint"
  | "vouching_window_closed";

/** What the refusal rules read off a request to run. */
export interface HarnessRunRequest {
  /** Null for a caller with no session, which is how a public projection asks. */
  readonly standing: AccountStanding | null;
  /** Whether one of the caller's organisations owns the server being tested. */
  readonly ownsServer: boolean;
  readonly eventStatus: EventStatus;
  readonly eventEndsOn: string;
  readonly graceDays: number;
  readonly registrationMode: RegistrationMode;
  readonly registrationEndpoint: string | null;
  readonly now: Date;
}

/** What deciding one check needs. */
export interface HarnessJudgement {
  readonly name: HarnessCheckName;
  readonly exchange: HarnessExchange;
  /** The claims of the statement this exchange presented: the metadata Muster vouched for. */
  readonly vetted: SoftwareStatementClaims;
}

/**
 * The software identifier Muster vouches for when it registers a throwaway client.
 *
 * A fixed string rather than a system identifier, because the harness's client belongs to no
 * participant: it exists for the length of one run. A vendor seeing it in their logs can tell
 * at a glance what made it.
 */
export const HARNESS_SOFTWARE_ID = "muster-conformance-harness";

/** What a redacted credential is replaced with. */
export const REDACTED = "[redacted]";

/** The response members that carry a credential (principle IV). */
export const CREDENTIAL_MEMBER_NAMES: readonly string[] = [
  "client_secret",
  "registration_access_token",
];

/** How long before now an expired statement was issued. */
const EXPIRED_STATEMENT_AGE_SECONDS = 7200;

/**
 * How long ago an expired statement's vouching stopped.
 *
 * An hour rather than a minute, because the server judging it reads its own clock. A statement
 * that lapsed seconds ago is still current to a server whose clock is behind Muster's, and
 * failing a vendor over clock skew would be a false accusation - while an hour is far beyond
 * the skew a statement's own window has to tolerate.
 */
const EXPIRED_STATEMENT_LAPSE_SECONDS = 3600;

/** The error code the profile asks for when a statement itself is refused. */
const STATEMENT_ERROR = "invalid_software_statement";

/** What each refusal check presented, for the sentence that reports it. */
const REFUSAL_SUBJECTS: Readonly<Record<string, string>> = {
  "tampered-signature": "a statement whose signature does not verify",
  "expired-statement": "a statement whose vouching had expired",
  "replayed-statement": "a statement identifier it had already used",
};

/**
 * The vetted metadata of the harness's throwaway client (FR-029).
 *
 * Muster's own addresses, so a vendor can see who asked and the client is obviously
 * disposable. Confidential deliberately: it is the case that makes a server return a
 * credential, and a harness that never received one would never exercise the redaction that
 * principle IV requires of it.
 *
 * @param publicUrl - The deployment's public URL, from `MUSTER_PUBLIC_URL`.
 * @returns The field set to vouch for.
 * @example
 * ```ts
 * const fields = harnessRegistrationFields(context.config.publicUrl);
 * ```
 */
export function harnessRegistrationFields(
  publicUrl: string,
): RegistrationFields {
  const base = publicUrl.replace(/\/+$/, "");
  return {
    clientName: "Muster conformance harness",
    launchUrl: `${base}/harness/launch`,
    redirectUris: [`${base}/harness/callback`],
    scopes: ["launch", "openid", "fhirUser"],
    confidentiality: "confidential",
    launchContext: "patient",
    needsIntrospection: false,
  };
}

/**
 * The client metadata the statement-only exchange asserts outside the statement.
 *
 * Every member contradicts the vouched value, which is what makes honouring it detectable: a
 * server that ignores this - or refuses the request outright - registers the vetted metadata,
 * and one that honours it registers these values instead.
 *
 * @returns The members to add beside `software_statement`.
 */
export function harnessOutsideMetadata(): Readonly<Record<string, unknown>> {
  return {
    client_name: "Outside metadata that must not be honoured",
    redirect_uris: ["https://outside.invalid/callback"],
  };
}

/**
 * The claims of one of the harness's statements.
 *
 * The valid kind is exactly what a real registration would carry, capped at the event's
 * vouching expiry (FR-023) - so the case a server sees is the case it will see on event day.
 * The expired kind is the same claim set with its window moved into the past, and it is
 * issued before it expired: a statement whose `iat` was after its `exp` would be refusable
 * for a second reason, and the check would no longer be about expiry.
 *
 * @param input - The kind, the anchor, the event, the vetted metadata and the time.
 * @returns The claims, ready to sign.
 * @throws {TypeError} When the event's end date is unparseable.
 * @example
 * ```ts
 * const claims = harnessStatementClaims({
 *   kind: "expired",
 *   issuer: config.publicUrl,
 *   jti: crypto.randomUUID(),
 *   eventSlug: event.slug,
 *   eventEndsOn: event.endsOn,
 *   graceDays: event.graceDays,
 *   fields: harnessRegistrationFields(config.publicUrl),
 *   now: context.clock(),
 * });
 * ```
 */
export function harnessStatementClaims(
  input: HarnessStatementInput,
): SoftwareStatementClaims {
  const claims = buildSoftwareStatementClaims({
    issuer: input.issuer,
    softwareId: HARNESS_SOFTWARE_ID,
    jti: input.jti,
    eventSlug: input.eventSlug,
    eventEndsOn: input.eventEndsOn,
    graceDays: input.graceDays,
    fields: input.fields,
    now: input.now,
  });
  if (input.kind === "valid") {
    return claims;
  }
  const seconds = Math.floor(input.now.getTime() / 1000);
  return {
    ...claims,
    iat: seconds - EXPIRED_STATEMENT_AGE_SECONDS,
    exp: seconds - EXPIRED_STATEMENT_LAPSE_SECONDS,
  };
}

/**
 * Breaks a compact JWS's signature, leaving everything else alone.
 *
 * The first character of the signature is changed rather than the last: the final base64url
 * character of a 64-byte ECDSA signature carries bits that are discarded on decoding, so
 * altering it can leave the decoded signature identical - a tamper check that sometimes
 * tampered with nothing. The header and payload are untouched, so the only reason a
 * conformant server has to refuse the result is the signature, which is what the check is
 * about.
 *
 * @param jws - A compact JWS.
 * @returns The same token with a signature that will not verify.
 * @throws {TypeError} When the argument is not a three-part compact JWS with a signature.
 * @example
 * ```ts
 * const tampered = tamperCompactJws(await signClaims(claims, signing));
 * ```
 */
export function tamperCompactJws(jws: string): string {
  const parts = jws.split(".");
  const [header, payload, signature] = parts;
  if (
    parts.length !== 3 ||
    header === undefined ||
    payload === undefined ||
    signature === undefined ||
    signature.length === 0
  ) {
    throw new TypeError("a compact JWS has three parts and a signature");
  }
  const first = signature.slice(0, 1);
  return `${header}.${payload}.${first === "A" ? "B" : "A"}${signature.slice(1)}`;
}

/** Redacts the credential-bearing members of a parsed body, however deeply nested. */
function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry));
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([name, member]) => [
      name,
      CREDENTIAL_MEMBER_NAMES.includes(name) ? REDACTED : redactValue(member),
    ]),
  );
}

/** The members to redact, as an alternation for the textual fallback. */
const CREDENTIAL_MEMBER_PATTERN = CREDENTIAL_MEMBER_NAMES.join("|");

/**
 * Replaces every credential in a response body with a marker.
 *
 * The JSON path is the one that matters, because RFC 7591 requires JSON. The textual fallback
 * exists because a server that answers something else has failed the profile and its answer is
 * still evidence - which must not be evidence carrying a live credential.
 *
 * What survives is everything else: the identifier, the metadata, the error, the expiry. The
 * evidence FR-030 requires and the prohibition principle IV states hold at once because this
 * runs before anything is stored or answered with.
 *
 * @param body - The response body as received.
 * @returns The body with credential values replaced by {@link REDACTED}.
 * @example
 * ```ts
 * const evidence = { status, error, errorDescription, body: scrubCredentials(raw) };
 * ```
 */
export function scrubCredentials(body: string): string {
  try {
    return JSON.stringify(redactValue(JSON.parse(body)));
  } catch {
    return body
      .replaceAll(
        new RegExp(
          String.raw`("(?:${CREDENTIAL_MEMBER_PATTERN})"\s*:\s*)"(?:[^"\\]|\\.)*"`,
          "g",
        ),
        `$1"${REDACTED}"`,
      )
      .replaceAll(
        new RegExp(String.raw`\b(${CREDENTIAL_MEMBER_PATTERN})=[^&\s]*`, "g"),
        `$1=${REDACTED}`,
      );
  }
}

/** A string member, or null when it is missing or the wrong type. */
function stringMember(
  document: Readonly<Record<string, unknown>>,
  name: string,
): string | null {
  const value = document[name];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** A string-array member, or null. */
function arrayMember(
  document: Readonly<Record<string, unknown>>,
  name: string,
): readonly string[] | null {
  const value = document[name];
  return Array.isArray(value) &&
    value.every((entry) => typeof entry === "string")
    ? value
    : null;
}

/**
 * Reads a registration response.
 *
 * A member of the wrong type is treated as absent rather than as a value, because a check that
 * compared `7` against a vouched name would report a divergence about the wrong thing.
 *
 * @param body - The response body.
 * @returns What it carried; every field null when the body is not a JSON object.
 * @example
 * ```ts
 * const registered = readRegistrationResponse(response.body);
 * ```
 */
export function readRegistrationResponse(body: string): RegistrationResponse {
  let document: Readonly<Record<string, unknown>> = {};
  try {
    const parsed: unknown = JSON.parse(body);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      document = parsed as Record<string, unknown>;
    }
  } catch {
    // A body that is not JSON has registered nothing this function can report. The check that
    // asked will fail on the absence, and the body itself is kept as evidence.
  }
  return {
    clientId: stringMember(document, "client_id"),
    clientSecret: stringMember(document, "client_secret"),
    registrationClientUri: stringMember(document, "registration_client_uri"),
    registrationAccessToken: stringMember(
      document,
      "registration_access_token",
    ),
    metadata: {
      clientName: stringMember(document, "client_name"),
      redirectUris: arrayMember(document, "redirect_uris"),
      grantTypes: arrayMember(document, "grant_types"),
      tokenEndpointAuthMethod: stringMember(
        document,
        "token_endpoint_auth_method",
      ),
      scope: stringMember(document, "scope"),
      softwareId: stringMember(document, "software_id"),
    },
  };
}

/** Whether two collections hold the same members, in whatever order. */
function sameMembers(
  left: readonly string[],
  right: readonly string[],
): boolean {
  const wanted = new Set(left);
  const found = new Set(right);
  return (
    wanted.size === found.size && [...wanted].every((entry) => found.has(entry))
  );
}

/** One field's comparison: how to read it, and how to say it. */
interface FieldComparison {
  readonly field: string;
  readonly vetted: readonly string[];
  readonly registered: readonly string[] | null;
  /** Whether order matters. It does not for a set of URIs, grants or scopes. */
  readonly ordered: boolean;
}

/** Every field the vouched metadata and a registered client can be compared on. */
function comparisons(
  vetted: SoftwareStatementClaims,
  registered: RegisteredClientMetadata,
): readonly FieldComparison[] {
  return [
    {
      field: "client_name",
      vetted: [vetted.client_name],
      registered:
        registered.clientName === null ? null : [registered.clientName],
      ordered: true,
    },
    {
      field: "redirect_uris",
      vetted: vetted.redirect_uris,
      registered: registered.redirectUris,
      ordered: false,
    },
    {
      field: "grant_types",
      vetted: vetted.grant_types,
      registered: registered.grantTypes,
      ordered: false,
    },
    {
      field: "token_endpoint_auth_method",
      vetted: [vetted.token_endpoint_auth_method],
      registered:
        registered.tokenEndpointAuthMethod === null
          ? null
          : [registered.tokenEndpointAuthMethod],
      ordered: true,
    },
    {
      field: "scope",
      vetted: vetted.scope.split(" ").filter((scope) => scope.length > 0),
      registered:
        registered.scope === null
          ? null
          : registered.scope.split(" ").filter((scope) => scope.length > 0),
      ordered: false,
    },
    {
      field: "software_id",
      vetted: [vetted.software_id],
      registered:
        registered.softwareId === null ? null : [registered.softwareId],
      ordered: true,
    },
  ];
}

/**
 * Where the registered metadata differs from the metadata Muster vouched for (FR-029).
 *
 * A field the response did not echo is not a divergence: absence is not disagreement, and
 * whether a response that echoes nothing at all is conformant is the fidelity check's
 * judgement rather than this function's.
 *
 * @param vetted - The claims of the statement that was presented.
 * @param registered - What the registration response echoed.
 * @returns One entry per disagreeing field, naming both values.
 * @example
 * ```ts
 * const divergences = metadataDivergences(claims, registered.metadata);
 * ```
 */
export function metadataDivergences(
  vetted: SoftwareStatementClaims,
  registered: RegisteredClientMetadata,
): readonly MetadataDivergence[] {
  return comparisons(vetted, registered).flatMap((comparison) => {
    const found = comparison.registered;
    if (found === null) {
      return [];
    }
    const agrees = comparison.ordered
      ? comparison.vetted.join(" ") === found.join(" ")
      : sameMembers(comparison.vetted, found);
    return agrees
      ? []
      : [
          {
            field: comparison.field,
            vetted: comparison.vetted.join(" "),
            registered: found.join(" "),
          },
        ];
  });
}

/** Whether the response echoed anything that fidelity could be judged on. */
function metadataComparable(registered: RegisteredClientMetadata): boolean {
  return Object.values(registered).some((value) => value !== null);
}

/** The far end's answer, as a sentence's opening. */
function describeAnswer(response: HarnessResponseEvidence): string {
  const code = response.error === null ? "" : ` ${response.error}`;
  return `${String(response.status)}${code}`;
}

/** What the server said about its refusal, when it said anything. */
function describeReason(response: HarnessResponseEvidence): string {
  return response.errorDescription === null
    ? ""
    : ` - ${response.errorDescription}`;
}

/** One divergence, as a reader sees it. */
function describeDivergences(
  divergences: readonly MetadataDivergence[],
): string {
  return divergences
    .map(
      (divergence) =>
        `${divergence.field} (vouched "${divergence.vetted}", registered "${divergence.registered}")`,
    )
    .join("; ");
}

/** What a check amounts to, before the evidence is attached to it. */
interface Conclusion {
  readonly outcome: HarnessCheckOutcome;
  readonly detail: string;
  readonly advisories?: readonly string[];
}

/** Whether the exchange created a client, which is what "refused" is the absence of. */
function registeredClientId(response: HarnessResponseEvidence): string | null {
  return readRegistrationResponse(response.body).clientId;
}

/** Judges the acceptance of a statement Muster vouched for. */
function judgeValid(response: HarnessResponseEvidence): Conclusion {
  const clientId = registeredClientId(response);
  const succeeded = response.status === 201 || response.status === 200;
  const advisories =
    succeeded && response.status === 200
      ? [
          "RFC 7591 §3.2.1 asks for 201 Created on a successful registration; this server answered 200.",
        ]
      : [];

  if (succeeded && clientId !== null) {
    return {
      outcome: "passed",
      detail: `${describeAnswer(response)}: registered client ${clientId}`,
      advisories,
    };
  }
  if (succeeded) {
    return {
      outcome: "failed",
      detail: `${describeAnswer(response)}: the answer carried no client_id, so nothing was registered`,
    };
  }
  return {
    outcome: "failed",
    detail: `${describeAnswer(response)}: the server refused a statement Muster vouched for${describeReason(response)}`,
  };
}

/** Judges a case the profile requires a server to refuse. */
function judgeRefusal(
  name: HarnessCheckName,
  response: HarnessResponseEvidence,
): Conclusion {
  const clientId = registeredClientId(response);
  const subject =
    REFUSAL_SUBJECTS[name] ?? "a statement it should have refused";

  if (clientId !== null) {
    return {
      outcome: "failed",
      detail: `${describeAnswer(response)}: the server registered a client (${clientId}) from ${subject}`,
    };
  }
  if (response.status < 400) {
    return {
      outcome: "failed",
      detail: `${describeAnswer(response)}: the server neither refused ${subject} nor registered anything, so what it did is unclear`,
    };
  }
  return {
    outcome: "passed",
    detail: `${describeAnswer(response)}: refused ${subject}, as the profile requires${describeReason(response)}`,
    advisories:
      response.error === STATEMENT_ERROR
        ? []
        : [
            `The profile asks for error ${STATEMENT_ERROR} when a statement itself is refused; this server answered ${response.error ?? "no error code"}.`,
          ],
  };
}

/** Judges whether the registered client is the client Muster vouched for. */
function judgeFidelity(
  response: HarnessResponseEvidence,
  vetted: SoftwareStatementClaims,
): Conclusion {
  const registered = readRegistrationResponse(response.body);
  if (registered.clientId === null) {
    return {
      outcome: "failed",
      detail: `${describeAnswer(response)}: nothing was registered, so there is no metadata to compare${describeReason(response)}`,
    };
  }
  if (!metadataComparable(registered.metadata)) {
    return {
      outcome: "failed",
      detail: `${describeAnswer(response)}: the answer carried no client metadata, so fidelity could not be established - RFC 7591 §3.2.1 requires the registered metadata to be returned`,
    };
  }
  const divergences = metadataDivergences(vetted, registered.metadata);
  return divergences.length === 0
    ? {
        outcome: "passed",
        detail: `${describeAnswer(response)}: the registered client carries the vetted metadata`,
      }
    : {
        outcome: "failed",
        detail: `${describeAnswer(response)}: the registered client differs from the vetted metadata - ${describeDivergences(divergences)}`,
      };
}

/** Judges what the server did with metadata asserted outside the statement. */
function judgeStatementOnly(
  response: HarnessResponseEvidence,
  vetted: SoftwareStatementClaims,
): Conclusion {
  const registered = readRegistrationResponse(response.body);
  if (registered.clientId === null) {
    return response.status >= 400
      ? {
          outcome: "passed",
          detail: `${describeAnswer(response)}: refused a request asserting client metadata outside the statement${describeReason(response)}`,
        }
      : {
          outcome: "failed",
          detail: `${describeAnswer(response)}: neither refused the request nor registered a client, so what it did with the metadata outside the statement is unclear`,
        };
  }
  const divergences = metadataDivergences(vetted, registered.metadata);
  return divergences.length === 0
    ? {
        outcome: "passed",
        detail: `${describeAnswer(response)}: ignored the metadata asserted outside the statement, and registered the vetted metadata`,
      }
    : {
        outcome: "failed",
        detail: `${describeAnswer(response)}: honoured metadata asserted outside the statement - ${describeDivergences(divergences)}`,
      };
}

/** Judges one check by name. */
function conclude(input: HarnessJudgement, response: HarnessResponseEvidence) {
  switch (input.name) {
    case "valid-statement": {
      return judgeValid(response);
    }
    case "metadata-fidelity": {
      return judgeFidelity(response, input.vetted);
    }
    case "statement-only": {
      return judgeStatementOnly(response, input.vetted);
    }
    default: {
      return judgeRefusal(input.name, response);
    }
  }
}

/**
 * What one exchange proves, or fails to (FR-029, FR-030).
 *
 * @param input - The check, the exchange that was made for it, and the claims of the
 *   statement it presented.
 * @returns The check with its outcome, its sentence and its evidence.
 * @example
 * ```ts
 * const check = judgeHarnessCheck({ name: "tampered-signature", exchange, vetted: claims });
 * ```
 */
export function judgeHarnessCheck(input: HarnessJudgement): HarnessCheck {
  const evidence = {
    name: input.name,
    request: input.exchange.request,
    response: input.exchange.response,
    failure: input.exchange.failure,
  };
  if (input.exchange.response === null) {
    // A server that cannot be reached has proved nothing, whichever case was presented.
    return {
      ...evidence,
      outcome: "failed",
      detail: `The registration endpoint did not answer: ${input.exchange.failure ?? "no response"}`,
      advisories: [],
    };
  }
  const concluded = conclude(input, input.exchange.response);
  return {
    ...evidence,
    outcome: concluded.outcome,
    detail: concluded.detail,
    advisories: concluded.advisories ?? [],
  };
}

/**
 * The verdict of a whole run (FR-030).
 *
 * Only a fully passing run earns the badge, and a run with no checks in it has proved nothing
 * - so it fails rather than passing vacuously, because a badge is a claim that something was
 * proved.
 *
 * @param checks - The run's checks.
 * @returns The verdict.
 * @example
 * ```ts
 * const verdict = harnessVerdict(checks);
 * ```
 */
export function harnessVerdict(
  checks: readonly { readonly outcome: HarnessCheckOutcome }[],
): HarnessVerdict {
  return checks.length > 0 &&
    checks.every((check) => check.outcome === "passed")
    ? "passed"
    : "failed";
}

/**
 * Why Muster will not run the harness against this entry, or `undefined` when it will.
 *
 * Deny by default, in the order the caller can act on. Two of the reasons are not about
 * authority at all: an event whose grace has run out could only be vouched for with a
 * statement that was already expired, and an entry declaring no registration endpoint has
 * nothing to present one to - and in both cases the valid-statement check would fail for
 * Muster's reason rather than the vendor's, which would be a badge withheld unfairly.
 *
 * @param request - The caller's standing and ownership, the event, and the entry.
 * @returns The refusal code, or `undefined` when the run may proceed.
 * @example
 * ```ts
 * const refusal = harnessRunRefusal({
 *   standing: account,
 *   ownsServer: true,
 *   eventStatus: target.event.status,
 *   eventEndsOn: target.event.endsOn,
 *   graceDays: target.event.graceDays,
 *   registrationMode: profile.registrationMode,
 *   registrationEndpoint: profile.registrationEndpoint,
 *   now: context.clock(),
 * });
 * ```
 */
export function harnessRunRefusal(
  request: HarnessRunRequest,
): HarnessRunRefusal | undefined {
  if (request.standing === null) {
    return "not_signed_in";
  }
  const standing = writeRefusal(request.standing);
  if (standing !== undefined) {
    return standing;
  }
  if (!request.ownsServer) {
    // The run registers throwaway clients on the entry's server. That is its owner's to ask
    // for, and nobody else's.
    return "not_the_server_owner";
  }
  if (request.eventStatus !== "open") {
    return "event_not_open";
  }
  if (request.registrationMode !== "trustedDcr") {
    return "not_trusted_dcr";
  }
  if (!declaresRegistrationEndpoint(request.registrationEndpoint)) {
    return "no_registration_endpoint";
  }
  if (
    vouchingWindowClosed(request.eventEndsOn, request.graceDays, request.now)
  ) {
    return "vouching_window_closed";
  }
  return undefined;
}
