/**
 * The `/api` surface, assembled.
 *
 * Session resolution runs on every request and refuses nobody: Muster's read surfaces are
 * public by constitution, so who is calling is information rather than a precondition. The
 * guards are attached per route, because authority varies per route and not per path prefix -
 * `GET /api/events/:slug` and `POST /api/events/:slug/enrolments` share a prefix and share
 * nothing else.
 *
 * That arrangement fails in the direction of publishing a route by forgetting its guard, so
 * the forgetting is tested rather than trusted. {@link PUBLIC_REQUESTS} enumerates every
 * request answerable without a session, each with the reason it is one, and
 * `router.integration.test.ts` compares the declaration against the application's own route
 * table in both directions: a new route that answers an anonymous caller fails the build, and
 * an entry here that no longer names a route fails it too.
 *
 * Author: John Grimes
 */

import { Hono } from "hono";

import { registerDirectoryRoutes } from "../admin/directory.routes.js";
import { registerMemberRoutes } from "../admin/members.routes.js";
import { resolveSession } from "../auth/middleware.js";
import { registerAuthRoutes } from "../auth/routes.js";
import { jsonError } from "../http/errors.js";
import { registerPublicRoutes } from "../http/publicApi.js";
import { registerPairingRoutes } from "../pairing/routes.js";

import type { MusterEnvironment, ServerContext } from "../context.js";

/** Where the API is mounted within the application. */
export const API_BASE_PATH = "/api";

/**
 * Every request the API answers without a session, and why.
 *
 * The key is `METHOD routePath` - the pattern Hono matched, not the path requested - so a
 * parameter cannot be spelled to look like one of these. Anything added here is a decision to
 * publish part of the API, which should be visible in a diff and hard to do by accident.
 */
export const PUBLIC_REQUESTS: Readonly<Record<string, string>> = {
  "POST /api/auth/sign-up": "Creating an account cannot require having one",
  "POST /api/auth/verify": "The holder of a fresh account has no session yet",
  "POST /api/auth/resend-verification":
    "Asked for precisely because the first link did not work",
  "POST /api/auth/sign-in": "The route that establishes a session",
  "POST /api/auth/sign-out":
    "Clears the cookie whether or not it still names a live session",
  "GET /api/auth/me":
    "Asked by every page on load; an anonymous visitor is answered with a null account",
  "GET /api/events": "FR-010: the directory is readable without an account",
  "GET /api/events/:slug": "FR-010",
  "GET /api/events/:slug/systems":
    "FR-010 and FR-021: the participant table's replacement, contacts excluded",
  "GET /api/events/:slug/systems/:systemId": "FR-010, contacts excluded",
};

/**
 * Builds the API router.
 *
 * @param context - The server's dependencies.
 * @returns The router, to be mounted at {@link API_BASE_PATH}.
 * @example
 * ```ts
 * app.route(API_BASE_PATH, createApiRouter(context));
 * ```
 */
export function createApiRouter(
  context: ServerContext,
): Hono<MusterEnvironment> {
  const router = new Hono<MusterEnvironment>();

  router.use("*", resolveSession(context));

  registerAuthRoutes(router, context);
  registerPublicRoutes(router, context);
  registerDirectoryRoutes(router, context);
  registerMemberRoutes(router, context);
  registerPairingRoutes(router, context);

  // Registered last, so it answers only what nothing above matched. A `notFound` handler
  // would not do: this router is mounted into the application, and the application's own
  // 404 has the console's static fallback in front of it.
  router.all("*", (c) => jsonError(c, 404, "not_found", "No such API route"));

  return router;
}
