import { authoriseWrite } from "@muster/core";
import {
  findCheckStatus,
  findEnrolledSystem,
  findLatestHarnessRun,
  listCheckResults,
  listEvents,
  listOrganisationContacts,
} from "@muster/db";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

import { listEnrolledEntries, requireEvent } from "./lookups.ts";
import { enrolledSystem, eventDetail, eventSummary } from "./views.ts";
import { currentAccount, factsFor } from "../auth/sessions.ts";

import type { EnrolledEntry } from "./lookups.ts";
import type { AppEnvironment } from "../app.ts";
import type { EnrolledSystem } from "@muster/contracts";
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

/** How many checks the system detail shows. */
const checkHistoryLength = 20;

/**
 * Renders an enrolled system, with contacts only when the reader may see them.
 *
 * @param context - the request being answered
 * @param entry - the enrolment with its latest check and conformance run
 * @param visible - whether the reader may see contact details
 * @returns the enrolled system
 */
const renderSystem = async (
  context: Context<AppEnvironment>,
  entry: EnrolledEntry,
  visible: boolean,
): Promise<EnrolledSystem> =>
  enrolledSystem(entry.row, {
    ...(visible
      ? {
          contacts: await listOrganisationContacts(
            context.get("sql"),
            entry.row.organisation.id,
          ),
        }
      : {}),
    ...(entry.check === undefined ? {} : { check: entry.check }),
    ...(entry.conformance === undefined
      ? {}
      : { conformance: entry.conformance }),
  });

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
  // is not enrolled in it (FR-009, FR-010). Each entry carries its latest check,
  // because a row nobody can date is what the participant table already was.
  routes.get("/events/:slug/systems", async (context) => {
    const event = await requireEvent(context, context.req.param("slug"));
    const visible = await contactsVisible(context);
    const entries = await listEnrolledEntries(context.get("sql"), event.id);
    const systems = await Promise.all(
      entries.map((entry) => renderSystem(context, entry, visible)),
    );
    return context.json({ event: eventDetail(event), systems });
  });

  routes.get("/events/:slug/systems/:id", async (context) => {
    const event = await requireEvent(context, context.req.param("slug"));
    const sql = context.get("sql");
    const row = await findEnrolledSystem(sql, {
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
    const check = await findCheckStatus(sql, row.enrolmentId);
    const conformance = await findLatestHarnessRun(sql, row.enrolmentId);
    const history = await listCheckResults(sql, {
      enrolmentId: row.enrolmentId,
      limit: checkHistoryLength,
    });
    return context.json({
      event: eventDetail(event),
      system: enrolledSystem(row, {
        ...((await contactsVisible(context))
          ? {
              contacts: await listOrganisationContacts(
                sql,
                row.organisation.id,
              ),
            }
          : {}),
        ...(check === undefined ? {} : { check }),
        ...(conformance === undefined ? {} : { conformance }),
        history,
      }),
    });
  });

  return routes;
};
