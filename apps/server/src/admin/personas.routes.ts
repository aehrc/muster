import { createPersonaRequestSchema } from "@muster/contracts";
import {
  authorisePersonaCuration,
  patientReadUrl,
  personaCandidates,
  personaFrom,
  personaSearchUrl,
} from "@muster/core";
import {
  findPersonaByIhi,
  insertPersona,
  listLatestPersonaCoverage,
  listPersonas,
} from "@muster/db";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

import { factsFor, refusalError, requireAccount } from "../auth/sessions.ts";
import { listEnrolledEntries, requireEvent } from "../http/lookups.ts";
import {
  enrolledSystem,
  eventDetail,
  persona as personaView,
  personaCoverage as coverageView,
} from "../http/views.ts";
import { fetchJson } from "../outbound/fetchJson.ts";

import type { AppEnvironment } from "../app.ts";
import type { JsonAnswer } from "../outbound/fetchJson.ts";
import type { OutboundRefusal } from "../outbound/outboundFetch.ts";
import type { EventRow } from "@muster/db";
import type { Context } from "hono";

/**
 * Persona curation, and the public coverage grid.
 *
 * The set is anchored to one source server (US7). An admin searches that server
 * and names a patient; Muster reads the patient itself and records what it read.
 * The IHI never arrives in a request body, because a persona whose identifier came
 * from the caller is a persona nothing anchors - and the identifier system it is
 * read under is configuration (`MUSTER_IHI_SYSTEM`), not a constant in this file.
 *
 * Every judgement here belongs to `@muster/core`: eligibility, the search URL, the
 * canonical link. This module does the I/O and the authorisation and nothing else.
 *
 * Three refusals are the substance of it. Curation is a track admin's, and a
 * closed event's set no longer changes. A patient with no IHI is refused with the
 * identifier system named, because "not eligible" alone sends an admin looking for
 * a bug (acceptance scenario 2). And a persona source the guard refuses produces a
 * 422 naming the guard's reason, with no request made - Muster's own refusal, and
 * the admin needs to know it was Muster's rather than the source's (FR-020).
 *
 * The grid is public, and so are the personas: they are test patients on a test
 * server, and a page about published fiction that needed a sign-in would be
 * theatre (SC-006). No contact detail travels with it (FR-007).
 *
 * @author John Grimes
 */

/** How many candidates a search of the source asks for. */
const searchLimit = 20;

/**
 * Finds the event a persona route names, along with its source.
 *
 * @param context - the request being answered
 * @returns the event
 * @throws {HTTPException} 404 when there is no such event
 */
const requireNamedEvent = async (
  context: Context<AppEnvironment>,
): Promise<EventRow> => requireEvent(context, context.req.param("slug") ?? "");

/**
 * Reads the event's configured persona source, or refuses.
 *
 * Deny by default: an event with no source is not searched against a guessed
 * address, and the answer says what is missing (FR-037).
 *
 * @param event - the event whose source is wanted
 * @returns the source's FHIR base URL
 * @throws {HTTPException} 422 when the event names no persona source
 */
const requireSource = (event: EventRow): string => {
  if (event.personaSourceUrl === null) {
    throw new HTTPException(422, {
      message:
        "This event names no persona source, so there is nothing to search. " +
        "Set one on the event first.",
    });
  }
  return event.personaSourceUrl;
};

/**
 * Reads one document from the persona source, through the guard.
 *
 * @param context - the request being answered
 * @param url - the absolute URL to read
 * @returns the answer
 */
const readSource = async (
  context: Context<AppEnvironment>,
  url: string,
): Promise<JsonAnswer> =>
  fetchJson(url, {
    outbound: context.get("config").outbound,
    overrides: context.get("outbound"),
  });

/**
 * Turns the guard's refusal into the answer for it.
 *
 * @param context - the request being answered
 * @param refusal - the failure mode and the reason
 * @returns a 422 naming the refusal, per the HTTP contract
 */
const guardedAnswer = (
  context: Context<AppEnvironment>,
  refusal: OutboundRefusal,
): Response =>
  context.json({ error: refusal.failureMode, detail: refusal.detail }, 422);

/**
 * Decides whether the caller may curate this event's set, or refuses.
 *
 * @param context - the request being answered
 * @param event - the event whose set would change
 * @returns the account, once it is allowed to curate
 * @throws {HTTPException} 401 when anonymous, 403 when not an admin, 409 when
 *   the event is closed
 */
const requireCurator = async (
  context: Context<AppEnvironment>,
  event: EventRow,
) => {
  const account = await requireAccount(context);
  const decision = authorisePersonaCuration({
    member: factsFor(account),
    eventStatus: event.status,
  });
  if (!decision.ok) {
    throw refusalError(decision.refusal);
  }
  return account;
};

/**
 * Builds the persona routes.
 *
 * @returns the routes, to be mounted under `/api`
 * @example
 * ```ts
 * app.route("/api", createPersonaRoutes());
 * ```
 */
export const createPersonaRoutes = (): Hono<AppEnvironment> => {
  const routes = new Hono<AppEnvironment>();

  // Admin: the proxied search of the source, IHI-bearing patients only.
  routes.get("/admin/events/:slug/persona-search", async (context) => {
    const event = await requireNamedEvent(context);
    // Authorised before anything is fetched: a caller who may not curate must not
    // be able to make Muster fetch anything on their behalf.
    await requireCurator(context, event);
    const config = context.get("config");
    const url = personaSearchUrl(requireSource(event), {
      query: context.req.query("q") ?? "",
      ihiSystem: config.ihiSystem,
      limit: searchLimit,
    });

    const answer = await readSource(context, url);
    if (!answer.ok) {
      return guardedAnswer(context, answer);
    }
    if (answer.status < 200 || answer.status > 299) {
      throw new HTTPException(422, {
        message: `The persona source answered the search with HTTP ${String(answer.status)}.`,
      });
    }
    const found = personaCandidates(answer.document, {
      ihiSystem: config.ihiSystem,
    });
    return context.json({
      event: eventDetail(event),
      searched: url,
      candidates: found.candidates,
      ineligible: found.ineligible,
    });
  });

  // Admin: adding one persona. The patient is read from the source; the IHI and
  // the demographics come from what was read (FR-031).
  routes.post("/admin/events/:slug/personas", async (context) => {
    const event = await requireNamedEvent(context);
    await requireCurator(context, event);
    const sql = context.get("sql");
    const config = context.get("config");
    const body = createPersonaRequestSchema.parse(await context.req.json());
    const url = patientReadUrl(requireSource(event), body.patientId);

    const answer = await readSource(context, url);
    if (!answer.ok) {
      return guardedAnswer(context, answer);
    }
    if (answer.status < 200 || answer.status > 299) {
      throw new HTTPException(422, {
        message: `The persona source answered HTTP ${String(answer.status)} for Patient/${body.patientId}.`,
      });
    }
    const decision = personaFrom(answer.document, {
      ihiSystem: config.ihiSystem,
    });
    if (!decision.ok) {
      throw refusalError(decision.refusal);
    }

    const existing = await findPersonaByIhi(sql, {
      eventId: event.id,
      ihi: decision.candidate.ihi,
    });
    if (existing !== undefined) {
      // The IHI is what a persona is, so a second one for it is the same persona:
      // the conflict names it rather than adding a second column to the grid.
      throw refusalError({
        reason: "duplicate_persona",
        detail:
          `This event already has a persona with IHI ${decision.candidate.ihi} ` +
          `(Patient/${existing.patientId}).`,
      });
    }

    const row = await insertPersona(sql, {
      eventId: event.id,
      patientId: decision.candidate.patientId,
      ihi: decision.candidate.ihi,
      display: decision.candidate.display,
      // Recorded rather than derived later: the link is what the persona was
      // curated from, and an event whose source moves later does not rewrite it.
      sourceUrl: url,
    });
    return context.json(
      { event: eventDetail(event), persona: personaView(row) },
      201,
    );
  });

  // Public: the personas and the coverage grid (SC-006).
  routes.get("/events/:slug/personas", async (context) => {
    const event = await requireNamedEvent(context);
    const sql = context.get("sql");
    const [personas, coverage, entries] = await Promise.all([
      listPersonas(sql, event.id),
      listLatestPersonaCoverage(sql, event.id),
      listEnrolledEntries(sql, event.id),
    ]);
    // The grid's columns are the event's server entries: a client holds no
    // patients, so a column for one would be a column of blanks.
    const servers = entries.filter(
      (entry) => entry.row.system.serverProfile != null,
    );
    return context.json({
      event: eventDetail(event),
      personas: personas.map(personaView),
      servers: servers.map((entry) =>
        enrolledSystem(entry.row, {
          ...(entry.check === undefined ? {} : { check: entry.check }),
          ...(entry.conformance === undefined
            ? {}
            : { conformance: entry.conformance }),
        }),
      ),
      coverage: coverage.map(coverageView),
    });
  });

  return routes;
};
