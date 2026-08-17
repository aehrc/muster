import { Hono } from "hono";

import type { AppEnvironment } from "../app.ts";
import type { RateLimitPolicy } from "@muster/core";

/**
 * Auth routes: stub surface.
 *
 * @author John Grimes
 */

/** How many credential attempts one address may make on one route. */
export const authRateLimitPolicy: RateLimitPolicy = {
  limit: 10,
  windowMs: 60_000,
};

/**
 * Builds the auth routes.
 *
 * @returns the routes, to be mounted under `/api/auth`
 */
export const createAuthRoutes = (): Hono<AppEnvironment> =>
  new Hono<AppEnvironment>();
