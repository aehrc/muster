import { authoriseWrite } from "@muster/core";
import {
  findEnrolledSystem,
  findEventBySlug,
  listEnrolledSystems,
  listEvents,
  listOrganisationContacts,
} from "@muster/db";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

import { currentAccount, factsFor } from "../auth/sessions.ts";
import { enrolledSystem, eventDetail, eventSummary } from "./views.ts";

import type { AppEnvironment } from "../app.ts";
import type { EnrolledSystem } from "@muster/contracts";
import type { EnrolledSystemRow, EventRow } from "@muster/db";
import type { Context } from "hono";

/**
 * The public read API: the event view, by machine.
 *
 * Everything here is readable without an account, because a directory nobody can
 * read is not a directory (FR-021, SC-006), and the web console reads the same
 * routes, so there is one surface to keep true rather than two.
 *
 * Contact details are the exception, and the gate is applied once, here: the
 * caller is asked for, the rules are asked whether that caller may write, and
 * only then are the contacts fetched at all. An anonymous response cannot carry
 * a contact detail because nothing looked one up (FR-007).
 *
 * @author John Grimes
 */

/**
 * Decides whether this caller may see contact details.
 *
 * @param context - the request being answered
 * @returns true for a signed-in account that is approved with a verified address
 */
const contactsVisible = async (
  context: Context<AppEnvironment>,
): Promise<boolean> => {
  const account = await currentAccount(context);
  return account !== undefined && authoriseWrite(factsFor(account)).ok;
};

/**
 * Finds an event by slug, or refuses.
 *
 * @param context - the request being answered
 * @param slug - the event's slug
 * @returns the event
 * @throws {HTTPException} 404 when there is no such event
 */
const requireEvent = async (
  context: Context<AppEnvironment>,
  slug: string,
): Promise<EventRow> => {
  const event = await findEventBySlug(context.get("sql"), slug);
  if (event === undefined) {
    throw new HTTPException(404, { message: "No such event." });
  }
  return event;
};

/**
 * Renders an enrolled system, with contacts only when the reader may see them.
 *
 * @param context - the request being answered
 * @param row - the enrolment joined to its system and organisation
 * @param visible - whether the reader may see contact details
 * @returns the enrolled system
 */
const renderSystem = async (
  context: Context<AppEnvironment>,
  row: EnrolledSystemRow,
  visible: boolean,
): Promise<EnrolledSystem> =>
  visible
    ? enrolledSystem(
        row,
        await listOrganisationContacts(context.get("sql"), row.organisation.id),
      )
    : enrolledSystem(row);

/**
 * Builds the public read routes.
 *
 * @returns the routes, to be mounted under `/api`
 * @example
 * ```ts
 * app.route("/api", createPublicRoutes());
 * ```
 */
export const createPublicRoutes = (): Hono<AppEnvironment> => {
  const routes = new Hono<AppEnvironment>();

  routes.get("/events", async (context) => {
    const events = await listEvents(context.get("sql"));
    return context.json({ events: events.map(eventSummary) });
  });

  routes.get("/events/:slug", async (context) => {
    const event = await requireEvent(context, context.req.param("slug"));
    return context.json({ event: eventDetail(event) });
  });

  // The table replacement: every enrolled system in the event, and nothing that
  // is not enrolled in it (FR-009, FR-010).
  routes.get("/events/:slug/systems", async (context) => {
    const event = await requireEvent(context, context.req.param("slug"));
    const visible = await contactsVisible(context);
    const rows = await listEnrolledSystems(context.get("sql"), event.id);
    const systems = await Promise.all(
      rows.map((row) => renderSystem(context, row, visible)),
    );
    return context.json({ event: eventDetail(event), systems });
  });

  routes.get("/events/:slug/systems/:id", async (context) => {
    const event = await requireEvent(context, context.req.param("slug"));
    const row = await findEnrolledSystem(context.get("sql"), {
      eventId: event.id,
      systemId: context.req.param("id"),
    });
    if (row === undefined) {
      // Not enrolled in this event is not found in this event, whatever else is
      // true of the system.
      throw new HTTPException(404, {
        message: "No such system is enrolled in that event.",
      });
    }
    return context.json({
      event: eventDetail(event),
      system: await renderSystem(context, row, await contactsVisible(context)),
    });
  });

  return routes;
};
