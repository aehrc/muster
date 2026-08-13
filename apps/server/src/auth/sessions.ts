/**
 * Opening, reading and ending a console session.
 *
 * A session is an opaque random token in an `HttpOnly` cookie, and the database holds only
 * its digest (see `./tokens.ts`). Two properties follow, and both matter. A copy of the
 * `session` table yields nothing replayable, because a digest cannot be presented as a
 * cookie. And the token carries no claims, so revoking a session is deleting a row rather
 * than maintaining a denylist of things that assert their own validity.
 *
 * Author: John Grimes
 */

import {
  cookiesAreSecure,
  readCookie,
  sessionCookieHeader,
} from "../http/cookies.js";

/** The console's session cookie. */
export const SESSION_COOKIE_NAME = "muster_session";

/**
 * How long a session lasts: seven days.
 *
 * Longer than a banking session and shorter than forever. Connectathon participants sign
 * in on Monday and are still working on Friday, and a twelve-hour session would put a
 * sign-in in the middle of every pairing round trip. The cookie is `HttpOnly` and
 * `SameSite=Lax`, and signing out deletes the row, so the exposure a longer life buys is
 * bounded by a browser nobody else uses.
 */
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * When a session opened now should expire.
 *
 * @param now - The current time.
 * @returns The expiry, {@link SESSION_TTL_SECONDS} later.
 */
export function sessionExpiry(now: Date): Date {
  return new Date(now.getTime() + SESSION_TTL_SECONDS * 1000);
}

/**
 * The `Set-Cookie` value that establishes a session.
 *
 * @param token - The opaque token.
 * @param publicUrl - The deployment's public URL, which decides `Secure`.
 * @returns The header value.
 */
export function sessionCookie(token: string, publicUrl: string): string {
  return sessionCookieHeader(SESSION_COOKIE_NAME, token, {
    secure: cookiesAreSecure(publicUrl),
    maxAgeSeconds: SESSION_TTL_SECONDS,
  });
}

/**
 * The `Set-Cookie` value that ends a session.
 *
 * Every attribute except the lifetime matches {@link sessionCookie}: a browser only
 * replaces a cookie whose name, path and domain agree, so an expiry that differed in
 * `Path` would leave the old cookie in place.
 *
 * @param publicUrl - The deployment's public URL, which decides `Secure`.
 * @returns The header value.
 */
export function clearedSessionCookie(publicUrl: string): string {
  return sessionCookieHeader(SESSION_COOKIE_NAME, "", {
    secure: cookiesAreSecure(publicUrl),
    maxAgeSeconds: 0,
  });
}

/**
 * The session token a request presented, if it presented one.
 *
 * @param cookieHeader - The request's `Cookie` header.
 * @returns The token, or `undefined`.
 */
export function presentedSessionToken(
  cookieHeader: string | undefined,
): string | undefined {
  return readCookie(cookieHeader, SESSION_COOKIE_NAME);
}
