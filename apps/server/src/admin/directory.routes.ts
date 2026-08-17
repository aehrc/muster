import { Hono } from "hono";

import type { AppEnvironment } from "../app.ts";

/**
 * Directory routes: stub surface.
 *
 * @author John Grimes
 */

/**
 * Builds the organisation, system, event and enrolment routes.
 *
 * @returns the routes, to be mounted under `/api`
 */
export const createDirectoryRoutes = (): Hono<AppEnvironment> =>
  new Hono<AppEnvironment>();
