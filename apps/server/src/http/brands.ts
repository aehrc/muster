/**
 * The per-event brands bundle: `GET /api/events/{slug}/brands.json` (FR-022).
 *
 * Anonymous, like every other read surface (SC-006, constitution principle V), and fed by the
 * same repositories as the public JSON API and the event view - there is no view-only path to
 * this data, so a system in the bundle is a system in the listing.
 *
 * The handler does three things and decides nothing. It reads the event's enrolments, it
 * projects the servers among them into the shape `buildBrandsBundle` takes, and it serves the
 * result. Which entries a bundle contains and what they look like is the pure builder's, and
 * is tested without a database.
 *
 * **Two filters, and they are the same requirement.** The query is scoped to the event, so a
 * system enrolled in another event or in none is absent; and only enrolments whose system
 * carries a server profile are projected, because a client has no FHIR base URL for an app to
 * discover. Together those are scenario 3.
 *
 * **CORS.** The publication format requires a publisher to support cross-origin GETs, and
 * without that a browser-based app - the format's whole audience - cannot read the bundle at
 * all. It is safe here in a way it would not be elsewhere: this response is built from the
 * public projection and the route reads no cookie, so allowing any origin to read it grants
 * nothing that fetching the same URL directly would not.
 *
 * Author: John Grimes
 */

import { buildBrandsBundle } from "@muster/core";

import { namedEventEnrolments } from "./publicApi.js";

import type { MusterEnvironment, ServerContext } from "../context.js";
import type { BrandServer } from "@muster/core";
import type { CheckStatusRow, EnrolledSystemRow } from "@muster/db";
import type { Hono } from "hono";

/** The media type the brands bundle is published under. */
const FHIR_JSON = "application/fhir+json; charset=UTF-8";

/**
 * One enrolled server, projected for the bundle.
 *
 * Explicit, like every other projection in this directory: five fields, none of them a
 * contact detail, and a column added to `system` does not join a published FHIR artefact
 * without an edit here.
 *
 * @param row - The enrolment, its system and its owner.
 * @param status - The latest check on the enrolment, if one has run.
 * @returns The server, or undefined when the enrolled system is not one.
 */
function brandServer(
  row: EnrolledSystemRow,
  status: CheckStatusRow | undefined,
): BrandServer | undefined {
  const profile = row.system.serverProfile;
  if (profile === null) {
    return undefined;
  }
  return {
    systemId: row.system.id,
    systemName: row.system.name,
    fhirBaseUrl: profile.fhirBaseUrl,
    // The server's own statement of its version, when a check has read one.
    advertisedFhirVersion: status?.latest.capability?.fhirVersion ?? null,
    // Either can move without the other: an owner edits the record, or re-confirms the
    // enrolment. The bundle's timestamp is the later of the two.
    updatedAt: new Date(
      Math.max(
        row.enrolment.updatedAt.getTime(),
        row.system.updatedAt.getTime(),
      ),
    ),
  };
}

/**
 * Registers the brands bundle route.
 *
 * @param router - The API router.
 * @param context - The server's dependencies.
 * @example
 * ```ts
 * registerBrandsRoutes(router, context);
 * ```
 */
export function registerBrandsRoutes(
  router: Hono<MusterEnvironment>,
  context: ServerContext,
): void {
  router.get("/events/:slug/brands.json", async (c) => {
    // The same read the public systems listing makes, which is what "no view-only data path"
    // amounts to here: a system in the listing is a system in the bundle.
    const read = await namedEventEnrolments(context, c, c.req.param("slug"));
    if (read instanceof Response) {
      return read;
    }
    const servers = read.enrolments.flatMap((row) => {
      const server = brandServer(row, read.statuses.get(row.enrolment.id));
      return server === undefined ? [] : [server];
    });

    const bundle = buildBrandsBundle({
      eventSlug: read.event.slug,
      publicUrl: context.config.publicUrl,
      eventUpdatedAt: read.event.updatedAt,
      servers,
    });

    // Serialised here rather than through `c.json`, which would label a FHIR resource
    // `application/json`.
    return c.body(JSON.stringify(bundle), 200, {
      "content-type": FHIR_JSON,
      "access-control-allow-origin": "*",
    });
  });
}
