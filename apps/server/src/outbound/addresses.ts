/**
 * Classification of IP addresses, for the outbound guard.
 *
 * Muster's whole job involves fetching addresses that participants typed: FHIR base
 * URLs, registration endpoints, persona sources. Each of those is a server-side
 * request to an address somebody else chose, which is the definition of SSRF - and
 * Muster runs inside a cluster, next to a metadata service that hands out
 * credentials to anything that asks for them.
 *
 * The guard is an allowlist by exclusion: an address is fetched only if it is
 * classified `public`. Every range with any special meaning is refused, including the
 * ones that look harmless. `169.254.169.254` is the cloud metadata address and falls
 * under link-local; `100.64.0.0/10` is carrier-grade NAT and reaches other tenants on
 * some providers; the documentation and benchmarking ranges are refused because a URL
 * pointing at one is a misconfiguration worth surfacing rather than a request worth
 * making.
 *
 * Everything here is pure and total: an unparseable input is reported as such rather
 * than throwing, because these values arrive in request bodies.
 *
 * @see https://datatracker.ietf.org/doc/html/rfc6890
 *
 * Author: John Grimes
 */

/**
 * What an address is for.
 *
 * Only `public` is fetchable. The rest are named individually rather than collapsed
 * into one `blocked` case, because a refusal that says which range it hit is the
 * difference between a usable message on a system entry and "check failed".
 */
export type AddressClassification =
  | "public"
  /** `0.0.0.0`, `::` - "this host", and on some stacks a route to localhost. */
  | "unspecified"
  /** `127.0.0.0/8`, `::1`. */
  | "loopback"
  /** RFC 1918: `10/8`, `172.16/12`, `192.168/16`. */
  | "private"
  /** IPv6 unique local addresses, `fc00::/7`. */
  | "unique-local"
  /** Carrier-grade NAT, `100.64.0.0/10`. */
  | "shared"
  /** `169.254/16`, `fe80::/10` - includes the cloud metadata address. */
  | "link-local"
  /** `224/4`, `ff00::/8`. */
  | "multicast"
  /** Protocol assignments, future use, the broadcast address, and IPv6 tunnels. */
  | "reserved"
  /** `192.0.2/24`, `198.51.100/24`, `203.0.113/24`, `2001:db8::/32`. */
  | "documentation"
  /** `198.18/15`. */
  | "benchmarking";

/**
 * Parses a strict dotted-quad IPv4 address.
 *
 * Strict deliberately. `inet_aton` accepts `0177.0.0.1`, `2130706433` and `127.1`,
 * all of which are `127.0.0.1` to a C resolver and none of which look like loopback
 * to a naive string check - the classic filter bypass. Accepting only four plain
 * decimal octets means the classifier below sees the same address the network stack
 * will.
 *
 * @param text - The candidate literal.
 * @returns The four bytes, or undefined when the value is not a dotted quad.
 */
export function parseIpv4(text: string): Uint8Array | undefined {
  const parts = text.split(".");
  if (parts.length !== 4) {
    return undefined;
  }

  const bytes = new Uint8Array(4);
  for (const [index, part] of parts.entries()) {
    // No leading zeros: `010` is octal to some parsers and decimal to others.
    if (!/^(?:0|[1-9]\d{0,2})$/.test(part)) {
      return undefined;
    }
    const value = Number(part);
    if (value > 255) {
      return undefined;
    }
    bytes[index] = value;
  }
  return bytes;
}

/** Parses a colon-delimited run of hex groups. An empty string yields none. */
function parseHexGroups(text: string): number[] | undefined {
  if (text.length === 0) {
    return [];
  }
  const groups: number[] = [];
  for (const part of text.split(":")) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(part)) {
      return undefined;
    }
    groups.push(Number.parseInt(part, 16));
  }
  return groups;
}

/** Writes a 16-bit group into a byte buffer at a group index. */
function writeGroup(bytes: Uint8Array, group: number, value: number): void {
  bytes[group * 2] = (value >> 8) & 0xff;
  bytes[group * 2 + 1] = value & 0xff;
}

/**
 * Rewrites an embedded IPv4 tail as the two hex groups it denotes.
 *
 * `::ffff:127.0.0.1` becomes `::ffff:7f00:1`, which is the same address, so the group
 * parsing has one syntax to handle rather than two.
 */
function foldIpv4Tail(raw: string): string | undefined {
  const lastColon = raw.lastIndexOf(":");
  if (lastColon === -1) {
    return undefined;
  }
  const embedded = parseIpv4(raw.slice(lastColon + 1));
  if (embedded === undefined) {
    return undefined;
  }
  const high = ((embedded[0] ?? 0) << 8) | (embedded[1] ?? 0);
  const low = ((embedded[2] ?? 0) << 8) | (embedded[3] ?? 0);
  return `${raw.slice(0, lastColon + 1)}${high.toString(16)}:${low.toString(16)}`;
}

/**
 * Parses an IPv6 address, including the `::` elision and an embedded IPv4 tail.
 *
 * Surrounding brackets are accepted because that is how the address appears in a
 * URL's host component, and a caller working from `URL.hostname` would otherwise have
 * to strip them itself and get it wrong once.
 *
 * @param text - The candidate literal, bracketed or not.
 * @returns The sixteen bytes, or undefined when the value is not an IPv6 address.
 */
export function parseIpv6(text: string): Uint8Array | undefined {
  const bracketed = text.startsWith("[") && text.endsWith("]");
  let raw = bracketed ? text.slice(1, -1) : text;
  // A zone identifier (`fe80::1%eth0`) is not valid in a URL host, and would make the
  // address non-comparable.
  if (raw.length === 0 || raw.includes("%")) {
    return undefined;
  }

  if (raw.includes(".")) {
    const folded = foldIpv4Tail(raw);
    if (folded === undefined) {
      return undefined;
    }
    raw = folded;
  }

  const elision = raw.indexOf("::");
  if (elision !== raw.lastIndexOf("::")) {
    return undefined;
  }

  const head = parseHexGroups(elision === -1 ? raw : raw.slice(0, elision));
  const tail = parseHexGroups(elision === -1 ? "" : raw.slice(elision + 2));
  if (head === undefined || tail === undefined) {
    return undefined;
  }

  // Without an elision every group must be written; with one, at least one group must
  // actually be elided, so seven is the most that may be written.
  const total = head.length + tail.length;
  if (elision === -1 ? total !== 8 : total > 7) {
    return undefined;
  }

  const bytes = new Uint8Array(16);
  for (const [index, value] of head.entries()) {
    writeGroup(bytes, index, value);
  }
  for (const [index, value] of tail.entries()) {
    writeGroup(bytes, 8 - tail.length + index, value);
  }
  return bytes;
}

/** Classifies four bytes of IPv4 address. */
function classifyIpv4Bytes(bytes: Uint8Array): AddressClassification {
  const [a = 0, b = 0, c = 0, d = 0] = bytes;

  if (a === 0) {
    return b === 0 && c === 0 && d === 0 ? "unspecified" : "reserved";
  }
  if (a === 10) {
    return "private";
  }
  if (a === 127) {
    return "loopback";
  }
  if (a === 100 && b >= 64 && b <= 127) {
    return "shared";
  }
  if (a === 169 && b === 254) {
    return "link-local";
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return "private";
  }
  if (a === 192 && b === 168) {
    return "private";
  }
  if (a === 192 && b === 0 && (c === 0 || c === 2)) {
    return c === 0 ? "reserved" : "documentation";
  }
  if (a === 198 && (b === 18 || b === 19)) {
    return "benchmarking";
  }
  if (a === 198 && b === 51 && c === 100) {
    return "documentation";
  }
  if (a === 203 && b === 0 && c === 113) {
    return "documentation";
  }
  if (a >= 224 && a <= 239) {
    return "multicast";
  }
  if (a >= 240) {
    return "reserved";
  }
  return "public";
}

/**
 * The IPv4 address an IPv6 address embeds, when it embeds one.
 *
 * `::ffff:a.b.c.d` is the IPv4-mapped form and `::a.b.c.d` the deprecated
 * IPv4-compatible form; both reach an IPv4 destination, so both are classified as the
 * address they carry. Otherwise `::ffff:127.0.0.1` reads as a public IPv6 address and
 * is fetched, which is the oldest bypass of this kind of filter.
 *
 * Called only after `::` and `::1` have been handled, so the all-zero and loopback
 * forms cannot reach it and be misread as `0.0.0.0` or `0.0.0.1`.
 */
function embeddedIpv4(bytes: Uint8Array): Uint8Array | undefined {
  if (!bytes.slice(0, 10).every((byte) => byte === 0)) {
    return undefined;
  }
  const marker = ((bytes[10] ?? 0) << 8) | (bytes[11] ?? 0);
  return marker === 0xff_ff || marker === 0 ? bytes.slice(12, 16) : undefined;
}

/** Classifies sixteen bytes of IPv6 address. */
function classifyIpv6Bytes(bytes: Uint8Array): AddressClassification {
  if (bytes.every((byte) => byte === 0)) {
    return "unspecified";
  }
  if (bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1) {
    return "loopback";
  }

  const embedded = embeddedIpv4(bytes);
  if (embedded !== undefined) {
    return classifyIpv4Bytes(embedded);
  }

  const first = bytes[0] ?? 0;
  const second = bytes[1] ?? 0;

  if (first === 0xff) {
    return "multicast";
  }
  if ((first & 0xfe) === 0xfc) {
    return "unique-local";
  }
  if (first === 0xfe && (second & 0xc0) === 0x80) {
    return "link-local";
  }
  if (
    first === 0x20 &&
    second === 0x01 &&
    bytes[2] === 0x0d &&
    bytes[3] === 0xb8
  ) {
    return "documentation";
  }
  // `2002::/16` (6to4) and `2001::/32` (Teredo) tunnel to an arbitrary IPv4
  // destination, so an address in either reaches a private network without looking
  // like it.
  if (first === 0x20 && second === 0x02) {
    return "reserved";
  }
  if (first === 0x20 && second === 0x01 && bytes[2] === 0 && bytes[3] === 0) {
    return "reserved";
  }
  return "public";
}

/**
 * Classifies an IP address literal.
 *
 * @param text - A dotted-quad or IPv6 literal, with or without brackets.
 * @returns The classification, or undefined when the value is not an IP address at
 *   all - which for a URL host means it is a DNS name and must be resolved before it
 *   can be judged.
 * @example
 * ```ts
 * classifyIpAddress("169.254.169.254"); // "link-local"
 * ```
 */
export function classifyIpAddress(
  text: string,
): AddressClassification | undefined {
  const ipv4 = parseIpv4(text);
  if (ipv4 !== undefined) {
    return classifyIpv4Bytes(ipv4);
  }
  const ipv6 = parseIpv6(text);
  return ipv6 === undefined ? undefined : classifyIpv6Bytes(ipv6);
}

/**
 * Whether an address may be fetched.
 *
 * An unparseable value is not fetchable: this is a gate, and "I could not tell what
 * this is" must never mean yes.
 *
 * @param text - The address literal to judge.
 * @returns `true` only for a publicly routable address.
 */
export function isFetchableAddress(text: string): boolean {
  return classifyIpAddress(text) === "public";
}
