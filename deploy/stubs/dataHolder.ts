/**
 * A reference implementation of the permission ticket profile's data holder side.
 *
 * This is the counterparty for quickstart scenario 7 and the thing SC-007's "at least one
 * participating data holder" is demonstrated against locally. It is a stub in that it holds
 * one patient in a constant and issues an opaque access token nothing can be spent at; it is
 * not a stub in the part that matters, which is that it applies every obligation
 * `contracts/ticket-profile.md` puts on a data holder, in the order the contract lists them.
 *
 * Five decisions worth stating.
 *
 * **No dependencies, and its own JOSE.** Verification is Web Crypto directly rather than
 * `jose`, for the two reasons `registerServer.ts` gives: the container is `oven/bun` with
 * this directory mounted and nothing installed, and a counterparty that shared a JOSE
 * implementation with the thing it is checking would agree with Muster about anything both
 * of them got wrong.
 *
 * **The presenting client is authenticated, and a public one is refused.** Obligation 2. It
 * is a shared secret here rather than `private_key_jwt`, because the profile's example shows
 * a `client_assertion` and this stack has nowhere to publish a client's JWKS - but the rule
 * being demonstrated is that an unauthenticated presenter gets nothing, and that rule is
 * enforced whichever credential carries it.
 *
 * **Subject resolution is exact or it is a refusal.** Obligation 3: zero or many matches
 * refuse the exchange. One patient means the interesting case is the zero one, which a
 * ticket for a persona this holder never loaded produces - and that is the case a
 * connectathon actually hits.
 *
 * **The granted scopes are an intersection, and an empty one is a refusal.** Obligation 4.
 * Three sets: what the client asked for, what the ticket permits, and what this holder will
 * ever release. `scope` is optional in the request, and an absent one means "everything the
 * ticket permits" rather than "nothing" - a client that sends no `scope` has not narrowed
 * its request.
 *
 * **The access token cannot outlive the ticket.** Obligation 5, which is the one an
 * implementation gets wrong by defaulting to an hour: the lifetime is the smaller of this
 * holder's own and the ticket's remaining validity.
 *
 * ## It is also the stack's persona source
 *
 * Quickstart scenario 6 curates personas from the event's configured source server, which in
 * a real deployment is the Sparked AU Core server. The end-to-end suite cannot reach it: an
 * external dependency in a suite that has to pass on a machine with no egress is a suite that
 * reports a network outage as a product defect. So the compose stack points the event's
 * persona source at this holder, which is already a FHIR server holding the persona whose
 * coverage it reports.
 *
 * That costs a `Patient` read, a `name` search, and one more patient - one carrying **no**
 * IHI, because scenario 6 asks for a patient without one to be refused and a source with
 * nothing to refuse would prove only half of the rule. Nothing about the ticket exchange
 * reads either of them.
 *
 * Author: John Grimes
 */

// Declared a module so the top-level `await` that reads the TLS files typechecks. Nothing
// imports this file; it is an entry point.
export {};

/** RFC 8693's grant type. Anything else is `unsupported_grant_type`. */
const TOKEN_EXCHANGE_GRANT = "urn:ietf:params:oauth:grant-type:token-exchange";

/** The subject token type the profile presents a ticket as. */
const JWT_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:jwt";

/** What RFC 8693 calls what comes back. */
const ACCESS_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token";

/** `iat` may be this far in the future, for clock skew between two hosts. */
const CLOCK_TOLERANCE_SECONDS = 60;

/** The longest access token this holder will issue, before the ticket's cap applies. */
const MAX_TOKEN_LIFETIME_SECONDS = 900;

/** A patient this holder has loaded. */
interface StubPatient {
  readonly id: string;
  readonly name: string;
  readonly identifierSystem: string;
  readonly identifierValue: string;
}

/** How the stub was configured. */
interface StubConfig {
  readonly port: number;
  /** The issuer identifier a ticket must carry. */
  readonly issuer: string;
  /** Where the issuer's keys are fetched from. May differ inside a network. */
  readonly jwksUrl: string;
  /** The ticket types this holder accepts, advertised and enforced from one value. */
  readonly acceptedTicketTypes: readonly string[];
  /** Every scope this holder will ever release, whatever a ticket permits. */
  readonly policyScopes: readonly string[];
  /** The one patient this holder releases, and the only subject it resolves. */
  readonly patient: StubPatient;
  /**
   * A patient carrying no IHI, served by the search and by nothing else.
   *
   * Here so that the stack's persona source has something to refuse: "only patients with an
   * IHI can be personas" is a rule whose failing case is the interesting one.
   */
  readonly patientWithoutIhi: { readonly id: string; readonly name: string };
  /** The client that may present tickets. */
  readonly clientId: string;
  readonly clientSecret: string;
  readonly tlsCert: string | undefined;
  readonly tlsKey: string | undefined;
}

/** Reads a variable, treating a blank string as absent. */
function read(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value.trim().length === 0 ? undefined : value;
}

/** Reads a whitespace-or-comma separated list. */
function readList(
  name: string,
  fallback: readonly string[],
): readonly string[] {
  const raw = read(name);
  return raw === undefined
    ? fallback
    : raw
        .split(/[\s,]+/)
        .map((value) => value.trim())
        .filter((value) => value.length > 0);
}

/** Resolves the configuration, refusing rather than guessing. */
function loadConfig(): StubConfig {
  const issuer = read("STUB_ISSUER");
  if (issuer === undefined) {
    throw new Error(
      "STUB_ISSUER is required; it is the ticket issuer identifier a ticket must carry",
    );
  }
  const identifierSystem = read("STUB_PATIENT_IHI_SYSTEM");
  if (identifierSystem === undefined) {
    throw new Error(
      "STUB_PATIENT_IHI_SYSTEM is required; a subject is a system and a value, never a value alone",
    );
  }
  const identifierValue = read("STUB_PATIENT_IHI");
  if (identifierValue === undefined) {
    throw new Error(
      "STUB_PATIENT_IHI is required; it is the identifier this holder resolves a subject to",
    );
  }
  return {
    port: Number(read("STUB_PORT") ?? "8444"),
    issuer: issuer.replace(/\/+$/, ""),
    jwksUrl:
      read("STUB_JWKS_URL") ??
      `${issuer.replace(/\/+$/, "")}/.well-known/jwks.json`,
    acceptedTicketTypes: readList("STUB_TICKET_TYPES", ["patient-self-access"]),
    policyScopes: readList("STUB_POLICY_SCOPES", [
      "patient/Patient.rs",
      "patient/Observation.rs",
      "patient/Condition.rs",
    ]),
    patient: {
      id: read("STUB_PATIENT_ID") ?? "charlotte-morris",
      name: read("STUB_PATIENT_NAME") ?? "Charlotte Morris",
      identifierSystem,
      identifierValue,
    },
    patientWithoutIhi: {
      id: read("STUB_UNIDENTIFIED_PATIENT_ID") ?? "rowan-bell",
      name: read("STUB_UNIDENTIFIED_PATIENT_NAME") ?? "Rowan Bell",
    },
    clientId: read("STUB_CLIENT_ID") ?? "muster-playground",
    clientSecret: read("STUB_CLIENT_SECRET") ?? "playground-secret",
    tlsCert: read("STUB_TLS_CERT"),
    tlsKey: read("STUB_TLS_KEY"),
  };
}

const config = loadConfig();

/** The issuer's keys, and when they were last fetched. */
let cachedKeys:
  { readonly at: number; readonly keys: JsonWebKey[] } | undefined;

/** Every ticket identifier this holder has honoured. A ticket is exchanged once. */
const usedTicketIds = new Set<string>();

/**
 * Decodes unpadded base64url into bytes.
 *
 * Copied into a fresh buffer rather than viewed: `Buffer.from` may hand back a view over a
 * pooled allocation, which Web Crypto will not accept.
 */
function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const bytes = Buffer.from(value, "base64url");
  const copy = new Uint8Array(new ArrayBuffer(bytes.length));
  copy.set(bytes);
  return copy;
}

/**
 * Fetches the issuer's JWKS.
 *
 * Cached for a minute, and the cache is bypassed when a `kid` is unknown - which is what
 * principle VI requires of the far side: a rotated key must be found by refetching, and a
 * withdrawn one must not verify out of a stale cache.
 */
async function issuerKeys(fresh: boolean): Promise<JsonWebKey[]> {
  const now = Date.now();
  if (!fresh && cachedKeys !== undefined && now - cachedKeys.at < 60_000) {
    return cachedKeys.keys;
  }
  const response = await fetch(config.jwksUrl, {
    headers: { accept: "application/jwk-set+json, application/json" },
  });
  if (!response.ok) {
    throw new Error(
      `the issuer's JWKS answered ${String(response.status)} at ${config.jwksUrl}`,
    );
  }
  const document = (await response.json()) as { keys?: JsonWebKey[] };
  const keys = Array.isArray(document.keys) ? document.keys : [];
  cachedKeys = { at: now, keys };
  return keys;
}

/**
 * Verifies an ES256 compact JWS against the issuer's published keys (obligation 1).
 *
 * The algorithm comes from this stub's own list and never from the token, because an
 * implementation that accepted whatever `alg` a token claimed would accept `none`.
 */
async function verifyTicket(
  jws: string,
): Promise<
  | { readonly ok: true; readonly claims: Record<string, unknown> }
  | { readonly ok: false; readonly detail: string }
> {
  const parts = jws.split(".");
  if (parts.length !== 3) {
    return { ok: false, detail: "the subject token is not a compact JWS" };
  }
  const [encodedHeader = "", encodedPayload = "", encodedSignature = ""] =
    parts;

  let header: { alg?: unknown; kid?: unknown };
  let claims: Record<string, unknown>;
  try {
    header = JSON.parse(
      new TextDecoder().decode(fromBase64Url(encodedHeader)),
    ) as { alg?: unknown; kid?: unknown };
    claims = JSON.parse(
      new TextDecoder().decode(fromBase64Url(encodedPayload)),
    ) as Record<string, unknown>;
  } catch {
    return { ok: false, detail: "the subject token is not readable JSON" };
  }

  if (header.alg !== "ES256") {
    return {
      ok: false,
      detail: `the ticket must be signed with ES256, not ${String(header.alg)}`,
    };
  }
  if (typeof header.kid !== "string") {
    return { ok: false, detail: "the protected header carries no kid" };
  }

  const signed = new TextEncoder().encode(
    `${encodedHeader}.${encodedPayload}`,
  ) as Uint8Array<ArrayBuffer>;
  const signature = fromBase64Url(encodedSignature);

  // Once against the cache, then once against a fresh fetch: an unknown kid is refetched
  // before it is refused, and a withdrawn one is refused even if the cache still has it.
  for (const fresh of [false, true]) {
    const keys = await issuerKeys(fresh);
    const jwk = keys.find(
      (candidate) => (candidate as { kid?: string }).kid === header.kid,
    );
    if (jwk === undefined) {
      continue;
    }
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const verified = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      signature,
      signed,
    );
    return verified
      ? { ok: true, claims }
      : {
          ok: false,
          detail: `the signature does not verify against ${String(header.kid)}`,
        };
  }

  return {
    ok: false,
    detail: `the issuer publishes no key with kid ${String(header.kid)}`,
  };
}

/** An OAuth error response. */
function refuse(error: string, description: string, status = 400): Response {
  return Response.json(
    { error, error_description: description },
    { status, headers: { "cache-control": "no-store" } },
  );
}

/** A string claim, or undefined when it is missing or the wrong shape. */
function stringClaim(
  claims: Record<string, unknown>,
  name: string,
): string | undefined {
  const value = claims[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** The `subject.identifier` the ticket binds, or undefined when it binds none. */
function subjectIdentifier(
  claims: Record<string, unknown>,
): { readonly system: string; readonly value: string } | undefined {
  const subject = claims["subject"];
  if (typeof subject !== "object" || subject === null) {
    return undefined;
  }
  const identifier = (subject as { identifier?: unknown }).identifier;
  if (typeof identifier !== "object" || identifier === null) {
    return undefined;
  }
  const { system, value } = identifier as {
    system?: unknown;
    value?: unknown;
  };
  return typeof system === "string" && typeof value === "string"
    ? { system, value }
    : undefined;
}

/**
 * Whether the presenting client authenticated (obligation 2).
 *
 * HTTP Basic or the form parameters, which is what RFC 6749 §2.3.1 permits. A request that
 * presents no credential at all is refused rather than treated as a public client: a
 * permission ticket releases a patient's record, and an unauthenticated presenter is exactly
 * what the obligation exists to exclude.
 */
function authenticatedClient(request: Request, form: URLSearchParams): boolean {
  const header = request.headers.get("authorization") ?? "";
  if (header.toLowerCase().startsWith("basic ")) {
    const [id = "", secret = ""] = Buffer.from(header.slice(6), "base64")
      .toString()
      .split(":", 2);
    return id === config.clientId && secret === config.clientSecret;
  }
  return (
    form.get("client_id") === config.clientId &&
    form.get("client_secret") === config.clientSecret
  );
}

/** Whether the ticket's temporal claims put now inside its validity (obligation 1). */
function temporalRefusal(claims: Record<string, unknown>): string | undefined {
  const now = Math.floor(Date.now() / 1000);
  const iat = claims["iat"];
  const exp = claims["exp"];
  if (typeof iat !== "number" || typeof exp !== "number") {
    return "the ticket must carry iat and exp";
  }
  if (iat > now + CLOCK_TOLERANCE_SECONDS) {
    return "the ticket is not valid yet";
  }
  if (exp <= now) {
    return "the ticket has expired";
  }
  return undefined;
}

/**
 * Whether one permitted scope covers one requested scope.
 *
 * Exact equality, plus a wildcard resource: a ticket permitting `patient/*.rs` does permit
 * reading any resource in the patient compartment, and refusing a named one would make the
 * intersection wrong in the direction of granting too little.
 */
function scopeCovers(permitted: string, requested: string): boolean {
  if (permitted === requested) {
    return true;
  }
  const offered = /^patient\/(\*|[A-Za-z]+)\.([cruds]+)$/.exec(permitted);
  const wanted = /^patient\/(\*|[A-Za-z]+)\.([cruds]+)$/.exec(requested);
  if (offered === null || wanted === null) {
    return false;
  }
  if (offered[1] !== "*" && offered[1] !== wanted[1]) {
    return false;
  }
  return [...(wanted[2] ?? "")].every((letter) =>
    (offered[2] ?? "").includes(letter),
  );
}

/**
 * The scopes to grant: requested ∩ ticket ∩ policy (obligation 4).
 *
 * An absent `scope` parameter means the client has not narrowed its request, so the
 * candidates are everything the ticket permits. The result is expressed in the requested
 * spelling rather than the ticket's, so a client that asked for `patient/Patient.rs` and was
 * granted it under a `patient/*.rs` ticket sees the scope it asked for.
 */
function grantedScopes(
  requested: string | null,
  ticketScopes: readonly string[],
): readonly string[] {
  const candidates =
    requested === null || requested.trim().length === 0
      ? ticketScopes
      : requested.split(/\s+/).filter((scope) => scope.length > 0);
  return candidates.filter(
    (scope) =>
      ticketScopes.some((permitted) => scopeCovers(permitted, scope)) &&
      config.policyScopes.some((permitted) => scopeCovers(permitted, scope)),
  );
}

/** What a ticket amounted to: the granted scopes, or why nothing was granted. */
type Exchange =
  | {
      readonly ok: true;
      readonly scopes: readonly string[];
      readonly exp: number;
    }
  | { readonly ok: false; readonly response: Response };

/** Applies obligations 1, 3 and 4 to a verified ticket. */
function judgeTicket(
  claims: Record<string, unknown>,
  requestedScope: string | null,
): Exchange {
  if (stringClaim(claims, "iss") !== config.issuer) {
    return {
      ok: false,
      response: refuse(
        "invalid_grant",
        `iss must be ${config.issuer}, not ${String(claims["iss"])}`,
      ),
    };
  }
  const temporal = temporalRefusal(claims);
  if (temporal !== undefined) {
    return { ok: false, response: refuse("invalid_grant", temporal) };
  }

  const ticketType = stringClaim(claims, "ticket_type");
  if (
    ticketType === undefined ||
    !config.acceptedTicketTypes.includes(ticketType)
  ) {
    // Obligation 1's last clause, and the reason the accepted set is advertised: a client
    // that read the discovery document would not have presented this.
    return {
      ok: false,
      response: refuse(
        "invalid_grant",
        `this data holder accepts ${config.acceptedTicketTypes.join(", ")}, not ${String(ticketType)}`,
      ),
    };
  }

  const jti = stringClaim(claims, "jti");
  if (jti === undefined) {
    return { ok: false, response: refuse("invalid_grant", "jti is required") };
  }
  if (usedTicketIds.has(jti)) {
    return {
      ok: false,
      response: refuse(
        "invalid_grant",
        "this ticket has already been exchanged",
      ),
    };
  }

  // Obligation 3: exactly one local patient, or the exchange is refused.
  const subject = subjectIdentifier(claims);
  if (subject === undefined) {
    return {
      ok: false,
      response: refuse(
        "invalid_grant",
        "the ticket binds no subject.identifier, so there is nobody to resolve",
      ),
    };
  }
  const matches =
    subject.system === config.patient.identifierSystem &&
    subject.value === config.patient.identifierValue
      ? 1
      : 0;
  if (matches !== 1) {
    return {
      ok: false,
      response: refuse(
        "invalid_grant",
        `subject ${subject.system}|${subject.value} resolved to ${String(matches)} patients here; exactly one is required`,
      ),
    };
  }

  const ticketScopes = (stringClaim(claims, "smart_scopes") ?? "")
    .split(/\s+/)
    .filter((scope) => scope.length > 0);
  const scopes = grantedScopes(requestedScope, ticketScopes);
  if (scopes.length === 0) {
    // Obligation 4: an empty intersection is a refusal, not a token that can do nothing.
    return {
      ok: false,
      response: refuse(
        "invalid_scope",
        `nothing is left after intersecting the request with the ticket (${ticketScopes.join(" ")}) and this holder's policy (${config.policyScopes.join(" ")})`,
      ),
    };
  }

  usedTicketIds.add(jti);
  return { ok: true, scopes, exp: claims["exp"] as number };
}

/** Handles the RFC 8693 token exchange. */
async function handleToken(request: Request): Promise<Response> {
  const form = new URLSearchParams(await request.text());

  if (form.get("grant_type") !== TOKEN_EXCHANGE_GRANT) {
    return refuse(
      "unsupported_grant_type",
      `this endpoint takes ${TOKEN_EXCHANGE_GRANT}`,
    );
  }
  if (!authenticatedClient(request, form)) {
    // Obligation 2: no public or unauthenticated presenters.
    return refuse(
      "invalid_client",
      "the presenting client must authenticate; this data holder accepts no public presenters",
      401,
    );
  }
  if (form.get("subject_token_type") !== JWT_TOKEN_TYPE) {
    return refuse(
      "invalid_request",
      `subject_token_type must be ${JWT_TOKEN_TYPE}`,
    );
  }
  const subjectToken = form.get("subject_token");
  if (subjectToken === null || subjectToken.length === 0) {
    return refuse("invalid_request", "subject_token is required");
  }

  let verified: Awaited<ReturnType<typeof verifyTicket>>;
  try {
    verified = await verifyTicket(subjectToken);
  } catch (error) {
    return refuse(
      "invalid_grant",
      `the issuer's keys could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!verified.ok) {
    return refuse("invalid_grant", verified.detail);
  }

  const judged = judgeTicket(verified.claims, form.get("scope"));
  if (!judged.ok) {
    return judged.response;
  }

  // Obligation 5: the access token cannot outlive the ticket.
  const remaining = judged.exp - Math.floor(Date.now() / 1000);
  const expiresIn = Math.max(
    1,
    Math.min(MAX_TOKEN_LIFETIME_SECONDS, remaining),
  );

  console.log(
    JSON.stringify({
      message: "stub.ticket.exchanged",
      ticketId: verified.claims["jti"],
      patient: config.patient.id,
      granted: judged.scopes,
      expiresIn,
    }),
  );

  return Response.json(
    {
      access_token: `stub-at-${crypto.randomUUID()}`,
      issued_token_type: ACCESS_TOKEN_TYPE,
      token_type: "Bearer",
      expires_in: expiresIn,
      scope: judged.scopes.join(" "),
      // SMART's launch context: which patient the token is about. The point of the exchange
      // is that the holder resolved the IHI to this, rather than being told an identifier.
      patient: config.patient.id,
    },
    { headers: { "cache-control": "no-store" } },
  );
}

/** The discovery document, advertising the accepted types (obligation 6). */
function smartConfiguration(origin: string): Response {
  return Response.json({
    issuer: origin,
    jwks_uri: `${origin}/jwks`,
    authorization_endpoint: `${origin}/authorize`,
    token_endpoint: `${origin}/token`,
    scopes_supported: config.policyScopes,
    capabilities: ["launch-standalone", "permission-v2"],
    grant_types_supported: ["authorization_code", TOKEN_EXCHANGE_GRANT],
    code_challenge_methods_supported: ["S256"],
    // The field Muster's verification checks read, and the field the event view and the
    // playground surface (FR-034). One value drives both this and what `/token` enforces,
    // so what is advertised cannot drift from what is accepted.
    smart_permission_ticket_types_supported: config.acceptedTicketTypes,
  });
}

/** A CapabilityStatement thin enough to be honest about what this is. */
function capabilityStatement(): Response {
  // Labelled `application/fhir+json` rather than `application/json`, which is what Muster's
  // own checks read - so `Response.json` will not do, since it fixes the media type.
  return new Response(
    // eslint-disable-next-line unicorn/prefer-response-static-json
    JSON.stringify({
      resourceType: "CapabilityStatement",
      status: "active",
      date: new Date().toISOString(),
      kind: "instance",
      software: { name: "Muster stub data holder" },
      fhirVersion: "4.0.1",
      format: ["application/fhir+json"],
      rest: [
        {
          mode: "server",
          resource: [{ type: "Patient" }, { type: "Observation" }],
        },
      ],
    }),
    { headers: { "content-type": "application/fhir+json; charset=UTF-8" } },
  );
}

/** A patient this holder serves, and the IHI it carries if it carries one. */
interface LoadedPatient {
  readonly id: string;
  readonly name: string;
  readonly ihi: { readonly system: string; readonly value: string } | null;
}

/** Everything this holder will show a searcher. Only the first is ever released. */
const LOADED: readonly LoadedPatient[] = [
  {
    id: config.patient.id,
    name: config.patient.name,
    ihi: {
      system: config.patient.identifierSystem,
      value: config.patient.identifierValue,
    },
  },
  { ...config.patientWithoutIhi, ihi: null },
];

/** One patient as FHIR. A patient with no IHI carries no `identifier` at all. */
function patientResource(patient: LoadedPatient): Record<string, unknown> {
  const parts = patient.name.split(" ");
  return {
    resourceType: "Patient",
    id: patient.id,
    ...(patient.ihi === null ? {} : { identifier: [patient.ihi] }),
    name: [{ given: [parts[0] ?? ""], family: parts.slice(1).join(" ") }],
  };
}

/** A FHIR response, which is `application/fhir+json` and so not `Response.json`. */
function fhir(body: unknown, status = 200): Response {
  // eslint-disable-next-line unicorn/prefer-response-static-json
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/fhir+json; charset=UTF-8" },
  });
}

/**
 * The patients this holder has loaded, as a searchset.
 *
 * Answered anonymously so that Muster's persona coverage check can find them: the point of a
 * data holder in this stack is that the persona it releases is one the coverage grid has
 * already reported it holds - and the point of the `name` search is that the same server is
 * the stack's persona source (see this file's header).
 *
 * An unrecognised parameter narrows nothing, deliberately. Muster reads a searchset that
 * ignored the `identifier` it was given as `unverifiable` rather than as coverage, and a stub
 * that refused unknown parameters would hide that behaviour rather than exhibit it.
 */
function patientSearch(query: URLSearchParams): Response {
  const askedIdentifier = query.get("identifier");
  const askedName = query.get("name");

  const matched = LOADED.filter((patient) => {
    if (askedIdentifier !== null) {
      // Both spellings of the search, because a client may qualify the value with its
      // system or may not, and this holder knows only one.
      const spellings =
        patient.ihi === null
          ? []
          : [`${patient.ihi.system}|${patient.ihi.value}`, patient.ihi.value];
      if (!spellings.includes(askedIdentifier)) {
        return false;
      }
    }
    return (
      askedName === null ||
      patient.name.toLowerCase().includes(askedName.toLowerCase())
    );
  });

  return fhir({
    resourceType: "Bundle",
    type: "searchset",
    total: matched.length,
    entry: matched.map((patient) => ({ resource: patientResource(patient) })),
  });
}

/** One patient by id, which is how a persona is curated once it has been found. */
function patientRead(id: string): Response {
  const found = LOADED.find((patient) => patient.id === id);
  return found === undefined
    ? fhir(
        {
          resourceType: "OperationOutcome",
          issue: [
            {
              severity: "error",
              code: "not-found",
              diagnostics: `This holder has no patient with the id "${id}".`,
            },
          ],
        },
        404,
      )
    : fhir(patientResource(found));
}

/** Routes one request. */
async function handle(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const origin = `${url.protocol}//${url.host}`;

  if (url.pathname === "/healthz") {
    return Response.json({
      status: "ok",
      acceptedTicketTypes: config.acceptedTicketTypes,
      patient: config.patient.id,
      exchanged: usedTicketIds.size,
    });
  }
  if (request.method === "POST" && url.pathname === "/token") {
    return await handleToken(request);
  }
  if (url.pathname === "/.well-known/smart-configuration") {
    return smartConfiguration(origin);
  }
  if (url.pathname === "/metadata") {
    return capabilityStatement();
  }
  if (url.pathname === "/Patient") {
    return patientSearch(url.searchParams);
  }
  if (url.pathname.startsWith("/Patient/")) {
    return patientRead(
      decodeURIComponent(url.pathname.slice("/Patient/".length)),
    );
  }
  return Response.json({ error: "not_found" }, { status: 404 });
}

const tls =
  config.tlsCert === undefined || config.tlsKey === undefined
    ? undefined
    : {
        cert: await Bun.file(config.tlsCert).text(),
        key: await Bun.file(config.tlsKey).text(),
      };

Bun.serve({
  port: config.port,
  ...(tls === undefined ? {} : { tls }),
  fetch: handle,
});

console.log(
  JSON.stringify({
    message: "stub.data-holder.listening",
    port: config.port,
    scheme: tls === undefined ? "http" : "https",
    issuer: config.issuer,
    jwksUrl: config.jwksUrl,
    acceptedTicketTypes: config.acceptedTicketTypes,
    patient: `${config.patient.identifierSystem}|${config.patient.identifierValue}`,
  }),
);
