import {
  addMemberRequestSchema,
  createEnrolmentRequestSchema,
  createEventRequestSchema,
  createOrganisationRequestSchema,
  createSystemRequestSchema,
  updateEventRequestSchema,
  updateSystemRequestSchema,
} from "@muster/contracts";
import {
  authoriseEventOpen,
  authoriseParticipantEndpoints,
} from "@muster/core";
import {
  deleteOrganisationMember,
  findEnrolment,
  findOrganisationById,
  insertEnrolment,
  insertEvent,
  insertOrganisation,
  insertOrganisationMember,
  insertSystem,
  isCheckViolation,
  isUniqueViolation,
  listOrganisationContacts,
  listSystemsByOrganisation,
  reconfirmEnrolment,
  updateEvent,
  updateSystem,
} from "@muster/db";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

import { parseBody } from "../auth/routes.ts";
import {
  refusalError,
  requireAdmin,
  requireGrantableAccount,
  requireMember,
  requireWriter,
} from "../auth/sessions.ts";
import { requireEvent, requireSystem } from "../http/lookups.ts";
import { eventDetail, systemRecord } from "../http/views.ts";
import { invitationMessage } from "../mail/messages.ts";
import { lapseOpenPairings } from "../pairing/lapsing.ts";

import type { AppEnvironment } from "../app.ts";
import type { EnrolmentView, ServerProfile } from "@muster/contracts";
import type { EnrolmentRow, EventRow } from "@muster/db";
import type { Context } from "hono";

/**
 * Organisations, their members and systems, events, and enrolment.
 *
 * Every route here changes something, so every route starts by asking the rules
 * whether the caller may: approved and verified for anything at all, a member of
 * the owning organisation for anything an organisation owns, an admin for
 * anything belonging to an event. Nothing is inferred from the shape of the
 * request.
 *
 * The two rules the schema holds - a system has at least one profile, an
 * enrolment's tags come from its event's set - are answered as a 400 and a 422
 * naming the rule, so a member learns what to change rather than seeing a failed
 * write.
 *
 * One rule the schema cannot hold is applied here as well: an endpoint Muster
 * will fetch must be https unless its host is named in
 * `MUSTER_OUTBOUND_ALLOWLIST`. It cannot live in the schema because the schema
 * also reads stored entries back, where refusing would make a recorded entry
 * uncheckable, and because the answer depends on configuration. These are the
 * only routes that record such an endpoint, so this is the whole boundary.
 *
 * @author John Grimes
 */

/**
 * Refuses an endpoint Muster may not fetch, or does nothing.
 *
 * @param context - the request being answered
 * @param endpoints - the endpoints by the field name each arrived under
 * @throws {HTTPException} 422 naming the field, when the endpoint is plaintext
 *   and its host is not allowlisted
 */
const requireFetchableEndpoints = (
  context: Context<AppEnvironment>,
  endpoints: Readonly<Record<string, string | null | undefined>>,
): void => {
  const decision = authoriseParticipantEndpoints(
    endpoints,
    context.get("config").outbound.allowedHosts,
  );
  if (!decision.ok) {
    throw refusalError(decision.refusal);
  }
};

/**
 * Reads the endpoints of a server profile, by field name.
 *
 * @param profile - the profile as the request states it, or null
 * @returns the endpoints to check, empty for a system with no server side
 */
const serverProfileEndpoints = (
  profile: ServerProfile | null | undefined,
): Readonly<Record<string, string | null | undefined>> =>
  profile == null
    ? {}
    : {
        fhirBaseUrl: profile.fhirBaseUrl,
        authorizationEndpoint: profile.authorizationEndpoint,
        tokenEndpoint: profile.tokenEndpoint,
        registrationEndpoint: profile.registrationEndpoint,
      };

/**
 * Renders an enrolment for the console.
 *
 * @param enrolment - the enrolment as stored
 * @param event - the event it belongs to
 * @returns the enrolment view
 */
const enrolmentView = (
  enrolment: EnrolmentRow,
  event: EventRow,
): EnrolmentView => ({
  id: enrolment.id,
  eventSlug: event.slug,
  systemId: enrolment.systemId,
  tags: [...enrolment.tags],
  confirmedAt: enrolment.confirmedAt.toISOString(),
});

/**
 * Builds the organisation, system, event and enrolment routes.
 *
 * @returns the routes, to be mounted under `/api`
 * @example
 * ```ts
 * app.route("/api", createDirectoryRoutes());
 * ```
 */
export const createDirectoryRoutes = (): Hono<AppEnvironment> => {
  const routes = new Hono<AppEnvironment>();

  // FR-005: the creator is the organisation's first member, so an organisation
  // never arrives with nobody able to manage it.
  routes.post("/organisations", async (context) => {
    const body = await parseBody(context, createOrganisationRequestSchema);
    const account = await requireWriter(context);
    const sql = context.get("sql");
    const organisation = await insertOrganisation(sql, { name: body.name });
    await insertOrganisationMember(sql, {
      organisationId: organisation.id,
      accountId: account.id,
    });
    return context.json({ organisation }, 201);
  });

  // FR-007: the members-only feed. Nothing it returns reaches an anonymous
  // caller, which is why it is a route of its own rather than a field.
  routes.get("/organisations/:id/contacts", async (context) => {
    const organisationId = context.req.param("id");
    await requireMember(context, organisationId);
    return context.json({
      contacts: await listOrganisationContacts(
        context.get("sql"),
        organisationId,
      ),
    });
  });

  // An organisation's own systems, as its members manage them: the full record
  // including both profiles, which the event view does not carry because a system
  // is only published through an enrolment.
  routes.get("/organisations/:id/systems", async (context) => {
    const organisationId = context.req.param("id");
    await requireMember(context, organisationId);
    const systems = await listSystemsByOrganisation(
      context.get("sql"),
      organisationId,
    );
    return context.json({ systems: systems.map(systemRecord) });
  });

  routes.post("/organisations/:id/members", async (context) => {
    const organisationId = context.req.param("id");
    const body = await parseBody(context, addMemberRequestSchema);
    await requireMember(context, organisationId);
    const sql = context.get("sql");
    const organisation = await findOrganisationById(sql, organisationId);
    if (organisation === undefined) {
      throw new HTTPException(404, { message: "No such organisation." });
    }
    const invited = await requireGrantableAccount(context, body.email);
    await insertOrganisationMember(sql, {
      organisationId,
      accountId: invited.id,
    });
    await context
      .get("mail")
      .send(
        invitationMessage(
          context.get("config"),
          invited.email,
          organisation.name,
        ),
      );
    return context.json(
      { contacts: await listOrganisationContacts(sql, organisationId) },
      201,
    );
  });

  // A member leaves, or is removed by another member. The organisation and its
  // systems stay: the spec's edge case is that it becomes unmanageable until an
  // admin reassigns it, not that anything disappears.
  routes.delete("/organisations/:id/members/:accountId", async (context) => {
    const organisationId = context.req.param("id");
    await requireMember(context, organisationId);
    const sql = context.get("sql");
    const removed = await deleteOrganisationMember(sql, {
      organisationId,
      accountId: context.req.param("accountId"),
    });
    if (!removed) {
      throw new HTTPException(404, {
        message: "That account is not a member of this organisation.",
      });
    }
    return context.json({
      contacts: await listOrganisationContacts(sql, organisationId),
    });
  });

  routes.post("/organisations/:id/systems", async (context) => {
    const organisationId = context.req.param("id");
    const body = await parseBody(context, createSystemRequestSchema);
    await requireMember(context, organisationId);
    requireFetchableEndpoints(
      context,
      serverProfileEndpoints(body.serverProfile),
    );
    const system = await insertSystem(context.get("sql"), {
      organisationId,
      name: body.name,
      description: body.description,
      serverProfile: body.serverProfile ?? null,
      clientProfile: body.clientProfile ?? null,
    });
    return context.json({ system: systemRecord(system) }, 201);
  });

  routes.patch("/systems/:id", async (context) => {
    const body = await parseBody(context, updateSystemRequestSchema);
    const existing = await requireSystem(context, context.req.param("id"));
    await requireMember(context, existing.organisationId);
    requireFetchableEndpoints(
      context,
      serverProfileEndpoints(body.serverProfile),
    );
    const updated = await updateSystem(context.get("sql"), existing.id, {
      ...(body.name === undefined ? {} : { name: body.name }),
      ...(body.description === undefined
        ? {}
        : { description: body.description }),
      ...(body.serverProfile === undefined
        ? {}
        : { serverProfile: body.serverProfile ?? null }),
      ...(body.clientProfile === undefined
        ? {}
        : { clientProfile: body.clientProfile ?? null }),
    });
    if (updated === undefined) {
      throw new HTTPException(404, { message: "No such system." });
    }
    return context.json({ system: systemRecord(updated) });
  });

  // FR-009: enrolment is a member's statement that the details are current, in
  // an open event, tagged from that event's own set.
  routes.post("/events/:slug/enrolments", async (context) => {
    const body = await parseBody(context, createEnrolmentRequestSchema);
    const sql = context.get("sql");
    const event = await requireEvent(context, context.req.param("slug"));
    const openness = authoriseEventOpen(event.status);
    if (!openness.ok) {
      throw refusalError(openness.refusal);
    }
    const system = await requireSystem(context, body.systemId);
    const { account } = await requireMember(context, system.organisationId);
    const existing = await findEnrolment(sql, {
      eventId: event.id,
      systemId: system.id,
    });

    try {
      // Enrolling a system that is already enrolled is a fresh confirmation,
      // which is what a returning participant does (SC-008).
      const enrolment =
        existing === undefined
          ? await insertEnrolment(sql, {
              eventId: event.id,
              systemId: system.id,
              tags: body.tags,
              confirmedBy: account.id,
            })
          : await reconfirmEnrolment(sql, {
              id: existing.id,
              tags: body.tags,
              confirmedBy: account.id,
            });
      if (enrolment === undefined) {
        throw new HTTPException(404, { message: "No such enrolment." });
      }
      return context.json(
        { enrolment: enrolmentView(enrolment, event) },
        existing === undefined ? 201 : 200,
      );
    } catch (cause) {
      if (isCheckViolation(cause)) {
        throw new HTTPException(422, {
          message: `Those tags are not among the event's capability tags: ${event.capabilityTags.join(", ")}`,
        });
      }
      if (isUniqueViolation(cause)) {
        throw new HTTPException(409, {
          message: "That system is already enrolled in this event.",
        });
      }
      throw cause;
    }
  });

  // FR-008: an event's dates and capability tags are an admin's to set.
  routes.post("/admin/events", async (context) => {
    const body = await parseBody(context, createEventRequestSchema);
    await requireAdmin(context);
    requireFetchableEndpoints(context, {
      personaSourceUrl: body.personaSourceUrl,
    });
    try {
      const event = await insertEvent(context.get("sql"), {
        slug: body.slug,
        name: body.name,
        startsOn: body.startsOn,
        endsOn: body.endsOn,
        capabilityTags: body.capabilityTags,
        ...(body.status === undefined ? {} : { status: body.status }),
        ...(body.personaSourceUrl == null
          ? {}
          : { personaSourceUrl: body.personaSourceUrl }),
        ...(body.graceDays === undefined ? {} : { graceDays: body.graceDays }),
      });
      return context.json({ event: eventDetail(event) }, 201);
    } catch (cause) {
      if (isUniqueViolation(cause)) {
        throw new HTTPException(409, {
          message: "An event already exists with that slug.",
        });
      }
      throw cause;
    }
  });

  // Opening and closing an event is this route: FR-011's consequences follow
  // from the status, which every write consults.
  routes.patch("/admin/events/:slug", async (context) => {
    const body = await parseBody(context, updateEventRequestSchema);
    const admin = await requireAdmin(context);
    requireFetchableEndpoints(context, {
      personaSourceUrl: body.personaSourceUrl,
    });
    const existing = await requireEvent(context, context.req.param("slug"));
    const event = await updateEvent(
      context.get("sql"),
      context.req.param("slug"),
      {
        ...(body.name === undefined ? {} : { name: body.name }),
        ...(body.startsOn === undefined ? {} : { startsOn: body.startsOn }),
        ...(body.endsOn === undefined ? {} : { endsOn: body.endsOn }),
        ...(body.status === undefined ? {} : { status: body.status }),
        ...(body.capabilityTags === undefined
          ? {}
          : { capabilityTags: body.capabilityTags }),
        ...(body.personaSourceUrl === undefined
          ? {}
          : { personaSourceUrl: body.personaSourceUrl ?? null }),
        ...(body.graceDays === undefined ? {} : { graceDays: body.graceDays }),
      },
    );
    if (event === undefined) {
      throw new HTTPException(404, { message: "No such event." });
    }

    // FR-011: closing an event lapses the pairings still open in it. Done here,
    // on the transition into `closed`, so that editing a closed event again does
    // not append a second lapse to anybody's timeline.
    if (event.status === "closed" && existing.status !== "closed") {
      await lapseOpenPairings(context.get("sql"), {
        eventId: event.id,
        eventStatus: event.status,
        actorAccountId: admin.id,
      });
    }

    return context.json({ event: eventDetail(event) });
  });

  return routes;
};
