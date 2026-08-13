/**
 * The only way Muster makes an outbound HTTP request.
 *
 * Almost every address Muster fetches was typed by a participant: a system's FHIR
 * base URL, a registration endpoint, an event's persona source. Fetching one is a
 * server-side request to an address somebody else chose, and Muster runs inside a
 * cluster beside services that answer anything that asks them - including, in a cloud
 * deployment, a metadata endpoint that hands out credentials. Nothing else in this
 * codebase may call `fetch` with a participant-supplied URL (constitution principle
 * III, FR-020).
 *
 * The guard has five parts, and all five matter:
 *
 * 1. **Scheme.** `https` only, unless the host is named in the allowlist. `file:`,
 *    `gopher:` and the rest are refused by the same check.
 * 2. **No userinfo.** `https://metadata@attacker.example/` and its inverse are the
 *    standard way to make a URL's apparent host differ from its real one. Refused
 *    even for an allowlisted host.
 * 3. **Address.** The hostname is resolved and *every* address it resolves to must be
 *    publicly routable. Checking the name is useless - `localtest.me` resolves to
 *    `127.0.0.1` - and checking only the first address lets a name with two A records
 *    slip a private one past.
 * 4. **Redirects, re-checked.** A redirect is a URL the guard never saw, so each hop
 *    goes through parts 1 to 3 again before it is followed. A request carrying a body
 *    is never redirected at all: a registration endpoint has no legitimate reason to
 *    redirect, and replaying a software statement at an address the participant did
 *    not declare is not a thing to do accidentally.
 * 5. **Limits.** A timeout per hop and a cap on the response body, so a slow or
 *    endlessly streaming host cannot hold a scheduler thread or exhaust memory.
 *
 * **What is not a refusal.** An HTTP error status arrives as a response. The
 * conformance harness's job is to assert that a server answered 400 to a tampered
 * statement, and the DCR run has to record the server's own error against the pairing,
 * so a status is data rather than a failure of the guard.
 *
 * **The allowlist.** Empty unless `MUSTER_OUTBOUND_ALLOWED_HOSTS` names something,
 * because a control that could be turned off by omitting a variable would not be one.
 * An entry is a `host` or a `host:port`; a port, when given, is part of the match, so
 * exempting a stub does not exempt everything else on the same machine. For
 * development and connectathon stacks, never for production.
 *
 * **The residual risk.** Between resolving a name and connecting, the DNS answer can
 * change - DNS rebinding. Closing that window means pinning the connection to the
 * address that was checked, which means replacing the socket factory rather than using
 * `fetch`. Muster accepts the window: the bodies fetched here are displayed as
 * evidence rather than trusted, the attacker must already own a directory entry, and a
 * deployment needing the stronger guarantee should place an egress proxy in front of
 * Muster, which is the control that actually holds.
 *
 * Author: John Grimes
 */

import { lookup } from "node:dns/promises";

import { isFetchableAddress } from "./addresses.js";

/** Why an outbound request was refused. */
export type OutboundRefusal =
  | "not-a-url"
  | "insecure-scheme"
  | "userinfo"
  /** A literal, or a resolved address, outside the publicly routable ranges. */
  | "blocked-address"
  | "unresolvable"
  /** A redirect on a request that may not be redirected. */
  | "redirect-not-followed"
  | "too-many-redirects"
  /** The host did not answer in time - distinct from refusing the connection. */
  | "timeout"
  | "refused"
  | "too-large";

/** A refusal: the reason to classify by, and a description to record. */
export interface OutboundRefused {
  readonly ok: false;
  readonly reason: OutboundRefusal;
  readonly description: string;
}

/** The outcome of checking a URL before it is fetched. */
export type OutboundUrlCheck =
  { readonly ok: true; readonly url: URL } | OutboundRefused;

/** What came back from the far end. */
export interface OutboundResponse {
  /** The URL actually fetched, which differs from the request's after a redirect. */
  readonly url: string;
  readonly status: number;
  /** Response headers, lower-cased. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/** The outcome of a guarded fetch. */
export type OutboundResult =
  { readonly ok: true; readonly value: OutboundResponse } | OutboundRefused;

/** Resolves a hostname to every address it names. Injected so tests need no DNS. */
export type AddressResolver = (hostname: string) => Promise<readonly string[]>;

/**
 * The transport.
 *
 * Declared as the one call this module makes rather than as `typeof fetch`: the global
 * carries runtime-specific extras - `preconnect` under Bun's types, absent under
 * Node's - and a stub would have to grow them for no reason but to satisfy a
 * signature.
 */
export type OutboundFetchImpl = (
  input: URL,
  init: RequestInit,
) => Promise<Response>;

/** How a guarded fetch should behave. */
export interface OutboundFetchOptions {
  readonly method?: "GET" | "POST";
  /** Extra request headers. No credential is ever sent through this module. */
  readonly headers?: Readonly<Record<string, string>>;
  /** A request body. Its presence also means redirects will not be followed. */
  readonly body?: string;
  /**
   * Hosts exempt from the scheme and address checks, as `host` or `host:port`.
   *
   * Comes from configuration, which defaults it to empty.
   */
  readonly allowedHosts?: readonly string[];
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  readonly maxRedirects?: number;
  readonly resolve?: AddressResolver;
  readonly fetchImpl?: OutboundFetchImpl;
}

/** Ten seconds: long enough for a slow FHIR server, short enough not to pile up. */
export const DEFAULT_OUTBOUND_TIMEOUT_MS = 10_000;

/**
 * 1 MiB.
 *
 * A CapabilityStatement is the largest thing fetched here and a verbose one runs to a
 * few hundred kilobytes. The limit exists so a hostile host cannot exhaust memory by
 * streaming indefinitely.
 */
export const DEFAULT_OUTBOUND_MAX_BYTES = 1_048_576;

/** Three hops: enough for a trailing-slash redirect and a canonical host change. */
export const DEFAULT_MAX_REDIRECTS = 3;

/** The statuses that carry a `location` worth following. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Builds a refusal. */
function refuse(reason: OutboundRefusal, description: string): OutboundRefused {
  return { ok: false, reason, description };
}

/**
 * Whether a URL's host is exempt from the scheme and address checks.
 *
 * Both spellings match: an entry may name the host with its port (`stub:8080`), which
 * is how a compose stack names a service, or the hostname alone (`localhost`). An
 * entry with a port matches only that port.
 */
function isAllowedHost(url: URL, allowedHosts: readonly string[]): boolean {
  if (allowedHosts.length === 0) {
    return false;
  }
  const host = url.host.toLowerCase();
  const hostname = url.hostname.toLowerCase();
  return allowedHosts.some((entry) => entry === host || entry === hostname);
}

/**
 * Checks a URL's syntax and, when its host is an IP literal, its address.
 *
 * Pure. A hostname that is not a literal passes this check and is judged again after
 * resolution by {@link outboundFetch}.
 *
 * @param raw - The participant-supplied URL.
 * @param allowedHosts - Hosts exempt from the scheme and address checks.
 * @returns The parsed URL, or why it was refused.
 * @example
 * ```ts
 * const check = checkOutboundUrl(system.fhirBaseUrl, config.outboundAllowedHosts);
 * ```
 */
export function checkOutboundUrl(
  raw: string,
  allowedHosts: readonly string[] = [],
): OutboundUrlCheck {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return refuse("not-a-url", `"${raw}" is not an absolute URL`);
  }

  const allowed = isAllowedHost(url, allowedHosts);

  // The scheme is judged before the host, so that a `file:` URL - which has no host at
  // all - is refused for the reason a reader needs rather than as a malformed one.
  if (url.protocol !== "https:" && !(allowed && url.protocol === "http:")) {
    return refuse(
      "insecure-scheme",
      `Only https URLs may be fetched, not ${url.protocol} (${url.host})`,
    );
  }

  if (url.hostname.length === 0) {
    return refuse("not-a-url", `"${raw}" has no host`);
  }

  // Checked even for an allowlisted host: userinfo is about the URL misleading a
  // reader, not about where it points.
  if (url.username.length > 0 || url.password.length > 0) {
    return refuse("userinfo", "A fetched URL may not carry userinfo");
  }

  // An IP literal can be judged now. A DNS name cannot, and `isFetchableAddress`
  // returns false for anything unparseable, so it cannot be used here to reject names.
  const classification = classifyLiteralHost(url.hostname);
  if (!allowed && classification === "guarded") {
    return refuse(
      "blocked-address",
      `${url.hostname} is not a publicly routable address`,
    );
  }

  return { ok: true, url };
}

/** Whether a host is an IP literal, and if so whether it may be fetched. */
function classifyLiteralHost(hostname: string): "name" | "public" | "guarded" {
  const isLiteral = /^[\d.]+$/.test(hostname) || hostname.startsWith("[");
  if (!isLiteral) {
    return "name";
  }
  return isFetchableAddress(hostname) ? "public" : "guarded";
}

/** Resolves a hostname to every address, via the system resolver. */
async function systemResolve(hostname: string): Promise<readonly string[]> {
  const results = await lookup(hostname, { all: true, verbatim: true });
  return results.map((result) => result.address);
}

/**
 * Checks every address a hostname resolves to.
 *
 * Skipped for an IP literal, which {@link checkOutboundUrl} has already judged, and
 * for an allowlisted host, which is the point of the allowlist.
 */
async function checkResolvedAddresses(
  url: URL,
  resolve: AddressResolver,
): Promise<OutboundRefused | undefined> {
  if (classifyLiteralHost(url.hostname) !== "name") {
    return undefined;
  }

  let addresses: readonly string[];
  try {
    addresses = await resolve(url.hostname);
  } catch {
    return refuse("unresolvable", `${url.hostname} could not be resolved`);
  }
  if (addresses.length === 0) {
    return refuse("unresolvable", `${url.hostname} resolved to no addresses`);
  }

  const blocked = addresses.find((address) => !isFetchableAddress(address));
  return blocked === undefined
    ? undefined
    : refuse(
        "blocked-address",
        `${url.hostname} resolves to ${blocked}, which is not publicly routable`,
      );
}

/**
 * Reads a response body, refusing one that exceeds the byte limit.
 *
 * Streamed rather than buffered through `response.text()`, so an oversized body is
 * abandoned partway rather than read in full and then rejected. `Content-Length` is
 * not consulted: it is advisory, and a hostile host simply omits it.
 */
async function readBounded(
  response: Response,
  maxBytes: number,
): Promise<string | undefined> {
  const body = response.body;
  if (body === null) {
    return "";
  }

  // Annotated because the DOM lib types `getReader()` loosely enough that `value`
  // arrives as `any`, and the path that reads a remote response should not have one.
  const reader: ReadableStreamDefaultReader<Uint8Array> = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.length;
      if (total > maxBytes) {
        return undefined;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** Response headers as a plain lower-cased record, for storage and display. */
function headersOf(response: Response): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of response.headers.entries()) {
    headers[name.toLowerCase()] = value;
  }
  return headers;
}

/**
 * Distinguishes a timeout from a connection failure.
 *
 * The event view says which it was, because a slow server and a dead one are different
 * problems for its owner to fix (spec edge case: "a live check hits a server that is
 * slow rather than down").
 */
function classifyFetchError(error: unknown, url: URL): OutboundRefused {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);
  if (name === "TimeoutError" || name === "AbortError") {
    return refuse("timeout", `${url.href} did not answer in time`);
  }
  return refuse("refused", `${url.href} could not be reached: ${message}`);
}

/** One hop: the guarded request, without redirect handling. */
async function fetchOnce(
  url: URL,
  options: OutboundFetchOptions,
): Promise<OutboundResult> {
  const doFetch = options.fetchImpl ?? fetch;
  const maxBytes = options.maxBytes ?? DEFAULT_OUTBOUND_MAX_BYTES;

  let response: Response;
  try {
    response = await doFetch(url, {
      method: options.method ?? "GET",
      headers: { accept: "application/json", ...options.headers },
      ...(options.body === undefined ? {} : { body: options.body }),
      // Handled here instead, so each hop is checked before it is taken.
      redirect: "manual",
      signal: AbortSignal.timeout(
        options.timeoutMs ?? DEFAULT_OUTBOUND_TIMEOUT_MS,
      ),
    });
  } catch (error) {
    return classifyFetchError(error, url);
  }

  const body = await readBounded(response, maxBytes);
  if (body === undefined) {
    return refuse(
      "too-large",
      `${url.href} returned more than ${String(maxBytes)} bytes`,
    );
  }

  return {
    ok: true,
    value: {
      url: url.href,
      status: response.status,
      headers: headersOf(response),
      body,
    },
  };
}

/**
 * Fetches a participant-supplied URL through every check in the module header.
 *
 * @param raw - The URL, as a participant entered it.
 * @param options - The request, the limits, the allowlist, and the injection points
 *   the tests use.
 * @returns The response - whatever its status - or why the request was refused. Never
 *   throws for a network or content failure: each of those is a value a check result
 *   or a harness run has to record.
 * @example
 * ```ts
 * const result = await outboundFetch(`${baseUrl}/.well-known/smart-configuration`, {
 *   allowedHosts: config.outboundAllowedHosts,
 * });
 * if (!result.ok) {
 *   await recordUnreachable(enrolment, result.reason, result.description);
 * }
 * ```
 */
export async function outboundFetch(
  raw: string,
  options: OutboundFetchOptions = {},
): Promise<OutboundResult> {
  const allowedHosts = options.allowedHosts ?? [];
  const resolve = options.resolve ?? systemResolve;
  const budget = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;

  let target = raw;
  // One more attempt than the redirect budget: the budget counts hops taken, not
  // requests made.
  for (let hop = 0; hop <= budget; hop += 1) {
    const check = checkOutboundUrl(target, allowedHosts);
    if (!check.ok) {
      return hop === 0
        ? check
        : refuse(
            check.reason,
            `${raw} redirected to ${target}, which was refused: ${check.description}`,
          );
    }

    if (!isAllowedHost(check.url, allowedHosts)) {
      const blocked = await checkResolvedAddresses(check.url, resolve);
      if (blocked !== undefined) {
        return hop === 0
          ? blocked
          : refuse(
              blocked.reason,
              `${raw} redirected to ${target}, which was refused: ${blocked.description}`,
            );
      }
    }

    const result = await fetchOnce(check.url, options);
    if (!result.ok) {
      return result;
    }

    const location = result.value.headers["location"];
    if (
      !REDIRECT_STATUSES.has(result.value.status) ||
      location === undefined ||
      location.length === 0
    ) {
      // Not a redirect, or a redirect with nowhere to go: the response as it stands is
      // the answer, and a caller inspecting the status can say so.
      return result;
    }

    // A body means a request that must not be replayed elsewhere.
    if (options.body !== undefined) {
      return refuse(
        "redirect-not-followed",
        `${check.url.href} redirected to ${location}; a request with a body is not redirected`,
      );
    }

    target = new URL(location, check.url).href;
  }

  return refuse(
    "too-many-redirects",
    `${raw} redirected more than ${String(budget)} times`,
  );
}
