import { buildBrandsBundle } from "@muster/core";
import { Hono } from "hono";

import { listEnrolledEntries, requireEvent } from "./lookups.ts";
import { enrolledSystem } from "./views.ts";

import type { AppEnvironment } from "../app.ts";

/**
 * The per-event SMART User-access Brands bundle (FR-022).
 *
 * A separate route from the JSON API because it answers a different question:
 * not "what is in this event" but "where do I connect", in the publication format
 * apps already read for endpoint discovery. It is anonymous, like every public
 * read (SC-006), and it looks up no contacts at all, so the response cannot carry
 * one however the bundle were built (FR-007).
 *
 * Two things the specification asks of a publisher are answered here rather than
 * in the pure builder, because they are properties of the response and not of the
 * bundle: it is served as `application/fhir+json`, and it permits cross-origin
 * reads, which the brands specification requires of every GET of a published
 * bundle so that a browser-based app can fetch it.
 *
 * @author John Grimes
 */

/**
 * Builds the brands bundle route.
 *
 * @returns the route, to be mounted under `/api`
 * @example
 * ```ts
 * app.route("/api", createBrandsRoutes());
 * ```
 */
export const createBrandsRoutes = (): Hono<AppEnvironment> => {
  const routes = new Hono<AppEnvironment>();

  routes.get("/events/:slug/brands.json", async (context) => {
    const event = await requireEvent(context, context.req.param("slug"));
    // The latest check is what an endpoint's FHIR version comes from, so the
    // entries arrive with their checks already matched to them.
    const entries = await listEnrolledEntries(context.get("sql"), event.id);
    const bundle = buildBrandsBundle({
      eventSlug: event.slug,
      systems: entries.map(({ row, check }) =>
        enrolledSystem(row, check === undefined ? {} : { check }),
      ),
      publicUrl: context.get("config").publicUrl,
      generatedAt: new Date(),
    });
    return context.body(JSON.stringify(bundle), 200, {
      "content-type": "application/fhir+json; charset=UTF-8",
      "access-control-allow-origin": "*",
    });
  });

  return routes;
};
