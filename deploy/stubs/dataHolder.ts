#!/usr/bin/env bun
/**
 * A reference data holder for the local stack.
 *
 * It implements the presentation half of the permission ticket profile Muster
 * publishes at `/docs/ticket-profile`: RFC 8693 token exchange at its token
 * endpoint, with every data-holder obligation the profile states applied in the
 * order the profile states them. So the whole of User Story 8 - mint a ticket in
 * the playground, present it, read the patient it resolved to - is provable without
 * a vendor's server, and the profile has an executable worked example on both
 * sides.
 *
 * Three design choices match the registration stub's. It has no dependencies: the
 * ES256 signature is verified with WebCrypto against a key set fetched for the
 * request, so a withdrawn key stops working immediately and the container is a bare
 * Bun image with one file mounted in. It holds its patients in memory, keyed by
 * IHI, because the point is resolution rather than storage. And ticket support is
 * switched off by emptying `STUB_TICKET_TYPES`, which is the profile's own rule
 * that the discovery member is published only while the types are accepted.
 *
 * Nothing here is Muster's code path: it is a participant's server, written to the
 * contract, and the only thing it shares with Muster is the document.
 *
 * Usage: `bun deploy/stubs/dataHolder.ts`, with `STUB_ISSUER` (the anchor's issuer
 * identifier), `STUB_JWKS_URL` (where its keys are published), `STUB_PORT`,
 * `STUB_TICKET_TYPES`, `STUB_SCOPES`, `STUB_PATIENTS` (`ihi=patientId` pairs) and
 * `STUB_IHI_SYSTEM`.
 *
 * @author John Grimes
 */

/** Where this stub listens. */
const port = Number(process.env["STUB_PORT"] ?? "9091");

/** The issuer identifier this stub trusts, and nothing else. */
const issuer = process.env["STUB_ISSUER"] ?? "http://localhost:8080";

/** Where the trusted anchor publishes its keys. */
const jwksUrl =
  process.env["STUB_JWKS_URL"] ?? `${issuer}/.well-known/jwks.json`;

/** The identifier system this holder resolves a ticket's subject under. */
const ihiSystem =
  process.env["STUB_IHI_SYSTEM"] ??
  "http://ns.electronichealth.net.au/id/hi/ihi/1.0";

/**
 * The ticket types this holder accepts.
 *
 * Empty switches ticket support off altogether: the discovery member disappears and
 * every exchange is refused, which is the state the profile describes for a holder
 * that has not enabled the feature.
 */
const acceptedTypes = (
  process.env["STUB_TICKET_TYPES"] ?? "patient-self-access"
)
  .split(/[\s,]+/)
  .filter((type) => type !== "");

/** The scopes this holder will grant at all, whatever a ticket permits. */
const holderScopes = (
  process.env["STUB_SCOPES"] ??
  "patient/Patient.rs patient/Observation.rs patient/Condition.rs"
)
  .split(/[\s,]+/)
  .filter((scope) => scope !== "");

/**
 * The patients this holder has loaded, by IHI.
 *
 * `ihi=patientId` pairs. The default is the Sparked persona quickstart scenario 7
 * mints for, so the stack demonstrates a resolution rather than a miss.
 */
const patients = new Map<string, string>(
  (process.env["STUB_PATIENTS"] ?? "8003608500314687=charlotte-morris")
    .split(",")
    .map((entry) => entry.split("="))
    .filter((parts): parts is [string, string] => parts.length === 2)
    .map(([ihi, patientId]) => [ihi.trim(), patientId.trim()]),
);

/** How long an access token lives at most, in seconds. */
const maximumTokenLifetimeSeconds = 3600;

/** The grant type the profile presents a ticket under. */
const tokenExchangeGrant = "urn:ietf:params:oauth:grant-type:token-exchange";

/** The token type a ticket is presented as. */
const jwtTokenType = "urn:ietf:params:oauth:token-type:jwt";

/** An access token this stub has issued. */
type IssuedToken = {
  /** the scopes granted */
  readonly scope: string;
  /** the patient the ticket's subject resolved to */
  readonly patientId: string;
  /** when the token stops working, in seconds since the epoch */
  readonly expiresAt: number;
};

/** The tokens this stub has issued, by value. */
const issued = new Map<string, IssuedToken>();

/** OAuth error codes this stub answers with. */
type ExchangeError =
  | "invalid_request"
  | "invalid_client"
  | "invalid_grant"
  | "invalid_scope"
  | "unsupported_grant_type";

/**
 * Answers a refusal in OAuth's shape.
 *
 * @param code - the error code
 * @param description - what went wrong, for whoever is driving the exchange
 * @param status - the status to answer with
 * @returns the response
 */
const refuse = (
  code: ExchangeError,
  description: string,
  status = 400,
): Response =>
  Response.json({ error: code, error_description: description }, { status });

/**
 * Reads a claim set out of a compact JWS without checking anything.
 *
 * @param segment - the payload segment
 * @returns the claims, or undefined when the segment is not JSON
 */
const claimsOf = (segment: string): Record<string, unknown> | undefined => {
  try {
    const parsed: unknown = JSON.parse(
      new TextDecoder().decode(Buffer.from(segment, "base64url")),
    );
    return typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Finds the anchor's key for a `kid`, fetched for this request.
 *
 * Obligation 1, and the reason nothing is cached: a key the anchor has withdrawn
 * must stop verifying, and a cache is how that goes wrong.
 *
 * @param kid - the key identifier from the protected header
 * @returns the imported public key, or undefined when the anchor publishes no such
 *   key
 */
const anchorKey = async (kid: string): Promise<CryptoKey | undefined> => {
  const response = await fetch(jwksUrl);
  if (!response.ok) {
    return undefined;
  }
  const document = (await response.json()) as {
    keys?: { kid?: string; x?: string; y?: string }[];
  };
  const jwk = (document.keys ?? []).find((candidate) => candidate.kid === kid);
  if (jwk?.x === undefined || jwk.y === undefined) {
    return undefined;
  }
  // Only the members that describe the key: WebCrypto refuses an imported JWK
  // that also carries `alg` or `use`.
  return crypto.subtle.importKey(
    "jwk",
    { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
};

/**
 * Verifies a presented ticket and answers its claims.
 *
 * @param ticket - the compact JWS presented as `subject_token`
 * @returns the claims when the signature verifies, or undefined
 */
const verifyTicket = async (
  ticket: string,
): Promise<Record<string, unknown> | undefined> => {
  const [head, payload, signature] = ticket.split(".");
  if (head === undefined || payload === undefined || signature === undefined) {
    return undefined;
  }
  const header = claimsOf(head);
  const kid = header?.["kid"];
  if (header?.["alg"] !== "ES256" || typeof kid !== "string") {
    return undefined;
  }
  const key = await anchorKey(kid);
  if (key === undefined) {
    return undefined;
  }
  const verified = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    Buffer.from(signature, "base64url"),
    new TextEncoder().encode(`${head}.${payload}`),
  );
  return verified ? claimsOf(payload) : undefined;
};

/**
 * Reads the IHI a ticket's subject is bound by.
 *
 * Under this holder's own identifier system and no other: an identifier in a system
 * the holder does not recognise is not a patient it can resolve.
 *
 * @param claims - the verified claims
 * @returns the IHI, or undefined when the subject does not carry one
 */
const subjectIhi = (claims: Record<string, unknown>): string | undefined => {
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
  return system === ihiSystem && typeof value === "string" && value !== ""
    ? value
    : undefined;
};

/**
 * The scopes to grant: what was asked for, what the ticket permits, and what this
 * holder allows.
 *
 * Obligation 4, as an intersection rather than a preference: a holder that granted
 * a scope the ticket did not carry would be ignoring the constraint it was given,
 * and one that granted a scope it does not support would be lying.
 *
 * @param requested - the scopes the client asked for, empty to take the ticket's
 * @param permitted - the scopes the ticket permits
 * @returns the scopes to grant, in the order the ticket states them
 */
const grantedScopes = (
  requested: readonly string[],
  permitted: readonly string[],
): readonly string[] =>
  permitted.filter(
    (scope) =>
      (requested.length === 0 || requested.includes(scope)) &&
      holderScopes.includes(scope),
  );

/**
 * Splits a space-separated scope list.
 *
 * @param value - the list as presented
 * @returns its entries
 */
const scopeList = (value: string | null): readonly string[] =>
  (value ?? "").split(/\s+/).filter((scope) => scope !== "");

/**
 * Exchanges a permission ticket for an access token, per the profile.
 *
 * The obligations in order: validate the artefact, authenticate the presenter,
 * resolve the subject to exactly one patient, intersect the scopes, and cap the
 * token's life at the ticket's remaining validity.
 *
 * @param request - the token request
 * @returns the token response, or the refusal
 */
const exchange = async (request: Request): Promise<Response> => {
  const form = new URLSearchParams(await request.text());
  if (form.get("grant_type") !== tokenExchangeGrant) {
    return refuse(
      "unsupported_grant_type",
      `This endpoint accepts ${tokenExchangeGrant} only.`,
    );
  }
  if (acceptedTypes.length === 0) {
    return refuse(
      "invalid_request",
      "Permission tickets are not enabled at this data holder.",
    );
  }

  // Obligation 2: the presenting client authenticates. A public presenter is
  // refused, because a bearer ticket plus an anonymous caller is a ticket anybody
  // who intercepted it could spend.
  const clientId = form.get("client_id");
  const assertion =
    form.get("client_assertion") ?? form.get("client_secret") ?? null;
  if (clientId === null || clientId === "" || assertion === null) {
    return refuse(
      "invalid_client",
      "The presenting client must authenticate: client_id with client_assertion or client_secret.",
      401,
    );
  }

  if (form.get("subject_token_type") !== jwtTokenType) {
    return refuse(
      "invalid_request",
      `subject_token_type must be ${jwtTokenType}.`,
    );
  }
  const ticket = form.get("subject_token");
  if (ticket === null || ticket === "") {
    return refuse("invalid_request", "subject_token is required.");
  }

  // Obligation 1: signature against the issuer's published keys, issuer match,
  // temporal validity, and the ticket type in this holder's accepted set.
  const claims = await verifyTicket(ticket);
  if (claims === undefined) {
    return refuse(
      "invalid_grant",
      `The ticket's signature did not verify against ${jwksUrl}.`,
    );
  }
  if (claims["iss"] !== issuer) {
    return refuse("invalid_grant", `This holder trusts ${issuer} only.`);
  }
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = claims["exp"];
  const issuedAt = claims["iat"];
  if (typeof expiresAt !== "number" || expiresAt <= now) {
    return refuse("invalid_grant", "The ticket has expired.");
  }
  if (typeof issuedAt === "number" && issuedAt > now + 60) {
    return refuse("invalid_grant", "The ticket is not valid yet.");
  }
  const type = claims["ticket_type"];
  if (typeof type !== "string" || !acceptedTypes.includes(type)) {
    return refuse(
      "invalid_grant",
      `This holder accepts ${acceptedTypes.join(", ")} tickets only.`,
    );
  }

  // Obligation 3: exactly one local patient, or the exchange is refused.
  const ihi = subjectIhi(claims);
  if (ihi === undefined) {
    return refuse(
      "invalid_grant",
      `The ticket's subject carries no identifier under ${ihiSystem}.`,
    );
  }
  const patientId = patients.get(ihi);
  if (patientId === undefined) {
    return refuse(
      "invalid_grant",
      `No patient here carries the IHI ${ihi}, so there is nothing to authorise access to.`,
    );
  }

  // Obligation 4: the intersection, and an empty one is a refusal.
  const permitted = scopeList(
    typeof claims["smart_scopes"] === "string" ? claims["smart_scopes"] : "",
  );
  const requested = scopeList(form.get("scope"));
  const granted = grantedScopes(requested, permitted);
  if (granted.length === 0) {
    return refuse(
      "invalid_scope",
      `Nothing is left after intersecting the request (${requested.join(" ") || "everything the ticket permits"}) ` +
        `with the ticket (${permitted.join(" ") || "nothing"}) and this holder's policy (${holderScopes.join(" ")}).`,
    );
  }

  // Obligation 5: the token cannot outlive the ticket.
  const lifetime = Math.min(maximumTokenLifetimeSeconds, expiresAt - now);
  const accessToken = crypto.randomUUID();
  issued.set(accessToken, {
    scope: granted.join(" "),
    patientId,
    expiresAt: now + lifetime,
  });
  return Response.json({
    access_token: accessToken,
    issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
    token_type: "Bearer",
    expires_in: lifetime,
    scope: granted.join(" "),
    // The SMART patient context: the resolution the holder made, so the caller can
    // see which of its patients the IHI matched.
    patient: patientId,
  });
};

/**
 * Reads a patient with an access token this stub issued.
 *
 * Not part of the profile, and here because a demonstration that stops at the token
 * has not shown that the token is good for anything.
 *
 * @param request - the read request
 * @param patientId - the identifier asked for
 * @returns the patient, or the refusal
 */
const readPatient = (request: Request, patientId: string): Response => {
  const presented = (request.headers.get("authorization") ?? "").replace(
    /^Bearer\s+/i,
    "",
  );
  const token = issued.get(presented);
  if (token === undefined) {
    return refuse(
      "invalid_grant",
      "That access token is not one of ours.",
      401,
    );
  }
  if (token.expiresAt <= Math.floor(Date.now() / 1000)) {
    return refuse("invalid_grant", "That access token has expired.", 401);
  }
  if (!scopeList(token.scope).includes("patient/Patient.rs")) {
    return refuse(
      "invalid_scope",
      "That token does not carry patient/Patient.rs.",
      403,
    );
  }
  if (token.patientId !== patientId) {
    return refuse(
      "invalid_grant",
      `That token authorises ${token.patientId}, not ${patientId}.`,
      403,
    );
  }
  const ihi = [...patients.entries()].find(
    ([, held]) => held === patientId,
  )?.[0];
  return Response.json({
    resourceType: "Patient",
    id: patientId,
    identifier: [{ system: ihiSystem, value: ihi }],
    active: true,
  });
};

/** Where TLS material lives, when the stack provides it. */
const tlsFiles = {
  cert: process.env["STUB_TLS_CERT"],
  key: process.env["STUB_TLS_KEY"],
};

const server = Bun.serve({
  port,
  ...(tlsFiles.cert === undefined || tlsFiles.key === undefined
    ? {}
    : { tls: { cert: Bun.file(tlsFiles.cert), key: Bun.file(tlsFiles.key) } }),
  fetch: (request) => {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/healthz") {
      return Response.json({
        status: "ok",
        issuer,
        jwks: jwksUrl,
        ticketTypes: acceptedTypes,
        scopes: holderScopes,
        patients: [...patients.entries()].map(([ihi, id]) => ({ ihi, id })),
        tokens: issued.size,
      });
    }

    // Obligation 6: the accepted types are advertised, and only while they are
    // accepted - which is what Muster's verification checks read.
    //
    // Published under the FHIR base as well as at the origin, because SMART puts
    // the document at `[fhir base]/.well-known/smart-configuration` and that is
    // where a checker that has been given a base URL will look.
    if (
      request.method === "GET" &&
      (url.pathname === "/.well-known/smart-configuration" ||
        url.pathname === "/fhir/.well-known/smart-configuration")
    ) {
      return Response.json({
        issuer: url.origin,
        authorization_endpoint: `${url.origin}/authorize`,
        token_endpoint: `${url.origin}/token`,
        grant_types_supported: ["authorization_code", tokenExchangeGrant],
        scopes_supported: holderScopes,
        capabilities: ["launch-standalone", "permission-v1"],
        ...(acceptedTypes.length === 0
          ? {}
          : { smart_permission_ticket_types_supported: acceptedTypes }),
      });
    }

    if (request.method === "POST" && url.pathname === "/token") {
      return exchange(request);
    }

    // A search needs authorization, like every read here. Muster's coverage grid
    // reads that refusal as `unverifiable` rather than as "holds no such
    // patient", which is the distinction FR-032 turns on: a server that would
    // not answer has not said anything about what it holds.
    if (request.method === "GET" && url.pathname === "/fhir/Patient") {
      return refuse(
        "invalid_client",
        "This holder requires authorization to search for patients.",
        401,
      );
    }

    const read = /^\/fhir\/Patient\/([\w-]+)$/.exec(url.pathname);
    if (request.method === "GET" && read !== null) {
      return readPatient(request, read[1] ?? "");
    }

    return refuse("invalid_request", "No such endpoint.", 404);
  },
});

console.log(
  `Stub data holder listening on ${server.url.toString()}, ` +
    `trusting ${issuer} with keys from ${jwksUrl}. ` +
    `Accepting ${acceptedTypes.join(", ") || "no"} tickets for ${String(patients.size)} patient(s), ` +
    `granting within ${holderScopes.join(" ")}.`,
);
