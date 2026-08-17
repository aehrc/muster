import { Hono } from "hono";

import type { AppEnvironment } from "../app.ts";

/**
 * Public read API: stub surface.
 *
 * @author John Grimes
 */

/**
 * Builds the public read routes.
 *
 * @returns the routes, to be mounted under `/api`
 */
export const createPublicRoutes = (): Hono<AppEnvironment> =>
  new Hono<AppEnvironment>();
