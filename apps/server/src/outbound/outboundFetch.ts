/* eslint-disable no-restricted-globals -- this module is the only permitted caller of fetch */
import { lookup } from "node:dns/promises";

/**
 * The SSRF-guarded outbound fetch: the only code path in Muster that may reach
 * the network.
 *
 * Muster's whole job is fetching addresses that strangers typed in, so the
 * guard is the security boundary that matters most. It refuses private,
 * loopback, link-local and cloud-metadata ranges, applies a deadline to the
 * whole exchange, and re-applies itself to the target of every redirect. A
 * guarded target is reported as a refusal with its reason - never skipped
 * silently, and never attempted "just to see".
 *
 * Refusals are returned rather than thrown, and their `failureMode` values are
 * the ones `checkResult.failureMode` records, so a caller can persist the
 * outcome without translating it.
 *
 * Known limitation: the address is checked before the request and the request
 * is then made by host name, so a name that resolves differently between the
 * two (DNS rebinding) is not caught. Closing that needs connecting by address
 * with an overridden Host header, which breaks TLS server-name matching; the
 * cost is not worth paying at connectathon scale.
 *
 * @author John Grimes
 */

/** How an outbound request failed. */
export type OutboundFailureMode = "guarded" | "timeout" | "refused" | "invalid";

/** Why an outbound request was refused. */
export type OutboundRefusal = {
  /** the classification, matching `checkResult.failureMode` */
  readonly failureMode: OutboundFailureMode;
  /** the reason, fit to show the member who asked */
  readonly detail: string;
};

/** The outcome of an outbound request. */
export type OutboundResult =
  /** the server answered; the response is the final one after redirects */
  | { readonly ok: true; readonly response: Response }
  /** nothing was reached, and this is why */
  | { readonly ok: false; readonly refusal: OutboundRefusal };

/** Resolves a host name to its addresses. */
export type AddressResolver = (host: string) => Promise<readonly string[]>;

/** A fetch implementation, injected so the guard is testable without a network. */
export type FetchImplementation = (
  url: string,
  init: RequestInit,
) => Promise<Response>;

/**
 * The two collaborators a suite replaces: nothing else about the guard is
 * injectable, because the guard is what is being tested.
 */
export type OutboundOverrides = {
  /** address resolver; injected by tests and by the compose stack's suites */
  readonly resolve?: AddressResolver;
  /** fetch implementation; injected by tests */
  readonly fetchImplementation?: FetchImplementation;
};

/** How to make the request. */
export type OutboundFetchOptions = {
  /** deadline for the whole exchange, in milliseconds; defaults to 10 seconds */
  readonly timeoutMs?: number;
  /**
   * hosts exempted from the address guard, as `host` or `host:port`. Empty in a
   * deployment; the compose stack and the test suites use it to reach stubs.
   */
  readonly allowedHosts?: readonly string[];
  /** how many redirects to follow; defaults to 5 */
  readonly maxRedirects?: number;
  /** method, headers and body */
  readonly request?: RequestInit;
  /** address resolver; injected by tests */
  readonly resolve?: AddressResolver;
  /** fetch implementation; injected by tests */
  readonly fetchImplementation?: FetchImplementation;
};

/** Deadline for the whole exchange when the caller does not set one. */
const defaultTimeoutMs = 10_000;

/** Redirects followed when the caller does not set a limit. */
const defaultMaxRedirects = 5;

/** Statuses that name a new location to fetch. */
const redirectStatuses: readonly number[] = [301, 302, 303, 307, 308];

/** Statuses after which the request becomes a bodyless GET. */
const methodDroppingStatuses: readonly number[] = [301, 302, 303];

/**
 * The reason given when the value classified is not an address at all. Callers
 * that hold a host name rather than a literal use it to tell "guarded" apart
 * from "needs resolving".
 */
const notAnAddress = "not an IP address";

/**
 * Parses a dotted-quad IPv4 address.
 *
 * @param value - the candidate address
 * @returns its four bytes, or undefined when it is not an IPv4 address
 */
const parseIpv4 = (value: string): number[] | undefined => {
  const parts = value.split(".");
  if (parts.length !== 4) {
    return undefined;
  }
  const bytes = parts.map((part) =>
    /^\d{1,3}$/.test(part) ? Number(part) : Number.NaN,
  );
  return bytes.every((byte) => byte >= 0 && byte <= 255) ? bytes : undefined;
};

/**
 * Parses an IPv6 address, including the IPv4-mapped and IPv4-compatible forms.
 *
 * @param value - the candidate address, with or without a zone suffix
 * @returns its sixteen bytes, or undefined when it is not an IPv6 address
 */
const parseIpv6 = (value: string): number[] | undefined => {
  const withoutZone = value.split("%")[0] ?? "";
  if (!withoutZone.includes(":")) {
    return undefined;
  }

  // A trailing dotted quad (`::ffff:127.0.0.1`) is folded into two hex groups
  // so that the rest of the parse deals with one notation.
  const trailingQuad = /:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(withoutZone);
  let text = withoutZone;
  if (trailingQuad) {
    const quad = parseIpv4(trailingQuad[1] ?? "");
    if (quad === undefined) {
      return undefined;
    }
    const high = ((quad[0] << 8) | quad[1]).toString(16);
    const low = ((quad[2] << 8) | quad[3]).toString(16);
    text = `${withoutZone.slice(0, trailingQuad.index)}:${high}:${low}`;
  }

  const halves = text.split("::");
  if (halves.length > 2) {
    return undefined;
  }
  const head = halves[0] === "" ? [] : (halves[0] ?? "").split(":");
  const tail =
    halves.length === 2 && halves[1] !== "" ? (halves[1] ?? "").split(":") : [];
  const named = head.length + tail.length;
  if (halves.length === 1 ? named !== 8 : named > 7) {
    return undefined;
  }
  const groups =
    halves.length === 1
      ? head
      : [...head, ...Array.from({ length: 8 - named }, () => "0"), ...tail];

  const bytes: number[] = [];
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) {
      return undefined;
    }
    const word = Number.parseInt(group, 16);
    bytes.push(word >> 8, word & 0xff);
  }
  return bytes;
};

/**
 * Says why an IPv4 address must not be reached.
 *
 * Documentation ranges are deliberately absent: they are not internal, and
 * refusing them would break the examples participants copy.
 *
 * @param bytes - the four bytes of the address
 * @returns the reason, or undefined when the address is reachable
 */
const guardedIpv4Reason = (bytes: readonly number[]): string | undefined => {
  const [first = 0, second = 0, third = 0, fourth = 0] = bytes;
  if (first === 169 && second === 254 && third === 169 && fourth === 254) {
    return "a cloud metadata address";
  }
  if (first === 0) {
    return "an unspecified address";
  }
  if (first === 127) {
    return "a loopback address";
  }
  if (first === 10 || (first === 192 && second === 168)) {
    return "a private address";
  }
  if (first === 172 && second >= 16 && second <= 31) {
    return "a private address";
  }
  if (first === 100 && second >= 64 && second <= 127) {
    return "a carrier-grade NAT address";
  }
  if (first === 169 && second === 254) {
    return "a link-local address";
  }
  if (first === 192 && second === 0 && third === 0) {
    return "a reserved address";
  }
  if (first === 198 && (second === 18 || second === 19)) {
    return "a benchmarking address";
  }
  if (first >= 224 && first <= 239) {
    return "a multicast address";
  }
  if (first >= 240) {
    return "a reserved address";
  }
  return undefined;
};

/**
 * Says why an IPv6 address must not be reached.
 *
 * @param bytes - the sixteen bytes of the address
 * @returns the reason, or undefined when the address is reachable
 */
const guardedIpv6Reason = (bytes: readonly number[]): string | undefined => {
  const [first = 0, second = 0] = bytes;

  // The two special addresses come first: `::1` also looks like the
  // IPv4-compatible form of 0.0.0.1, and loopback is the truer description.
  if (bytes.every((byte) => byte === 0)) {
    return "an unspecified address";
  }
  if (bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1) {
    return "a loopback address";
  }

  // An IPv4-mapped or IPv4-compatible address is an IPv4 address wearing a hat;
  // unwrap it, or `::ffff:127.0.0.1` walks straight through.
  const embedsIpv4 =
    bytes.slice(0, 10).every((byte) => byte === 0) &&
    ((bytes[10] === 0xff && bytes[11] === 0xff) ||
      (bytes[10] === 0 && bytes[11] === 0));
  if (embedsIpv4) {
    return guardedIpv4Reason(bytes.slice(12));
  }

  if ((first & 0xfe) === 0xfc) {
    return "a unique local address";
  }
  if (first === 0xfe && (second & 0xc0) === 0x80) {
    return "a link-local address";
  }
  if (first === 0xff) {
    return "a multicast address";
  }
  return undefined;
};

/**
 * Says why an address must not be reached.
 *
 * Deny by default: something that is not an address at all is refused, because
 * the guard cannot vouch for what it could not read.
 *
 * @param address - the address to classify
 * @returns the reason, or undefined when the address is reachable
 * @example
 * ```ts
 * guardedAddressReason("169.254.169.254"); // "a cloud metadata address"
 * guardedAddressReason("203.0.113.7");     // undefined
 * ```
 */
export const guardedAddressReason = (address: string): string | undefined => {
  const ipv4 = parseIpv4(address);
  if (ipv4 !== undefined) {
    return guardedIpv4Reason(ipv4);
  }
  const ipv6 = parseIpv6(address);
  if (ipv6 !== undefined) {
    return guardedIpv6Reason(ipv6);
  }
  return notAnAddress;
};

/**
 * Reports whether a target is exempted from the address guard.
 *
 * An entry of `host` matches that host on any port; `host:port` matches only
 * that port.
 *
 * @param target - the URL being fetched
 * @param allowedHosts - the configured allowlist
 * @returns true when the target is allowlisted
 */
const isAllowlisted = (
  target: URL,
  allowedHosts: readonly string[],
): boolean => {
  const hostname = target.hostname.toLowerCase();
  const authority =
    target.port === "" ? hostname : `${hostname}:${target.port}`;
  return allowedHosts.some((entry) => {
    const candidate = entry.trim().toLowerCase();
    return candidate === hostname || candidate === authority;
  });
};

/**
 * Checks every address a target resolves to.
 *
 * @param target - the URL being fetched
 * @param resolver - the address resolver to use
 * @returns a refusal, or undefined when every address is reachable
 */
const guardTarget = async (
  target: URL,
  resolver: AddressResolver,
): Promise<OutboundRefusal | undefined> => {
  // A literal address needs no resolution, and asking for one would hand the
  // target to a resolver for nothing. Brackets around an IPv6 literal are the
  // URL's, not the address's.
  const literal = target.hostname.replaceAll(/^\[|]$/g, "");
  const literalReason = guardedAddressReason(literal);
  if (literalReason === undefined) {
    return undefined;
  }
  if (literalReason !== notAnAddress) {
    return { failureMode: "guarded", detail: `${literal} is ${literalReason}` };
  }

  let addresses: readonly string[];
  try {
    addresses = await resolver(target.hostname);
  } catch (cause) {
    return {
      failureMode: "refused",
      detail: `${target.hostname} could not be resolved: ${describeError(cause)}`,
    };
  }
  if (addresses.length === 0) {
    return {
      failureMode: "refused",
      detail: `${target.hostname} could not be resolved`,
    };
  }

  // Every answer must pass: a host that returns one public and one internal
  // address is a well-known way past a guard that only checks the first.
  for (const address of addresses) {
    const reason = guardedAddressReason(address);
    if (reason !== undefined) {
      return {
        failureMode: "guarded",
        detail: `${target.hostname} resolves to ${address}, which is ${reason}`,
      };
    }
  }
  return undefined;
};

/**
 * Renders a thrown value for a refusal detail.
 *
 * @param cause - the thrown value
 * @returns its message
 */
const describeError = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/**
 * Resolves a host name to its addresses using the system resolver.
 *
 * @param host - the host name to resolve
 * @returns every address the name resolves to
 */
const systemResolver: AddressResolver = async (host) => {
  const answers = await lookup(host, { all: true, verbatim: true });
  return answers.map((answer) => answer.address);
};

/**
 * Fetches a participant-supplied URL under the guard.
 *
 * @param url - the URL to fetch
 * @param options - guard settings and the request to make
 * @returns the final response, or the refusal that stopped it
 * @example
 * ```ts
 * const result = await outboundFetch(system.fhirBaseUrl + "/metadata", {
 *   timeoutMs: config.outbound.timeoutMs,
 *   allowedHosts: config.outbound.allowedHosts,
 * });
 * if (!result.ok) {
 *   return context.json({ error: result.refusal.failureMode, detail: result.refusal.detail }, 422);
 * }
 * ```
 */
export const outboundFetch = async (
  url: string,
  options: OutboundFetchOptions = {},
): Promise<OutboundResult> => {
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  const maxRedirects = options.maxRedirects ?? defaultMaxRedirects;
  const allowedHosts = options.allowedHosts ?? [];
  const resolver = options.resolve ?? systemResolver;
  const fetcher = options.fetchImplementation ?? fetch;

  // One deadline covers the whole exchange, redirects included, so a chain of
  // slow hops cannot outlast it.
  const signal = AbortSignal.timeout(timeoutMs);
  let next = url;
  let target: URL;
  let init: RequestInit = { ...options.request, redirect: "manual", signal };

  for (let hop = 0; ; hop += 1) {
    try {
      target = new URL(next);
    } catch {
      return refuse("invalid", `${next} is not a valid URL`);
    }
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      return refuse("invalid", `${target.protocol} is not an http(s) URL`);
    }

    if (!isAllowlisted(target, allowedHosts)) {
      const refusal = await guardTarget(target, resolver);
      if (refusal !== undefined) {
        return { ok: false, refusal };
      }
    }

    let response: Response;
    try {
      response = await fetcher(target.toString(), init);
    } catch (cause) {
      const name = cause instanceof Error ? cause.name : "";
      if (name === "TimeoutError" || name === "AbortError") {
        return refuse(
          "timeout",
          `${target.host} did not answer within ${String(timeoutMs)}ms`,
        );
      }
      return refuse("refused", describeError(cause));
    }

    if (!redirectStatuses.includes(response.status)) {
      return { ok: true, response };
    }
    if (hop >= maxRedirects) {
      return refuse(
        "invalid",
        `more than ${String(maxRedirects)} redirects were followed`,
      );
    }

    const location = response.headers.get("location");
    if (location === null || location.trim() === "") {
      return refuse(
        "invalid",
        `a ${String(response.status)} response carried no Location header`,
      );
    }
    try {
      next = new URL(location, target).toString();
    } catch {
      return refuse("invalid", `the Location header ${location} is not a URL`);
    }
    if (methodDroppingStatuses.includes(response.status)) {
      // A 301, 302 or 303 turns the follow-up into a plain GET, as a browser
      // would; carrying the body on would re-submit it somewhere else.
      init = {
        headers: init.headers,
        method: "GET",
        redirect: "manual",
        signal,
      };
    }
  }
};

/**
 * Builds a refusal result.
 *
 * @param failureMode - the classification to record
 * @param detail - the reason to show the member who asked
 * @returns the refusal result
 */
const refuse = (
  failureMode: OutboundFailureMode,
  detail: string,
): OutboundResult => ({ ok: false, refusal: { failureMode, detail } });
