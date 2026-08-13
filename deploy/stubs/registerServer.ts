/**
 * A reference implementation of the trusted dynamic client registration profile.
 *
 * This is the counterparty for quickstart scenario 3 and the target for the conformance
 * harness. It is a stub in that it keeps its clients in a `Map` and has no authorization
 * server behind it; it is not a stub in the part that matters, which is that it applies every
 * validation rule `contracts/registration-profile.md` requires of a server, in the order the
 * contract lists them.
 *
 * Four decisions worth stating.
 *
 * **No dependencies, and its own JOSE.** Verification is Web Crypto directly rather than
 * `jose`, for two reasons. The container is `oven/bun` with this directory mounted and nothing
 * installed, so a dependency would need an install step or a second image. And a conformance
 * counterparty that shared a JOSE implementation with the thing it is checking would agree
 * with Muster about anything both of them got wrong.
 *
 * **It refuses metadata asserted outside the statement.** The profile says a server MUST
 * ignore or reject it, and rejecting is the more useful of the two for a harness: a client
 * whose redirect URI came from the request body rather than from the anchor's vouching is
 * exactly the gap vouching closes, and silence about it would let an implementer keep the bug.
 *
 * **The `jti` is single-use, arbitrated by one map.** A second registration with an identifier
 * already seen is refused whether or not the first one succeeded, because the identifier is
 * what the anchor promises is unique per registration.
 *
 * **It tells the harness where the client it made can be deleted.** The registration response
 * carries RFC 7592's `registration_client_uri` and `registration_access_token`, which is how the
 * conformance harness cleans up the throwaway clients it registers (quickstart scenario 4) - and
 * how it knows to report a client as left behind when a server supplies neither. The delete
 * itself does not require the token; a stub that stored one would be implementing RFC 7592's
 * authorization rather than the registration profile.
 *
 * **The broken modes are deliberate and named.** `STUB_BROKEN_MODE` turns individual rules
 * off, so the harness can be shown to fail when the far end is wrong rather than only to pass
 * when it is right - a check that has never gone red is not evidence. They are opt-in, one per
 * rule, and the response header `x-stub-broken-mode` says which are on so a run's evidence
 * records what it was pointed at.
 *
 * Author: John Grimes
 */

// Declared a module so the top-level `await` that reads the TLS files typechecks. Nothing
// imports this file; it is an entry point.
export {};

/** A rule this stub can be told to break. */
type BrokenMode =
  /** Does not verify the JWS signature. The harness's tampered-signature check must fail. */
  | "skip-signature"
  /** Does not enforce single-use statement identifiers. */
  | "allow-replay"
  /** Does not check `iat`/`exp`. */
  | "ignore-expiry"
  /** Honours client metadata asserted outside the statement. */
  | "accept-outside-metadata"
  /** Answers every refusal with `invalid_request`, so the error vocabulary is useless. */
  | "vague-errors";

/** Every mode, so an unrecognised one can be reported rather than ignored. */
const BROKEN_MODES: readonly BrokenMode[] = [
  "skip-signature",
  "allow-replay",
  "ignore-expiry",
  "accept-outside-metadata",
  "vague-errors",
];

/** The RFC 7591 error codes this stub answers with. */
type RegistrationError =
  "invalid_request" | "invalid_software_statement" | "invalid_client_metadata";

/** A client this stub has registered. */
interface StubClient {
  readonly clientId: string;
  readonly clientName: string;
  readonly redirectUris: readonly string[];
  readonly grantTypes: readonly string[];
  readonly tokenEndpointAuthMethod: string;
  readonly scope: string;
  readonly smartLaunchUrl: string | null;
  readonly softwareId: string;
  readonly musterEvent: string;
  /** When the vouching stops, which is when this client stops being able to get tokens. */
  readonly expiresAt: number;
  readonly statementId: string;
}

/** How the stub was configured. */
interface StubConfig {
  readonly port: number;
  /** The issuer identifier a statement must carry. */
  readonly issuer: string;
  /** Where the anchor's keys are fetched from. May differ from the issuer inside a network. */
  readonly jwksUrl: string;
  readonly broken: ReadonlySet<BrokenMode>;
  readonly tlsCert: string | undefined;
  readonly tlsKey: string | undefined;
}

/** `iat` may be this far in the future, for clock skew between two hosts. */
const CLOCK_TOLERANCE_SECONDS = 60;

/** The authentication methods a client may be registered for. */
const PERMITTED_AUTH_METHODS = new Set([
  "none",
  "client_secret_basic",
  "private_key_jwt",
]);

/** Reads a variable, treating a blank string as absent. */
function read(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value.trim().length === 0 ? undefined : value;
}

/** Resolves the configuration, refusing rather than guessing. */
function loadConfig(): StubConfig {
  const issuer = read("STUB_ISSUER");
  if (issuer === undefined) {
    throw new Error(
      "STUB_ISSUER is required; it is the anchor issuer identifier a statement must carry",
    );
  }
  const jwksUrl =
    read("STUB_JWKS_URL") ??
    `${issuer.replace(/\/+$/, "")}/.well-known/jwks.json`;

  const broken = new Set<BrokenMode>();
  for (const name of (read("STUB_BROKEN_MODE") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0)) {
    if (!(BROKEN_MODES as readonly string[]).includes(name)) {
      throw new Error(
        `STUB_BROKEN_MODE names "${name}", which is not one of ${BROKEN_MODES.join(", ")}`,
      );
    }
    broken.add(name as BrokenMode);
  }

  return {
    port: Number(read("STUB_PORT") ?? "8443"),
    issuer: issuer.replace(/\/+$/, ""),
    jwksUrl,
    broken,
    tlsCert: read("STUB_TLS_CERT"),
    tlsKey: read("STUB_TLS_KEY"),
  };
}

const config = loadConfig();

/** The clients this stub has registered, by identifier. */
const clients = new Map<string, StubClient>();

/** Every statement identifier it has seen. Single use, per the profile. */
const usedStatementIds = new Set<string>();

/** The anchor's keys, and when they were last fetched. */
let cachedKeys:
  { readonly at: number; readonly keys: JsonWebKey[] } | undefined;

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
 * Fetches the anchor's JWKS.
 *
 * Cached for a minute, and the cache is bypassed when a `kid` is unknown - which is what the
 * profile requires: verification against a stale cache must not succeed for a key that has
 * been withdrawn, and an unknown key must be refetched once before it is refused.
 */
async function anchorKeys(fresh: boolean): Promise<JsonWebKey[]> {
  const now = Date.now();
  if (!fresh && cachedKeys !== undefined && now - cachedKeys.at < 60_000) {
    return cachedKeys.keys;
  }
  const response = await fetch(config.jwksUrl, {
    headers: { accept: "application/jwk-set+json, application/json" },
  });
  if (!response.ok) {
    throw new Error(
      `the anchor's JWKS answered ${String(response.status)} at ${config.jwksUrl}`,
    );
  }
  const document = (await response.json()) as { keys?: JsonWebKey[] };
  const keys = Array.isArray(document.keys) ? document.keys : [];
  cachedKeys = { at: now, keys };
  return keys;
}

/**
 * Verifies an ES256 compact JWS against the anchor's published keys.
 *
 * Hand-rolled over Web Crypto rather than through a JOSE library: see the module header. The
 * algorithm comes from this stub's own list and never from the token, because an implementation
 * that accepted whatever `alg` a token claimed would accept `none`.
 */
async function verifyStatement(
  jws: string,
): Promise<
  | { readonly ok: true; readonly claims: Record<string, unknown> }
  | { readonly ok: false; readonly detail: string }
> {
  const parts = jws.split(".");
  if (parts.length !== 3) {
    return { ok: false, detail: "the software statement is not a compact JWS" };
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
    return { ok: false, detail: "the software statement is not readable JSON" };
  }

  if (header.alg !== "ES256") {
    return {
      ok: false,
      detail: `the software statement must be signed with ES256, not ${String(header.alg)}`,
    };
  }
  if (typeof header.kid !== "string") {
    return { ok: false, detail: "the protected header carries no kid" };
  }
  if (config.broken.has("skip-signature")) {
    return { ok: true, claims };
  }

  const signed = new TextEncoder().encode(
    `${encodedHeader}.${encodedPayload}`,
  ) as Uint8Array<ArrayBuffer>;
  const signature = fromBase64Url(encodedSignature);

  // Once against the cache, then once against a fresh fetch: an unknown kid is refetched
  // before it is refused, and a withdrawn one is refused even if the cache still has it.
  for (const fresh of [false, true]) {
    const keys = await anchorKeys(fresh);
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
    detail: `the anchor publishes no key with kid ${String(header.kid)}`,
  };
}

/** An RFC 7591 error response. */
function refuse(
  error: RegistrationError,
  description: string,
  status = 400,
): Response {
  const code = config.broken.has("vague-errors") ? "invalid_request" : error;
  return Response.json(
    { error: code, error_description: description },
    {
      status,
      headers: {
        "cache-control": "no-store",
        "x-stub-broken-mode": [...config.broken].join(",") || "none",
      },
    },
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

/** A string-array claim, or undefined. */
function arrayClaim(
  claims: Record<string, unknown>,
  name: string,
): readonly string[] | undefined {
  const value = claims[name];
  return Array.isArray(value) &&
    value.every((entry) => typeof entry === "string")
    ? (value as string[])
    : undefined;
}

/** Whether the temporal claims put now inside the vouching window. */
function temporalRefusal(claims: Record<string, unknown>): string | undefined {
  if (config.broken.has("ignore-expiry")) {
    return undefined;
  }
  const now = Math.floor(Date.now() / 1000);
  const iat = claims["iat"];
  const exp = claims["exp"];
  if (typeof iat !== "number" || typeof exp !== "number") {
    // Absence is not permission: RFC 7591 makes `exp` optional and this profile does not.
    return "the software statement must carry iat and exp";
  }
  if (iat > now + CLOCK_TOLERANCE_SECONDS) {
    return "the software statement is not valid yet";
  }
  if (exp <= now) {
    return "the software statement has expired";
  }
  return undefined;
}

/** Whether the vouched metadata passes this server's own client rules. */
function metadataRefusal(claims: Record<string, unknown>): string | undefined {
  if (stringClaim(claims, "client_name") === undefined) {
    return "client_name is required";
  }
  const redirectUris = arrayClaim(claims, "redirect_uris");
  if (redirectUris === undefined || redirectUris.length === 0) {
    return "at least one redirect_uri is required";
  }
  const insecure = redirectUris.find(
    (uri) => !uri.startsWith("https://") && !uri.startsWith("http://localhost"),
  );
  if (insecure !== undefined) {
    return `redirect_uri ${insecure} must be https, or http on localhost`;
  }
  const grantTypes = arrayClaim(claims, "grant_types");
  if (grantTypes === undefined || !grantTypes.includes("authorization_code")) {
    return "grant_types must include authorization_code";
  }
  const authMethod = stringClaim(claims, "token_endpoint_auth_method");
  if (authMethod === undefined || !PERMITTED_AUTH_METHODS.has(authMethod)) {
    return `token_endpoint_auth_method must be one of ${[...PERMITTED_AUTH_METHODS].join(", ")}`;
  }
  return undefined;
}

/** The registered client, as RFC 7591 §3.2.1 returns it. */
function registrationResponse(
  client: StubClient,
  secret: string | undefined,
  origin: string,
): Response {
  return Response.json(
    {
      client_id: client.clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      // RFC 7592: where this client can be read and deleted. The harness uses it to clean up.
      registration_client_uri: `${origin}/clients/${client.clientId}`,
      registration_access_token: `stub-rat-${client.clientId}`,
      ...(secret === undefined
        ? {}
        : // Zero means "does not expire" per §3.2.1. The *vouching* expires instead, and this
          // stub records that as `expiresAt` and would cap tokens at it.
          { client_secret: secret, client_secret_expires_at: 0 }),
      client_name: client.clientName,
      redirect_uris: client.redirectUris,
      grant_types: client.grantTypes,
      token_endpoint_auth_method: client.tokenEndpointAuthMethod,
      scope: client.scope,
      software_id: client.softwareId,
    },
    {
      status: 201,
      headers: {
        "cache-control": "no-store",
        "x-stub-broken-mode": [...config.broken].join(",") || "none",
      },
    },
  );
}

/** Handles `POST /register`, in the order the profile lists its rules. */
async function handleRegister(
  request: Request,
  origin: string,
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return refuse("invalid_request", "the request body must be JSON");
  }
  if (typeof body !== "object" || body === null) {
    return refuse("invalid_request", "the request body must be a JSON object");
  }

  const outside = Object.fromEntries(
    Object.entries(body as Record<string, unknown>).filter(
      ([member]) => member !== "software_statement",
    ),
  );
  const members = Object.keys(body as Record<string, unknown>);
  const jws = (body as { software_statement?: unknown }).software_statement;
  if (typeof jws !== "string") {
    return refuse("invalid_request", "software_statement is required");
  }
  if (
    !config.broken.has("accept-outside-metadata") &&
    members.some((member) => member !== "software_statement")
  ) {
    // The anchor vouches for what is inside the statement, so nothing outside may add to it.
    return refuse(
      "invalid_request",
      "this server takes client metadata only from the software statement",
    );
  }

  let verified: Awaited<ReturnType<typeof verifyStatement>>;

  try {
    verified = await verifyStatement(jws);
  } catch (error) {
    return refuse(
      "invalid_software_statement",
      `the anchor's keys could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!verified.ok) {
    return refuse("invalid_software_statement", verified.detail);
  }
  // The whole of `accept-outside-metadata`: the members beside the statement win, so the client
  // this server creates is not the client the anchor vouched for. Skipping the rejection alone
  // would leave the stub conformant - the profile permits ignoring what it does not reject - and
  // a mode that breaks no rule gives the harness nothing to catch.
  const claims = config.broken.has("accept-outside-metadata")
    ? { ...verified.claims, ...outside }
    : verified.claims;

  if (stringClaim(claims, "iss") !== config.issuer) {
    return refuse(
      "invalid_software_statement",
      `iss must be ${config.issuer}, not ${String(claims["iss"])}`,
    );
  }

  const temporal = temporalRefusal(claims);
  if (temporal !== undefined) {
    return refuse("invalid_software_statement", temporal);
  }

  const statementId = stringClaim(claims, "jti");
  if (statementId === undefined) {
    return refuse("invalid_software_statement", "jti is required");
  }
  if (!config.broken.has("allow-replay") && usedStatementIds.has(statementId)) {
    return refuse(
      "invalid_software_statement",
      "this statement identifier has already been used to register a client",
    );
  }

  const metadata = metadataRefusal(claims);
  if (metadata !== undefined) {
    // Vouching attests origin, not validity: this is the server's own rule failing.
    return refuse("invalid_client_metadata", metadata);
  }

  // Claimed before the client is created, so two requests racing one identifier yield exactly
  // one client.
  usedStatementIds.add(statementId);

  const authMethod =
    stringClaim(claims, "token_endpoint_auth_method") ?? "none";
  const client: StubClient = {
    clientId: `stub-${crypto.randomUUID().slice(0, 8)}`,
    clientName: stringClaim(claims, "client_name") ?? "",
    redirectUris: arrayClaim(claims, "redirect_uris") ?? [],
    grantTypes: arrayClaim(claims, "grant_types") ?? [],
    tokenEndpointAuthMethod: authMethod,
    scope: stringClaim(claims, "scope") ?? "",
    smartLaunchUrl: stringClaim(claims, "smart_launch_url") ?? null,
    softwareId: stringClaim(claims, "software_id") ?? "",
    musterEvent: stringClaim(claims, "muster_event") ?? "",
    expiresAt: typeof claims["exp"] === "number" ? claims["exp"] : 0,
    statementId,
  };
  clients.set(client.clientId, client);

  const secret =
    authMethod === "client_secret_basic"
      ? Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString(
          "base64url",
        )
      : undefined;

  console.log(
    JSON.stringify({
      message: "stub.client.registered",
      clientId: client.clientId,
      softwareId: client.softwareId,
      musterEvent: client.musterEvent,
      statementId,
      confidential: secret !== undefined,
    }),
  );

  return registrationResponse(client, secret, origin);
}

/** The client a harness registered, so it can check the metadata was kept faithfully. */
function handleReadClient(clientId: string): Response {
  const client = clients.get(clientId);
  if (client === undefined) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  return Response.json({
    client_id: client.clientId,
    client_name: client.clientName,
    redirect_uris: client.redirectUris,
    grant_types: client.grantTypes,
    token_endpoint_auth_method: client.tokenEndpointAuthMethod,
    scope: client.scope,
    smart_launch_url: client.smartLaunchUrl,
    software_id: client.softwareId,
    muster_event: client.musterEvent,
    expires_at: client.expiresAt,
  });
}

/** A minimal smart-configuration, so an enrolled entry checks as reachable. */
function smartConfiguration(origin: string): Response {
  return Response.json({
    issuer: origin,
    jwks_uri: `${origin}/jwks`,
    authorization_endpoint: `${origin}/authorize`,
    token_endpoint: `${origin}/token`,
    registration_endpoint: `${origin}/register`,
    scopes_supported: [
      "launch",
      "openid",
      "fhirUser",
      "offline_access",
      "patient/*.rs",
      "patient/Questionnaire.rs",
    ],
    capabilities: [
      "launch-standalone",
      "client-public",
      "client-confidential-symmetric",
    ],
    code_challenge_methods_supported: ["S256"],
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
      software: { name: "Muster stub registration server" },
      fhirVersion: "4.0.1",
      format: ["application/fhir+json"],
      rest: [{ mode: "server", resource: [{ type: "Patient" }] }],
    }),
    { headers: { "content-type": "application/fhir+json; charset=UTF-8" } },
  );
}

/** Routes one request. */
async function handle(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const origin = `${url.protocol}//${url.host}`;

  if (url.pathname === "/healthz") {
    return Response.json({
      status: "ok",
      brokenModes: [...config.broken],
      clients: clients.size,
    });
  }
  if (request.method === "POST" && url.pathname === "/register") {
    return await handleRegister(request, origin);
  }
  const client = /^\/clients\/([^/]+)$/.exec(url.pathname);
  if (client !== null) {
    if (request.method === "GET") {
      return handleReadClient(client[1] ?? "");
    }
    if (request.method === "DELETE") {
      // Cleanup, so the harness can report that it left nothing behind.
      return new Response(null, {
        status: clients.delete(client[1] ?? "") ? 204 : 404,
      });
    }
  }
  if (url.pathname === "/.well-known/smart-configuration") {
    return smartConfiguration(origin);
  }
  if (url.pathname === "/metadata") {
    return capabilityStatement();
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
    message: "stub.listening",
    port: config.port,
    scheme: tls === undefined ? "http" : "https",
    issuer: config.issuer,
    jwksUrl: config.jwksUrl,
    brokenModes: [...config.broken],
  }),
);
