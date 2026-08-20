/*
 * Copyright © 2026 Commonwealth Scientific and Industrial Research Organisation
 * (CSIRO) ABN 41 687 119 230. Licensed under the Apache License, Version 2.0.
 */

import {
  authoriseEventOpen,
  authoriseWrite,
  refuse,
} from "../accounts/rules.ts";
import { authoriseDirectoryRegistration } from "../statements/build.ts";

import type { AccountFacts, AuthorisationDecision } from "../accounts/rules.ts";
import type { StatementClaims } from "../statements/build.ts";
import type {
  EventStatus,
  HarnessCheck,
  HarnessCheckName,
  HarnessCheckOutcome,
  HarnessRequestEvidence,
  HarnessResponseEvidence,
  HarnessVerdict,
  RegistrationFields,
  RegistrationMode,
} from "@muster/contracts";

/**
 * The conformance harness: what each check judges, and what a run's verdict is.
 *
 * Pure. The five requests a run makes are made in `apps/server/src/pairing`,
 * through the SSRF guard; what arrives here is an exchange - the request as it was
 * sent and the response as it came back - and what leaves is a pass, a fail or an
 * advisory with the wording a vendor will read. That split is what lets the whole
 * of User Story 6's judgement be tested without a registration endpoint: a server
 * that skips signature validation, one that returns no metadata and one that
 * answers with an HTML error page are three inputs rather than three stubs.
 *
 * The MUST/SHOULD line in `contracts/registration-profile.md` is drawn here and
 * nowhere else. A refusal that should have been an acceptance, or an acceptance
 * that should have been a refusal, is a failure and removes the badge. A refusal
 * that named the wrong RFC 7591 error is an advisory, because the profile says
 * SHOULD about the vocabulary and the server did the thing that matters.
 *
 * Deny by default applies to the verdict. A run that is missing one of the
 * profile's checks has not shown the profile is implemented, so an incomplete run
 * fails rather than passing on the checks it managed.
 *
 * Evidence is redacted before it is recorded, because the report is public
 * (SC-005). A software statement is stripped of its signature - the claims stay
 * fully readable, and what is left registers nothing at any server - and a client
 * secret or a registration access token is replaced rather than dropped, so the
 * reader can see that the server issued one without it being written down (the
 * constitution).
 *
 * @author John Grimes
 */

/**
 * Longest body kept as evidence, in characters.
 *
 * A participant's server is not trusted to be terse. Past the cap the body is
 * recorded as truncated text rather than parsed, so one run cannot write an
 * unbounded document into the record.
 */
export const maximumEvidenceLength = 2000;

/** What the harness calls the throwaway client it asks to have registered. */
export const harnessClientName = "Muster conformance harness probe";

/** What a redacted credential is shown as. */
const redactedMarker = "[redacted]";

/** What a statement's removed signature is shown as. */
const signatureMarker = "[removed]";

/** What a statement that is not a JWS at all is shown as. */
const unreadableStatement = "[not a JWS]";

/** The response members that are credentials rather than metadata. */
const credentialMembers = new Set([
  "client_secret",
  "registration_access_token",
]);

/** The claims that are client metadata, and so are compared for fidelity. */
const metadataClaims = [
  "client_name",
  "redirect_uris",
  "grant_types",
  "token_endpoint_auth_method",
  "scope",
  "smart_launch_url",
] as const;

/** How long before now an expired statement stopped vouching, in seconds. */
const expiredStatementLapseSeconds = 24 * 60 * 60;

/** How long an expired statement vouched for before that, in seconds. */
const expiredStatementValiditySeconds = 60 * 60;

/** How much of a non-JSON refusal is quoted in a judgement. */
const maximumQuotedTextLength = 120;

/**
 * The order the report shows the checks in: the profile's own table.
 *
 * Also the set a run must be complete to pass, which is why it is a value rather
 * than a comment - FR-029's minimum is enforced by {@link harnessVerdict} rather
 * than trusted to whoever writes the run.
 */
export const harnessCheckOrder: readonly HarnessCheckName[] = [
  "validStatement",
  "tamperedSignature",
  "expiredStatement",
  "replayedStatement",
  "metadataFidelity",
  "statementOnly",
];

/**
 * What each check is called, in words a vendor reading a report can act on.
 *
 * Each names the behaviour rather than the mechanism, because the reader is
 * looking for what their server did wrong.
 */
export const harnessCheckTitles: Record<HarnessCheckName, string> = {
  validStatement: "A valid statement registers a client",
  tamperedSignature: "A tampered signature is refused",
  expiredStatement: "An expired statement is refused",
  replayedStatement: "A replayed statement identifier is refused",
  metadataFidelity: "The registered client matches the statement",
  statementOnly: "Metadata asserted outside the statement is not honoured",
};

/** One exchange with a registration endpoint, as the report records it. */
export type HarnessExchange = {
  /** the request the harness made */
  readonly request: HarnessRequestEvidence;
  /** what came back */
  readonly response: HarnessResponseEvidence;
};

/** What one check judged. */
export type HarnessCheckJudgement = {
  /** how it turned out */
  readonly outcome: HarnessCheckOutcome;
  /** why, in words fit to show the vendor whose server it was */
  readonly detail: string;
};

/** One disagreement between the vouched metadata and the registered client. */
export type MetadataDifference = {
  /** the metadata field */
  readonly field: string;
  /** what the statement vouched for */
  readonly vouched: string;
  /** what came back, null when the field was absent */
  readonly registered: string | null;
};

/** What deciding a run needs to know. */
export type HarnessRunFacts = {
  /** the account asking */
  readonly member: AccountFacts;
  /** whether that account belongs to the organisation owning the server */
  readonly ownsServer: boolean;
  /** the event's status */
  readonly eventStatus: EventStatus;
  /** how the server says it registers clients */
  readonly registrationMode: RegistrationMode;
  /** where it registers them, when it declares an endpoint */
  readonly registrationEndpoint: string | null;
};

/** What deciding where to delete a throwaway client needs to know. */
export type CleanupTargetFacts = {
  /** the endpoint the client was registered at */
  readonly registrationEndpoint: string;
  /** the management address the server named (RFC 7592) */
  readonly registrationClientUri: string | undefined;
  /** the management token the server named */
  readonly registrationAccessToken: string | undefined;
};

/** Where to delete a throwaway client, or why it cannot be deleted. */
export type CleanupTarget =
  | {
      /** the client can be deleted */
      readonly ok: true;
      /** the address to delete it at */
      readonly url: string;
      /** the token that authorises the deletion */
      readonly accessToken: string;
    }
  | {
      /** the client cannot be deleted */
      readonly ok: false;
      /** why, for the report to state */
      readonly reason: string;
    };

/** What became of one throwaway client. */
export type CleanupAttempt = {
  /** the identifier the server issued */
  readonly clientId: string;
  /** whether it was deleted */
  readonly deleted: boolean;
  /** why it was not, empty when it was */
  readonly reason: string;
};

/** What building the harness's own client metadata needs to know. */
export type HarnessProbeFacts = {
  /** the deployment's public URL, from which every address derives */
  readonly publicUrl: string;
};

/**
 * Decides whether a conformance run may be made.
 *
 * A run mints software statements and posts them at somebody's registration
 * endpoint, so it is a vouching action and it is deny by default (the
 * constitution). The account must be approved, verified and unrevoked; it must
 * belong to the organisation that owns the server, because nobody else may have
 * Muster fire signed statements at it; the event must be open, since the
 * statements are scoped to it; and the entry must actually declare trusted
 * registration with an endpoint.
 *
 * @param facts - the account, its ownership of the server, the event and the entry
 * @returns the decision
 * @example
 * ```ts
 * const decision = authoriseHarnessRun({
 *   member: factsFor(account),
 *   ownsServer: true,
 *   eventStatus: event.status,
 *   registrationMode: profile.registrationMode,
 *   registrationEndpoint: profile.registrationEndpoint ?? null,
 * });
 * ```
 */
export const authoriseHarnessRun = (
  facts: HarnessRunFacts,
): AuthorisationDecision => {
  const writing = authoriseWrite(facts.member);
  if (!writing.ok) {
    return writing;
  }
  if (!facts.ownsServer) {
    return refuse(
      "not_member",
      "A conformance run posts signed statements at a registration endpoint, so only a member of the organisation that owns the server may ask for one.",
    );
  }
  const openness = authoriseEventOpen(facts.eventStatus);
  if (!openness.ok) {
    return openness;
  }
  return authoriseDirectoryRegistration({
    registrationMode: facts.registrationMode,
    registrationEndpoint: facts.registrationEndpoint,
  });
};

/**
 * Trims a trailing slash from a base URL.
 *
 * @param url - the base URL
 * @returns the URL without a trailing slash
 */
const withoutTrailingSlash = (url: string): string => url.replace(/\/+$/, "");

/**
 * The metadata the harness asks a server to register.
 *
 * A public client, so no secret is ever issued for it: the harness has no
 * business holding a client secret, even a throwaway one. Its addresses derive
 * from `MUSTER_PUBLIC_URL` like every other public URL Muster advertises, and its
 * name says what it is, so a server owner reading their own client list can see
 * where it came from.
 *
 * @param facts - the deployment's public URL
 * @returns the field set to vouch for
 * @example
 * ```ts
 * const fields = harnessProbeFields({ publicUrl: config.publicUrl });
 * ```
 */
export const harnessProbeFields = (
  facts: HarnessProbeFacts,
): RegistrationFields => {
  const base = withoutTrailingSlash(facts.publicUrl);
  return {
    clientName: harnessClientName,
    launchUrl: `${base}/harness/launch`,
    redirectUris: [`${base}/harness/callback`],
    scopes: ["openid", "fhirUser", "launch/patient"],
    confidentiality: "public",
    launchContext: "patient",
    needsIntrospection: false,
  };
};

/**
 * The client metadata a statement vouches for.
 *
 * The profile's client metadata claims and nothing else: `iss`, `jti` and the
 * rest are the vouching's own business and a server has no reason to echo them
 * back, so asking it to would be inventing a requirement.
 *
 * @param claims - the statement's claims
 * @returns the metadata, keyed by the claim names it travels under
 * @example
 * ```ts
 * const differences = metadataDifferences(vouchedMetadata(claims), response.body);
 * ```
 */
export const vouchedMetadata = (
  claims: StatementClaims,
): Record<string, unknown> =>
  Object.fromEntries(
    metadataClaims.map((claim) => {
      const value: unknown = claims[claim];
      return [claim, Array.isArray(value) ? [...(value as unknown[])] : value];
    }),
  );

/**
 * Dates a statement's claims wholly in the past.
 *
 * A real statement, correctly signed by a published key, whose vouching window
 * closed a day ago: the only thing a server can refuse it for is its expiry,
 * which is what makes the check a check.
 *
 * @param claims - the claims to expire
 * @param now - the current instant
 * @returns the claims, with a vouching window that has already closed
 * @example
 * ```ts
 * const jws = await signJws(key, { ...expiredClaims(claims, new Date()) });
 * ```
 */
export const expiredClaims = (
  claims: StatementClaims,
  now: Date,
): StatementClaims => {
  const exp = Math.floor(now.getTime() / 1000) - expiredStatementLapseSeconds;
  return { ...claims, iat: exp - expiredStatementValiditySeconds, exp };
};

/**
 * Corrupts a statement's signature, leaving everything else alone.
 *
 * The header and the claims are untouched, so a server that reads a statement
 * without verifying it finds a perfectly good one - which is exactly the failure
 * this check exists to catch. Only the first character of the signature is
 * changed, and to a different one whatever it was, because a tamper that happened
 * to be a no-op would pass against a server that never verifies anything.
 *
 * @param jws - the statement to tamper with
 * @returns the statement with a signature that cannot verify
 * @throws {Error} when the value is not a three-segment JWS with a signature
 * @example
 * ```ts
 * const presented = tamperedStatement(await signJws(key, claims));
 * ```
 */
export const tamperedStatement = (jws: string): string => {
  const [header, payload, signature] = jws.split(".");
  if (
    header === undefined ||
    payload === undefined ||
    signature === undefined ||
    signature === ""
  ) {
    throw new Error(
      "A tampered statement is made from a signed one, and that is not a three-segment JWS.",
    );
  }
  return `${header}.${payload}.${signature.startsWith("A") ? "B" : "A"}${signature.slice(1)}`;
};

/**
 * Removes a statement's signature for the record.
 *
 * The claims stay fully readable - a reader of a public report can decode exactly
 * what Muster vouched for - and what is left registers nothing anywhere, which is
 * the whole point: a statement with its signature is a bearer artefact that any
 * server trusting Muster would accept.
 *
 * @param jws - the statement as it was presented
 * @returns the statement without its signature
 * @example
 * ```ts
 * redactStatement("eyJ.eyJ.sig"); // "eyJ.eyJ.[removed]"
 * ```
 */
export const redactStatement = (jws: string): string => {
  const [header, payload, signature] = jws.split(".");
  return header === undefined ||
    payload === undefined ||
    signature === undefined
    ? unreadableStatement
    : `${header}.${payload}.${signatureMarker}`;
};

/**
 * Records a request as evidence, with the statement redacted.
 *
 * Metadata asserted outside the statement is kept as it was sent: it is the very
 * thing the statement-only check is evidence of.
 *
 * @param method - the method used
 * @param url - the address posted to
 * @param body - the body sent
 * @returns the evidence to record
 * @example
 * ```ts
 * harnessRequestEvidence("POST", endpoint, { software_statement: jws });
 * ```
 */
export const harnessRequestEvidence = (
  method: string,
  url: string,
  body: Record<string, unknown>,
): HarnessRequestEvidence => ({
  method,
  url,
  body: Object.fromEntries(
    Object.entries(body).map(([name, value]) => [
      name,
      name === "software_statement" && typeof value === "string"
        ? redactStatement(value)
        : value,
    ]),
  ),
});

/**
 * Records a response as evidence, with credentials redacted.
 *
 * A body that is not a JSON object is kept as text rather than dropped: a server
 * answering with an HTML error page is still evidence, and a blank would look
 * like a server that said nothing.
 *
 * @param status - the status the server answered with
 * @param text - the body it answered with
 * @returns the evidence to record
 * @example
 * ```ts
 * harnessResponseEvidence(response.status, await response.text());
 * ```
 */
export const harnessResponseEvidence = (
  status: number,
  text: string,
): HarnessResponseEvidence => {
  if (text.length > maximumEvidenceLength) {
    return {
      status,
      body: null,
      text: `${text.slice(0, maximumEvidenceLength)} [truncated]`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { status, body: null, text };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { status, body: null, text };
  }
  return {
    status,
    body: Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).map(([name, value]) => [
        name,
        credentialMembers.has(name) ? redactedMarker : value,
      ]),
    ),
    text: null,
  };
};

/**
 * Whether a response registered something.
 *
 * @param response - the response to classify
 * @returns true for a 2xx
 */
const accepted = (response: HarnessResponseEvidence): boolean =>
  response.status >= 200 && response.status < 300;

/**
 * Reads a string member of a recorded body.
 *
 * @param response - the response to read
 * @param name - the member to read
 * @returns the value when it is a non-empty string
 */
const stringMember = (
  response: HarnessResponseEvidence,
  name: string,
): string | undefined => {
  const value = response.body?.[name];
  return typeof value === "string" && value !== "" ? value : undefined;
};

/**
 * Reads the client identifier a response named.
 *
 * @param response - the response to read
 * @returns the identifier, or undefined when it named none
 */
export const registeredClientId = (
  response: HarnessResponseEvidence,
): string | undefined => stringMember(response, "client_id");

/**
 * Renders what a server said about a refusal.
 *
 * @param response - the refusal
 * @returns the error and its description, or what came back instead
 */
const quoteRefusal = (response: HarnessResponseEvidence): string => {
  const error = stringMember(response, "error");
  if (error === undefined) {
    const text = (response.text ?? "").trim();
    return text === ""
      ? "no RFC 7591 error code"
      : `no RFC 7591 error code (${text.slice(0, maximumQuotedTextLength)})`;
  }
  const description = stringMember(response, "error_description");
  return description === undefined ? error : `${error} - ${description}`;
};

/**
 * Builds a judgement.
 *
 * @param outcome - how the check turned out
 * @param detail - why
 * @returns the judgement
 */
const judged = (
  outcome: HarnessCheckOutcome,
  detail: string,
): HarnessCheckJudgement => ({ outcome, detail });

/**
 * Judges whether a valid statement was accepted.
 *
 * The MUST the whole profile rests on. A 2xx that names no `client_id` has
 * registered nothing the rest of the run could check, so it fails rather than
 * being read optimistically; a 200 where RFC 7591 states 201 registered the
 * client, so it is an advisory.
 *
 * @param exchange - the exchange to judge
 * @returns the judgement
 * @example
 * ```ts
 * const judgement = judgeAcceptance(exchange);
 * ```
 */
export const judgeAcceptance = (
  exchange: HarnessExchange,
): HarnessCheckJudgement => {
  const { response } = exchange;
  if (!accepted(response)) {
    return judged(
      "failed",
      `Refused a valid statement with HTTP ${String(response.status)}: ${quoteRefusal(response)}.`,
    );
  }
  const clientId = registeredClientId(response);
  if (clientId === undefined) {
    return judged(
      "failed",
      `Answered HTTP ${String(response.status)} but named no client_id, so nothing was registered that the rest of the run could check.`,
    );
  }
  return response.status === 201
    ? judged("passed", `Registered the throwaway client as ${clientId}.`)
    : judged(
        "advisory",
        `Registered the throwaway client as ${clientId}, but answered HTTP ${String(response.status)} where RFC 7591 states 201.`,
      );
};

/**
 * Judges whether a statement the profile says must be refused was refused.
 *
 * Refusing is the MUST; naming the profile's error code is a SHOULD, so a server
 * that refused for the right reason under the wrong name is reported as an
 * advisory and keeps its badge.
 *
 * @param exchange - the exchange to judge
 * @param expected - the RFC 7591 error the profile states for this failure
 * @returns the judgement
 * @example
 * ```ts
 * judgeRefusal(exchange, "invalid_software_statement");
 * ```
 */
export const judgeRefusal = (
  exchange: HarnessExchange,
  expected: string,
): HarnessCheckJudgement => {
  const { response } = exchange;
  if (accepted(response)) {
    const clientId = registeredClientId(response);
    return judged(
      "failed",
      `The server accepted it with HTTP ${String(response.status)}${clientId === undefined ? "" : `, registering ${clientId}`}, where the profile requires a refusal.`,
    );
  }
  const error = stringMember(response, "error");
  return error === expected
    ? judged(
        "passed",
        `Refused with HTTP ${String(response.status)} and ${expected}.`,
      )
    : judged(
        "advisory",
        `Refused with HTTP ${String(response.status)}, which is what matters, but named ${error ?? "no RFC 7591 error code"} where the profile states ${expected} (a SHOULD).`,
      );
};

/**
 * Renders the members of an array as sorted strings.
 *
 * @param values - the array, as it arrived
 * @returns its members as strings, in order
 */
const sortedStrings = (values: readonly unknown[]): readonly string[] =>
  values.map((value) => String(value)).toSorted();

/**
 * Renders one metadata value for a report.
 *
 * @param value - the value to render
 * @returns the value as a reader would see it
 */
const renderValue = (value: unknown): string =>
  Array.isArray(value)
    ? (value as readonly unknown[]).map((entry) => String(entry)).join(", ")
    : typeof value === "string"
      ? value
      : JSON.stringify(value);

/**
 * Whether two metadata values are the same registration.
 *
 * Arrays are compared as sets: a server that returns the same redirect URIs in
 * another order has registered the same client, and failing it for that would be
 * the harness inventing a requirement.
 *
 * @param vouched - what the statement vouched for
 * @param registered - what came back
 * @returns true when they say the same thing
 */
const sameValue = (vouched: unknown, registered: unknown): boolean =>
  Array.isArray(vouched) && Array.isArray(registered)
    ? JSON.stringify(sortedStrings(vouched)) ===
      JSON.stringify(sortedStrings(registered))
    : JSON.stringify(vouched) === JSON.stringify(registered);

/**
 * Compares the vouched metadata with the client the server says it registered.
 *
 * Only the vouched fields are compared, in the order they were vouched. A server
 * that registers additional metadata of its own is not failing the profile: the
 * anchor vouches for what it vouched for, not for everything else.
 *
 * @param vouched - the metadata the statement carried
 * @param registered - the metadata the response carried, null when it carried none
 * @returns the disagreements, empty when the client matches
 * @example
 * ```ts
 * metadataDifferences(vouched, exchange.response.body);
 * ```
 */
export const metadataDifferences = (
  vouched: Record<string, unknown>,
  registered: Record<string, unknown> | null,
): readonly MetadataDifference[] =>
  Object.entries(vouched).flatMap(
    ([field, value]): readonly MetadataDifference[] => {
      const answered = registered?.[field];
      if (answered === undefined) {
        return [{ field, vouched: renderValue(value), registered: null }];
      }
      return sameValue(value, answered)
        ? []
        : [
            {
              field,
              vouched: renderValue(value),
              registered: renderValue(answered),
            },
          ];
    },
  );

/**
 * Says what the disagreements are, naming both values.
 *
 * @param differences - the disagreements
 * @returns the phrase to put in a judgement
 */
const describeDifferences = (
  differences: readonly MetadataDifference[],
): string =>
  differences
    .map((difference) =>
      difference.registered === null
        ? `${difference.field} is missing`
        : `${difference.field} came back as ${difference.registered} where the statement vouched for ${difference.vouched}`,
    )
    .join("; ");

/**
 * Judges whether the registered client is the client that was vouched for.
 *
 * RFC 7591 section 3.2.1 requires the registered metadata in the response, and
 * this is why the profile repeats it: a response carrying only an identifier
 * leaves no way to show that the client created is the client vouched for, so it
 * fails rather than being given the benefit of the doubt.
 *
 * @param vouched - the metadata the statement carried
 * @param exchange - the exchange the valid statement produced
 * @returns the judgement
 * @example
 * ```ts
 * judgeFidelity(vouchedMetadata(claims), exchange);
 * ```
 */
export const judgeFidelity = (
  vouched: Record<string, unknown>,
  exchange: HarnessExchange,
): HarnessCheckJudgement => {
  if (!accepted(exchange.response)) {
    return judged(
      "failed",
      "Nothing was registered, so the registered client could not be compared with what the statement vouched for.",
    );
  }
  const differences = metadataDifferences(vouched, exchange.response.body);
  return differences.length === 0
    ? judged(
        "passed",
        "Every field the statement vouched for came back unchanged.",
      )
    : judged(
        "failed",
        `The registered client differs from the statement: ${describeDifferences(differences)}.`,
      );
};

/**
 * Judges whether metadata asserted outside the statement was honoured.
 *
 * The profile permits either answer: refuse the request, or ignore what is
 * outside the signature. What it forbids is honouring it - the anchor vouches for
 * the metadata, so a value that arrived unsigned must not override a value that
 * arrived signed.
 *
 * @param vouched - the metadata the statement carried
 * @param exchange - the exchange the statement-plus-metadata request produced
 * @param outside - the field names asserted outside the statement
 * @returns the judgement
 * @example
 * ```ts
 * judgeStatementOnly(vouched, exchange, ["client_name"]);
 * ```
 */
export const judgeStatementOnly = (
  vouched: Record<string, unknown>,
  exchange: HarnessExchange,
  outside: readonly string[],
): HarnessCheckJudgement => {
  const named = outside.join(", ");
  if (!accepted(exchange.response)) {
    return judged(
      "passed",
      `Refused a request that asserted ${named} outside the statement.`,
    );
  }
  const differences = metadataDifferences(vouched, exchange.response.body);
  return differences.length === 0
    ? judged(
        "passed",
        `Accepted the request but registered only what the statement vouched for, ignoring ${named}.`,
      )
    : judged(
        "failed",
        `Metadata asserted outside the statement (${named}) was not ignored: ${describeDifferences(differences)}.`,
      );
};

/**
 * Aggregates a run's verdict.
 *
 * Deny by default: the verdict is a pass only when every check the profile names
 * was made and none of them failed. A run that skipped a check has not shown the
 * profile is implemented, whatever the checks it did make said, and advisories -
 * the profile's SHOULDs - do not remove the badge.
 *
 * @param checks - the checks the run made
 * @returns the verdict, which is what the badge follows
 * @example
 * ```ts
 * const verdict = harnessVerdict(checks);
 * ```
 */
export const harnessVerdict = (
  checks: readonly HarnessCheck[],
): HarnessVerdict => {
  const made = new Set(checks.map((check) => check.name));
  const complete = harnessCheckOrder.every((name) => made.has(name));
  return complete && checks.every((check) => check.outcome !== "failed")
    ? "passed"
    : "failed";
};

/**
 * Decides where to delete a throwaway client.
 *
 * A server that returned neither of RFC 7592's management members is within the
 * profile, and its client is reported as left behind rather than failed. The
 * address it did return is not followed off the server's own origin: a
 * registration response is not a licence to make Muster delete something
 * somewhere else, and the guard should never be the only thing that noticed.
 *
 * @param facts - the endpoint the client was registered at, and what the server
 *   named for managing it
 * @returns the target, or why there is none
 * @example
 * ```ts
 * const target = cleanupTarget({
 *   registrationEndpoint: endpoint,
 *   registrationClientUri: body["registration_client_uri"],
 *   registrationAccessToken: body["registration_access_token"],
 * });
 * ```
 */
export const cleanupTarget = (facts: CleanupTargetFacts): CleanupTarget => {
  const uri = facts.registrationClientUri?.trim() ?? "";
  const token = facts.registrationAccessToken?.trim() ?? "";
  if (uri === "") {
    return {
      ok: false,
      reason:
        "the server returned no registration_client_uri, so RFC 7592 deletion was not possible",
    };
  }
  if (token === "") {
    return {
      ok: false,
      reason:
        "the server returned no registration_access_token, so RFC 7592 deletion was not possible",
    };
  }
  let target: URL;
  let endpoint: URL;
  try {
    target = new URL(uri);
    endpoint = new URL(facts.registrationEndpoint);
  } catch {
    return {
      ok: false,
      reason: `the registration_client_uri ${uri} is not a URL Muster could follow`,
    };
  }
  if (target.origin !== endpoint.origin) {
    return {
      ok: false,
      reason: `the registration_client_uri ${uri} is on a different origin from the registration endpoint, so Muster did not follow it`,
    };
  }
  return { ok: true, url: target.toString(), accessToken: token };
};

/**
 * Says what became of the throwaway clients a run registered.
 *
 * Acceptance scenario 4: the report states what was left behind. When nothing
 * was, it says so, because a report that is silent about cleanup leaves the
 * reader wondering whether it happened.
 *
 * @param attempts - what the run tried to delete, and what happened
 * @returns the sentence to record against the run
 * @example
 * ```ts
 * const cleanup = describeCleanup(attempts);
 * ```
 */
export const describeCleanup = (
  attempts: readonly CleanupAttempt[],
): string => {
  if (attempts.length === 0) {
    return "No client was registered, so there was nothing to clean up.";
  }
  const deleted = attempts.filter((attempt) => attempt.deleted);
  const left = attempts.filter((attempt) => !attempt.deleted);
  const parts = [
    ...(deleted.length === 0
      ? []
      : [`Deleted ${deleted.map((attempt) => attempt.clientId).join(", ")}.`]),
    ...left.map(
      (attempt) => `Left behind ${attempt.clientId}: ${attempt.reason}.`,
    ),
    ...(left.length === 0
      ? []
      : [
          left.length === 1
            ? "Delete it by hand at the server."
            : "Delete them by hand at the server.",
        ]),
  ];
  return parts.join(" ");
};
