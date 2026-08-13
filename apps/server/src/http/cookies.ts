/**
 * Reading and writing the session cookie.
 *
 * Every attribute is a security decision, so they are set here rather than at each call
 * site.
 *
 * `HttpOnly` keeps the value out of reach of any script on the origin, which is why the
 * console holds no bearer token. `SameSite=Lax` stops a cross-site form post acting as the
 * signed-in caller while still allowing the ordinary case of following a link in. `Secure`
 * is decided from the deployment's own public URL rather than from the request, because a
 * request arriving over HTTP at a service published over HTTPS has been through a proxy,
 * and the proxy's scheme is not the one the browser used.
 *
 * `Path=/` rather than `/api`: the cookie is read by the API and cleared by the console,
 * and scoping it to the API path would leave a cookie the console cannot expire.
 *
 * Author: John Grimes
 */

/** Where the session cookie is sent for. */
const COOKIE_PATH = "/";

/** How a cookie should be written. */
export interface SessionCookieOptions {
  readonly secure: boolean;
  readonly maxAgeSeconds: number;
}

/**
 * Builds a `Set-Cookie` value for a session credential.
 *
 * @param name - The cookie's name.
 * @param value - The opaque session token, or the empty string to clear it.
 * @param options - Whether to mark it `Secure`, and how long it lives.
 * @returns The header value.
 * @example
 * ```ts
 * c.header("Set-Cookie", sessionCookieHeader(SESSION_COOKIE_NAME, token, {
 *   secure: cookiesAreSecure(config.publicUrl),
 *   maxAgeSeconds: SESSION_TTL_SECONDS,
 * }));
 * ```
 */
export function sessionCookieHeader(
  name: string,
  value: string,
  options: SessionCookieOptions,
): string {
  return [
    `${name}=${value}`,
    `Path=${COOKIE_PATH}`,
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${String(options.maxAgeSeconds)}`,
    ...(options.secure ? ["Secure"] : []),
  ].join("; ");
}

/**
 * Whether cookies should carry `Secure`, given the deployment's public URL.
 *
 * @param publicUrl - `MUSTER_PUBLIC_URL`, as resolved by the configuration.
 * @returns `true` when the deployment is published over HTTPS.
 */
export function cookiesAreSecure(publicUrl: string): boolean {
  return publicUrl.startsWith("https:");
}

/**
 * Reads one cookie from a `Cookie` header.
 *
 * Hand-written rather than a dependency: the header is a semicolon-separated list of
 * `name=value`, and the whole of what Muster needs from it is one name.
 *
 * The first occurrence of a name wins, matching what a browser sends for the most specific
 * path - so a cookie set for `/` and one set for `/api` resolve to the one the browser
 * considers more specific rather than to whichever came last.
 *
 * @param header - The request's `Cookie` header, if it had one.
 * @param name - The cookie to read.
 * @returns The value, or `undefined` when the cookie is absent or empty.
 * @example
 * ```ts
 * const token = readCookie(c.req.header("cookie"), SESSION_COOKIE_NAME);
 * ```
 */
export function readCookie(
  header: string | undefined,
  name: string,
): string | undefined {
  if (header === undefined) {
    return undefined;
  }

  for (const pair of header.split(";")) {
    const separator = pair.indexOf("=");
    if (separator === -1) {
      continue;
    }
    if (pair.slice(0, separator).trim() !== name) {
      continue;
    }
    const value = pair.slice(separator + 1).trim();
    return value.length === 0 ? undefined : value;
  }
  return undefined;
}
