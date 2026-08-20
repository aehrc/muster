#!/usr/bin/env bun
/*
 * Copyright © 2026 Commonwealth Scientific and Industrial Research Organisation
 * (CSIRO) ABN 41 687 119 230. Licensed under the Apache License, Version 2.0.
 */

/**
 * A reference registration endpoint for the local stack.
 *
 * It implements the trusted dynamic client registration profile Muster publishes
 * at `/docs/registration-profile`, so the whole of User Story 5 - and the
 * conformance harness of User Story 6 - is provable without any vendor's server.
 * It is the profile's own worked example, executable.
 *
 * Two design choices are deliberate. It has no dependencies at all: the ES256
 * signature is verified with WebCrypto, so the container is a bare Bun image with
 * one file mounted into it. And its broken behaviours are selected by path rather
 * than by configuration - `POST /modes/skipSignature/register` skips signature
 * validation while `POST /register` does not - so one instance serves every case
 * the harness needs, with no control plane and no state to reset between runs.
 *
 * Nothing here is Muster's code path: it is a participant's server, written to the
 * contract, and the only thing it shares with Muster is the document.
 *
 * Usage: `bun deploy/stubs/registerServer.ts`, with
 * `STUB_ISSUER` (the anchor's issuer identifier), `STUB_JWKS_URL` (where its keys
 * are published), `STUB_PORT` and optionally `STUB_MODE`.
 *
 * `STUB_TLS_CERT` and `STUB_TLS_KEY`, when both are given, serve over TLS. A
 * Muster entry's registration endpoint must be an https URL, as a participant's
 * really is, so anything driving a registration run against this stub needs them
 * - with a self-signed pair, the caller must also be willing to accept it.
 *
 * @author John Grimes
 */

/** How this stub may misbehave, for the harness to catch. */
type StubMode =
  /** the profile, implemented properly */
  | "strict"
  /** accepts any signature: the tampered-statement check must fail */
  | "skipSignature"
  /** accepts an expired statement: the expiry check must fail */
  | "ignoreExpiry"
  /** accepts a replayed statement identifier: the replay check must fail */
  | "allowReplay"
  /** answers with an identifier and no metadata: fidelity cannot be shown */
  | "bareResponse"
  /** honours metadata asserted outside the statement: statement-only fails */
  | "trustBody"
  /** answers every refusal as `invalid_request`: an advisory, not a failure */
  | "vagueErrors"
  /** returns no management credentials: the harness reports a client left behind */
  | "noCleanup";

/** Every mode, so an unknown one is refused rather than assumed to be strict. */
const modes: readonly StubMode[] = [
  "strict",
  "skipSignature",
  "ignoreExpiry",
  "allowReplay",
  "bareResponse",
  "trustBody",
  "vagueErrors",
  "noCleanup",
];

/** A registered client, as this stub holds it. */
type RegisteredClient = {
  /** the identifier issued */
  readonly clientId: string;
  /** the secret issued, when the client is confidential */
  readonly clientSecret: string | undefined;
  /** the token that authorises managing it (RFC 7592) */
  readonly accessToken: string;
  /** the metadata registered, from the statement */
  readonly metadata: Record<string, unknown>;
};

/** The error vocabulary the profile states. */
type RegistrationErrorCode =
  "invalid_software_statement" | "invalid_client_metadata" | "invalid_request";

/** Where this stub listens. */
const port = Number(process.env["STUB_PORT"] ?? "9090");

/** The issuer identifier this stub trusts, and nothing else. */
const issuer = process.env["STUB_ISSUER"] ?? "http://localhost:8080";

/** Where the trusted anchor publishes its keys. */
const jwksUrl =
  process.env["STUB_JWKS_URL"] ?? `${issuer}/.well-known/jwks.json`;

/** The mode used when a request does not name one. */
const defaultMode: StubMode = ((): StubMode => {
  const named = process.env["STUB_MODE"] ?? "strict";
  const found = modes.find((mode) => mode === named);
  if (found === undefined) {
    throw new Error(
      `STUB_MODE ${named} is not one of ${modes.join(", ")}; refusing to start.`,
    );
  }
  return found;
})();

/** The clients this stub has registered, by identifier. */
const clients = new Map<string, RegisteredClient>();

/** The statement identifiers already spent, per the profile's single use. */
const spentStatements = new Set<string>();

/**
 * Decodes one base64url segment as UTF-8 text.
 *
 * @param segment - the segment to decode
 * @returns its text
 */
const decodeSegment = (segment: string): string =>
  new TextDecoder().decode(Buffer.from(segment, "base64url"));

/**
 * Verifies an ES256 compact JWS against a published key set.
 *
 * The key is looked up by `kid` in a key set fetched for this request, which is
 * the profile's first rule: a withdrawn key must stop verifying, and a cache is
 * how that goes wrong.
 *
 * @param jws - the compact JWS presented
 * @returns the claims when the signature verifies, or undefined
 */
const verifyStatement = async (
  jws: string,
): Promise<Record<string, unknown> | undefined> => {
  const [protectedHeader, payload, signature] = jws.split(".");
  if (
    protectedHeader === undefined ||
    payload === undefined ||
    signature === undefined
  ) {
    return undefined;
  }

  let header: { kid?: string; alg?: string };
  try {
    header = JSON.parse(decodeSegment(protectedHeader)) as typeof header;
  } catch {
    return undefined;
  }
  if (header.alg !== "ES256" || header.kid === undefined) {
    return undefined;
  }

  const response = await fetch(jwksUrl);
  if (!response.ok) {
    return undefined;
  }
  const jwks = (await response.json()) as {
    keys?: {
      kid?: string;
      kty?: string;
      crv?: string;
      x?: string;
      y?: string;
    }[];
  };
  const jwk = (jwks.keys ?? []).find(
    (candidate) => candidate.kid === header.kid,
  );
  if (jwk?.x === undefined || jwk.y === undefined) {
    return undefined;
  }

  // Only the four members that describe the key: an imported JWK carrying `alg`
  // or `use` is refused by WebCrypto.
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const verified = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    Buffer.from(signature, "base64url"),
    new TextEncoder().encode(`${protectedHeader}.${payload}`),
  );
  if (!verified) {
    return undefined;
  }
  try {
    return JSON.parse(decodeSegment(payload)) as Record<string, unknown>;
  } catch {
    return undefined;
  }
};

/**
 * Reads the claims of a statement without verifying it.
 *
 * Only the `skipSignature` mode uses this, which is the whole point of that mode:
 * a server that reads a statement it has not verified is trusting a stranger.
 *
 * @param jws - the compact JWS presented
 * @returns the claims, or undefined when it is not a JWS at all
 */
const claimsWithoutVerifying = (
  jws: string,
): Record<string, unknown> | undefined => {
  const payload = jws.split(".")[1];
  if (payload === undefined) {
    return undefined;
  }
  try {
    return JSON.parse(decodeSegment(payload)) as Record<string, unknown>;
  } catch {
    return undefined;
  }
};

/**
 * Answers a refusal in RFC 7591's shape.
 *
 * @param mode - the mode this request is being served in
 * @param code - the error the profile states for this failure
 * @param description - what went wrong, for a human reading the harness report
 * @returns the response
 */
const refuse = (
  mode: StubMode,
  code: RegistrationErrorCode,
  description: string,
): Response =>
  Response.json(
    {
      error: mode === "vagueErrors" ? "invalid_request" : code,
      error_description: description,
    },
    { status: 400 },
  );

/**
 * Reads a string claim.
 *
 * @param claims - the claim set
 * @param name - the claim to read
 * @returns the value when it is a non-empty string
 */
const stringClaim = (
  claims: Record<string, unknown>,
  name: string,
): string | undefined => {
  const value = claims[name];
  return typeof value === "string" && value !== "" ? value : undefined;
};

/**
 * Reads a numeric claim.
 *
 * @param claims - the claim set
 * @param name - the claim to read
 * @returns the value when it is a number
 */
const numberClaim = (
  claims: Record<string, unknown>,
  name: string,
): number | undefined => {
  const value = claims[name];
  return typeof value === "number" ? value : undefined;
};

/**
 * Reads the redirect URIs.
 *
 * @param claims - the claim set
 * @returns the URIs, or undefined when the claim is not a list of strings
 */
const redirectUris = (
  claims: Record<string, unknown>,
): string[] | undefined => {
  const value = claims["redirect_uris"];
  return Array.isArray(value) &&
    value.every((entry) => typeof entry === "string")
    ? value
    : undefined;
};

/**
 * The metadata this stub registers, taken from the statement.
 *
 * @param claims - the verified claim set
 * @returns the client metadata
 */
const metadataFrom = (
  claims: Record<string, unknown>,
): Record<string, unknown> => ({
  client_name: claims["client_name"],
  redirect_uris: claims["redirect_uris"],
  grant_types: claims["grant_types"],
  token_endpoint_auth_method: claims["token_endpoint_auth_method"],
  scope: claims["scope"],
  smart_launch_url: claims["smart_launch_url"],
});

/**
 * Validates the metadata this server is being asked to register.
 *
 * The profile is explicit that vouching attests origin rather than validity, so a
 * server applies its own rules. These are the rules a SMART authorization server
 * would actually have: a name, at least one redirect URI, and no plaintext
 * redirect outside loopback.
 *
 * @param claims - the verified claim set
 * @returns the reason it fails, or undefined when it passes
 */
const metadataProblem = (
  claims: Record<string, unknown>,
): string | undefined => {
  if (stringClaim(claims, "client_name") === undefined) {
    return "client_name is required.";
  }
  const uris = redirectUris(claims);
  if (uris === undefined || uris.length === 0) {
    return "redirect_uris must name at least one URI.";
  }
  for (const uri of uris) {
    let parsed: URL;
    try {
      parsed = new URL(uri);
    } catch {
      return `redirect_uri ${uri} is not a URL.`;
    }
    const loopback =
      parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
    if (parsed.protocol !== "https:" && !loopback) {
      return `redirect_uri ${uri} must use https outside loopback.`;
    }
  }
  return undefined;
};

/**
 * Registers a client from a statement, per the profile.
 *
 * @param request - the registration request
 * @param mode - the mode to serve it in
 * @returns the response, per RFC 7591
 */
const register = async (
  request: Request,
  mode: StubMode,
): Promise<Response> => {
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await request.json();
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new Error("not an object");
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return refuse(mode, "invalid_request", "The body must be a JSON object.");
  }

  const jws = body["software_statement"];
  if (typeof jws !== "string" || jws === "") {
    return refuse(
      mode,
      "invalid_request",
      "software_statement is required: this server registers nothing it has not been vouched for.",
    );
  }

  // Statement-only. The profile permits ignoring outside metadata or rejecting it;
  // this server rejects, because a request that carries two sources of truth was
  // built against a different contract.
  const outside = Object.keys(body).filter(
    (name) => name !== "software_statement",
  );
  if (outside.length > 0 && mode !== "trustBody") {
    return refuse(
      mode,
      "invalid_request",
      `Metadata must live inside the statement; this request also asserted ${outside.join(", ")}.`,
    );
  }

  const claims =
    mode === "skipSignature"
      ? claimsWithoutVerifying(jws)
      : await verifyStatement(jws);
  if (claims === undefined) {
    return refuse(
      mode,
      "invalid_software_statement",
      "The statement's signature did not verify against the anchor's published keys.",
    );
  }

  if (stringClaim(claims, "iss") !== issuer) {
    return refuse(
      mode,
      "invalid_software_statement",
      `This server trusts statements from ${issuer} only.`,
    );
  }

  const now = Math.floor(Date.now() / 1000);
  const issuedAt = numberClaim(claims, "iat");
  const expiresAt = numberClaim(claims, "exp");
  if (mode !== "ignoreExpiry") {
    if (expiresAt === undefined || expiresAt <= now) {
      return refuse(
        mode,
        "invalid_software_statement",
        "The statement has expired.",
      );
    }
    if (issuedAt !== undefined && issuedAt > now + 60) {
      return refuse(
        mode,
        "invalid_software_statement",
        "The statement is not yet valid.",
      );
    }
  }

  const jti = stringClaim(claims, "jti");
  if (jti === undefined) {
    return refuse(
      mode,
      "invalid_software_statement",
      "The statement carries no jti, so it cannot be spent once.",
    );
  }
  if (mode !== "allowReplay") {
    if (spentStatements.has(jti)) {
      return refuse(
        mode,
        "invalid_software_statement",
        "That statement has already been used to register a client.",
      );
    }
    spentStatements.add(jti);
  }

  const problem = metadataProblem(
    mode === "trustBody" ? { ...claims, ...body } : claims,
  );
  if (problem !== undefined) {
    return refuse(mode, "invalid_client_metadata", problem);
  }

  const metadata =
    mode === "trustBody"
      ? { ...metadataFrom(claims), ...body, software_statement: undefined }
      : metadataFrom(claims);
  const clientId = `stub-${crypto.randomUUID().slice(0, 8)}`;
  const confidential =
    stringClaim(claims, "token_endpoint_auth_method") !== "none";
  const client: RegisteredClient = {
    clientId,
    clientSecret: confidential ? crypto.randomUUID() : undefined,
    accessToken: crypto.randomUUID(),
    metadata,
  };
  clients.set(clientId, client);
  console.log(
    `[${mode}] registered ${clientId} from statement ${jti}, valid to ${String(expiresAt)}`,
  );

  if (mode === "bareResponse") {
    // Deliberately short of RFC 7591 section 3.2.1: no metadata, so fidelity
    // cannot be shown.
    return Response.json({ client_id: clientId }, { status: 201 });
  }

  // RFC 7592's management address is this server's own, derived from the address
  // the request arrived at: it is where the client lives, not where the anchor
  // does, and a harness cleaning up follows it only on the origin it registered
  // at.
  const managed =
    mode === "noCleanup"
      ? {}
      : {
          registration_client_uri: new URL(
            `/register/${clientId}`,
            request.url,
          ).toString(),
          registration_access_token: client.accessToken,
        };
  return Response.json(
    {
      client_id: clientId,
      ...(client.clientSecret === undefined
        ? {}
        : {
            client_secret: client.clientSecret,
            client_secret_expires_at: expiresAt ?? 0,
          }),
      client_id_issued_at: now,
      ...metadata,
      ...managed,
    },
    { status: 201 },
  );
};

/**
 * Deletes a registered client (RFC 7592), which is how the harness cleans up.
 *
 * @param request - the deletion request, carrying the registration access token
 * @param clientId - the client to delete
 * @returns the response
 */
const deleteClient = (request: Request, clientId: string): Response => {
  const client = clients.get(clientId);
  if (client === undefined) {
    return Response.json({ error: "invalid_client_id" }, { status: 404 });
  }
  const presented = (request.headers.get("authorization") ?? "").replace(
    /^Bearer\s+/i,
    "",
  );
  if (presented !== client.accessToken) {
    return Response.json({ error: "invalid_token" }, { status: 401 });
  }
  clients.delete(clientId);
  console.log(`deleted ${clientId}`);
  return new Response(null, { status: 204 });
};

/**
 * Reads the mode a path names, if it names one.
 *
 * @param segments - the path's segments
 * @returns the mode and the remaining path, or undefined when the path is invalid
 */
const routeFor = (
  segments: readonly string[],
):
  { readonly mode: StubMode; readonly rest: readonly string[] } | undefined => {
  if (segments[0] !== "modes") {
    return { mode: defaultMode, rest: segments };
  }
  const named = modes.find((mode) => mode === segments[1]);
  return named === undefined
    ? undefined
    : { mode: named, rest: segments.slice(2) };
};

/**
 * The certificate and key this stub serves TLS with, when it is given both.
 *
 * A participant's registration endpoint is an https URL, which Muster's contract
 * requires, so a stub standing in for one needs a certificate. Without both
 * variables it serves plain http, which is enough for a health check and for
 * reading what it has registered.
 */
const tlsFiles = (():
  { readonly cert: string; readonly key: string } | undefined => {
  const cert = process.env["STUB_TLS_CERT"];
  const key = process.env["STUB_TLS_KEY"];
  return cert === undefined || key === undefined ? undefined : { cert, key };
})();

const server = Bun.serve({
  port,
  ...(tlsFiles === undefined
    ? {}
    : { tls: { cert: Bun.file(tlsFiles.cert), key: Bun.file(tlsFiles.key) } }),
  fetch: async (request) => {
    const url = new URL(request.url);
    const segments = url.pathname.split("/").filter((part) => part !== "");

    if (request.method === "GET" && url.pathname === "/healthz") {
      return Response.json({
        status: "ok",
        mode: defaultMode,
        issuer,
        jwks: jwksUrl,
        modes,
        clients: clients.size,
      });
    }

    const route = routeFor(segments);
    if (route === undefined) {
      return Response.json(
        { error: "invalid_request", error_description: "No such mode." },
        { status: 404 },
      );
    }

    // The clients this stub is holding, for a demonstration to point at. No
    // secrets: a secret is returned once, at registration, and never again.
    if (request.method === "GET" && route.rest[0] === "clients") {
      return Response.json({
        clients: [...clients.values()].map((client) => ({
          client_id: client.clientId,
          ...client.metadata,
        })),
      });
    }

    if (route.rest[0] !== "register") {
      return Response.json(
        { error: "invalid_request", error_description: "No such endpoint." },
        { status: 404 },
      );
    }
    if (request.method === "POST" && route.rest.length === 1) {
      return register(request, route.mode);
    }
    if (request.method === "DELETE" && route.rest.length === 2) {
      return deleteClient(request, route.rest[1] ?? "");
    }
    return Response.json(
      { error: "invalid_request", error_description: "No such endpoint." },
      { status: 405 },
    );
  },
});

console.log(
  `Stub registration server listening on ${server.url.toString()}, ` +
    `trusting ${issuer} with keys from ${jwksUrl}, default mode ${defaultMode}. ` +
    `Any mode is reachable as /modes/{mode}/register.`,
);
