import { Hono } from "hono";

import type { AppEnvironment } from "../app.ts";

/**
 * Member administration routes: stub surface.
 *
 * @author John Grimes
 */

/**
 * Builds the approval, revocation and reassignment routes.
 *
 * @returns the routes, to be mounted under `/api`
 */
export const createMembersRoutes = (): Hono<AppEnvironment> =>
  new Hono<AppEnvironment>();
