/**
 * The public read API: the directory, without an account.
 *
 * Every route here is readable by anybody (FR-010, FR-021, constitution principle V), and
 * every one of them is fed by the same repositories the console reads - there is no
 * view-only data path, so a field the web pages show is a field this API returns.
 *
 * What is absent is the point. No response built here passes through `contactView` or
 * `sessionAccountView`, which are the only two projections in `./views.ts` that carry an
 * email address. A reader who wants contacts signs in and asks
 * `GET /api/organisations/{id}/contacts`.
 *
 * Verification status is here and public, per constitution principle V: the event view's
 * status column and the system page's verification panel are the point of User Story 3 and
 * both are readable without an account. A server nobody has checked reports `null` rather
 * than "reachable: false", which would be a claim rather than an absence. The DCR-verified
 * badge is still absent, for the same reason: no harness has run until User Story 6.
 *
 * The list responses are single-field envelopes (`{ events: [...] }`) rather than bare
 * arrays. `contracts/http-api.md` does not settle it, so these routes do: an envelope leaves
 * room for the check summaries and the badge to arrive beside the list without every caller
 * having to cope with a changed top-level type. Nothing is paginated - a connectathon has
 * tens of organisations - so `pageQuerySchema` stays unused until something can outgrow a
 * page.
 *
 * Author: John Grimes
 */

import {
  findCheckStatus,
  findEventEnrolment,
  listCheckHistory,
  listCheckStatuses,
  listEventEnrolments,
  listEvents,
} from "@muster/db";

import { jsonError } from "./errors.js";
import {
  enrolledSystemDetailView,
  enrolledSystemView,
  eventDetailView,
  eventSummaryView,
} from "./views.js";
import { namedEvent } from "../admin/access.js";

import type { MusterEnvironment, ServerContext } from "../context.js";
import type { Hono } from "hono";

/**
 * Registers the public read routes.
 *
 * @param router - The API router.
 * @param context - The server's dependencies.
 * @example
 * ```ts
 * registerPublicRoutes(router, context);
 * ```
 */
export function registerPublicRoutes(
  router: Hono<MusterEnvironment>,
  context: ServerContext,
): void {
  /**
   * Every event.
   *
   * Draft events included. A draft is an event an admin is still assembling, and it carries
   * no contact detail and no enrolment; hiding it would be the first exception to "public by
   * default" and would buy nothing.
   */
  router.get("/events", async (c) => {
    const events = await listEvents(context.db);
    return c.json({ events: events.map(eventSummaryView) });
  });

  /** One event, with the capability tags its enrolments may choose from. */
  router.get("/events/:slug", async (c) => {
    const event = await namedEvent(context, c, c.req.param("slug"));
    if (event instanceof Response) {
      return event;
    }
    return c.json({ event: eventDetailView(event) });
  });

  /**
   * The systems enrolled in one event: the replacement for the participant table.
   *
   * Only enrolled systems, which is what makes a system enrolled last December and not this
   * September absent from this September (scenario 7).
   */
  router.get("/events/:slug/systems", async (c) => {
    const event = await namedEvent(context, c, c.req.param("slug"));
    if (event instanceof Response) {
      return event;
    }
    const enrolments = await listEventEnrolments(context.db, event.id);
    // One query for every enrolment's latest check rather than one per row, and the map is
    // what makes an unchecked enrolment absent rather than answered with a manufactured
    // failure.
    const statuses = await listCheckStatuses(
      context.db,
      enrolments.map((row) => row.enrolment.id),
    );
    return c.json({
      event: eventDetailView(event),
      systems: enrolments.map((row) =>
        enrolledSystemView(row, statuses.get(row.enrolment.id)),
      ),
    });
  });

  /** One enrolled system. */
  router.get("/events/:slug/systems/:systemId", async (c) => {
    const event = await namedEvent(context, c, c.req.param("slug"));
    if (event instanceof Response) {
      return event;
    }
    const enrolment = await findEventEnrolment(context.db, {
      eventId: event.id,
      systemId: c.req.param("systemId"),
    });
    if (enrolment === undefined) {
      // A system that exists but is not enrolled in this event answers the same way as one
      // that does not exist: from this event's point of view there is no difference.
      return jsonError(
        c,
        404,
        "not_found",
        "No system with that id is enrolled in this event",
      );
    }
    const [status, history] = await Promise.all([
      findCheckStatus(context.db, enrolment.enrolment.id),
      listCheckHistory(context.db, enrolment.enrolment.id),
    ]);
    return c.json({
      event: eventDetailView(event),
      system: enrolledSystemDetailView(enrolment, status, history),
    });
  });
}
