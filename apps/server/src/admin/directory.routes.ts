/**
 * Organisations, their members, their systems, their enrolments, and an admin's events.
 *
 * Four decisions worth stating.
 *
 * **An invitation names an approved account, and refuses anything else.** FR-005 says
 * organisations invite *approved* members, which means an invitation is not a way to create an
 * account: an address nobody has registered is a 404, and a pending or revoked account is a
 * 409 that says which. Otherwise an organisation could accumulate members who cannot act and
 * nobody would know why.
 *
 * **The last member may leave.** The spec's answer to an organisation with no members is an
 * admin reassignment, not a refusal - its systems stay enrolled and become unmanageable, which
 * is worse than having a member and much better than losing the entries mid-event.
 *
 * **Enrolling twice is confirming.** A second enrolment moves the confirmation forward rather
 * than being refused as a duplicate. That is what makes returning to a second event a minute's
 * work (SC-008), and it is the enrolment record's whole purpose.
 *
 * **An event's status moves one way.** `draft -> open -> closed`, decided by
 * `canChangeEventStatus` in `@muster/core`. Re-opening is refused because closing lapses open
 * pairings and stops minting, and nothing undoes those.
 *
 * Author: John Grimes
 */

import {
  enrolmentInputSchema,
  eventInputSchema,
  eventPatchSchema,
  organisationInputSchema,
  organisationInviteSchema,
  systemInputSchema,
} from "@muster/contracts";
import { canChangeEventStatus, foldEmail } from "@muster/core";
import {
  addOrganisationMember,
  findAccountByEmail,
  insertEvent,
  insertOrganisationWithFirstMember,
  insertSystem,
  isUniqueViolation,
  listOrganisationMembers,
  listOrganisationsForAccount,
  removeOrganisationMember,
  updateEvent,
  updateSystem,
  upsertEnrolment,
} from "@muster/db";

import {
  callerId,
  callerOrganisation,
  callerSystem,
  namedEvent,
  namedOrganisation,
  organisationResponse,
} from "./access.js";
import { requireAdmin, requireApproved } from "../auth/middleware.js";
import { jsonError } from "../http/errors.js";
import { parseBody } from "../http/requestBody.js";
import {
  enrolmentConfirmation,
  eventDetailView,
  organisationContactsView,
  organisationSystemView,
} from "../http/views.js";

import type { MusterEnvironment, ServerContext } from "../context.js";
import type { OrganisationRow } from "@muster/db";
import type { Context, Hono } from "hono";
import type { output, ZodType } from "zod";

/**
 * Turns an enrolment refusal into the envelope.
 *
 * The tags are named in the detail rather than counted, because the participant has to know
 * which of the ones they chose the event does not define.
 */
function enrolmentRefusal(
  c: Context<MusterEnvironment>,
  refusal: { readonly reason: string; readonly tags?: readonly string[] },
): Response {
  if (refusal.reason === "event-not-open") {
    return jsonError(
      c,
      409,
      "event_not_open",
      "This event is not accepting enrolments. Its records stay readable.",
    );
  }
  return jsonError(
    c,
    422,
    "unknown_tags",
    `This event does not define ${(refusal.tags ?? []).join(", ")}`,
  );
}

/**
 * The organisation a request names, and its validated body.
 *
 * Both halves or a refusal, written once: two routes resolve the caller's organisation and then
 * parse a body, and a copy of that preamble is a copy of the 404-rather-than-403 decision in
 * `./access.ts` waiting to be got wrong.
 */
async function organisationRequest<S extends ZodType>(
  context: ServerContext,
  c: Context<MusterEnvironment>,
  schema: S,
): Promise<
  | { readonly organisation: OrganisationRow; readonly body: output<S> }
  | Response
> {
  const organisation = await callerOrganisation(
    context,
    c,
    c.req.param("id") ?? "",
  );
  if (organisation instanceof Response) {
    return organisation;
  }
  const body = await parseBody(c, schema);
  if (body instanceof Response) {
    return body;
  }
  return { organisation, body };
}

/**
 * Registers the organisation, system, enrolment and event-administration routes.
 *
 * @param router - The API router.
 * @param context - The server's dependencies.
 * @example
 * ```ts
 * registerDirectoryRoutes(router, context);
 * ```
 */
export function registerDirectoryRoutes(
  router: Hono<MusterEnvironment>,
  context: ServerContext,
): void {
  /** The organisations the caller belongs to, with their members and systems. */
  router.get("/organisations", requireApproved(), async (c) => {
    const owned = await listOrganisationsForAccount(context.db, callerId(c));
    const organisations = await Promise.all(
      owned.map(
        async (organisation) =>
          await organisationResponse(context, organisation),
      ),
    );
    return c.json({ organisations });
  });

  /** Creates an organisation, with the caller as its first member. */
  router.post("/organisations", requireApproved(), async (c) => {
    const body = await parseBody(c, organisationInputSchema);
    if (body instanceof Response) {
      return body;
    }
    const created = await insertOrganisationWithFirstMember(context.db, {
      name: body.name,
      accountId: callerId(c),
    });
    return c.json(
      { organisation: await organisationResponse(context, created) },
      201,
    );
  });

  /** Invites an already-approved account into an organisation. */
  router.post("/organisations/:id/members", requireApproved(), async (c) => {
    const asked = await organisationRequest(
      context,
      c,
      organisationInviteSchema,
    );
    if (asked instanceof Response) {
      return asked;
    }
    const { organisation, body } = asked;

    const invitee = await findAccountByEmail(context.db, foldEmail(body.email));
    if (invitee === undefined) {
      return jsonError(
        c,
        404,
        "not_found",
        "No Muster account has that address. Ask them to sign up first.",
      );
    }
    if (invitee.status !== "approved" || invitee.emailVerifiedAt === null) {
      return jsonError(
        c,
        409,
        "invitee_not_approved",
        "That account is not yet an approved member, so it cannot manage an organisation's systems.",
      );
    }

    await addOrganisationMember(context.db, {
      organisationId: organisation.id,
      accountId: invitee.id,
    });
    // The same answer whether the invitation was new or repeated: what matters is who
    // belongs afterwards.
    return c.json({
      organisation: await organisationResponse(context, organisation),
    });
  });

  /** Removes a member, or leaves. */
  router.delete(
    "/organisations/:id/members/:accountId",
    requireApproved(),
    async (c) => {
      const organisation = await callerOrganisation(
        context,
        c,
        c.req.param("id"),
      );
      if (organisation instanceof Response) {
        return organisation;
      }
      const removed = await removeOrganisationMember(context.db, {
        organisationId: organisation.id,
        accountId: c.req.param("accountId"),
      });
      if (!removed) {
        return jsonError(
          c,
          404,
          "not_found",
          "That account is not a member of this organisation",
        );
      }
      return c.body(null, 204);
    },
  );

  /** An organisation's contact details. Any approved member may read them (FR-007). */
  router.get("/organisations/:id/contacts", requireApproved(), async (c) => {
    const organisation = await namedOrganisation(context, c, c.req.param("id"));
    if (organisation instanceof Response) {
      return organisation;
    }
    const members = await listOrganisationMembers(context.db, organisation.id);
    return c.json(organisationContactsView(organisation, members));
  });

  /** Creates a system. */
  router.post("/organisations/:id/systems", requireApproved(), async (c) => {
    const asked = await organisationRequest(context, c, systemInputSchema);
    if (asked instanceof Response) {
      return asked;
    }
    const { organisation, body } = asked;
    const created = await insertSystem(context.db, {
      organisationId: organisation.id,
      system: body,
    });
    return c.json({ system: organisationSystemView(created, []) }, 201);
  });

  /** Replaces a system's editable fields. */
  router.patch("/systems/:id", requireApproved(), async (c) => {
    const system = await callerSystem(context, c, c.req.param("id"));
    if (system instanceof Response) {
      return system;
    }
    const body = await parseBody(c, systemInputSchema);
    if (body instanceof Response) {
      return body;
    }
    const edited = await updateSystem(context.db, {
      systemId: system.id,
      system: body,
      now: context.clock(),
    });
    if (edited === undefined) {
      return jsonError(c, 404, "not_found", "No system of yours has that id");
    }
    return c.json({ system: organisationSystemView(edited, []) });
  });

  /** Enrols one of the caller's systems in an event, confirming its details are current. */
  router.post("/events/:slug/enrolments", requireApproved(), async (c) => {
    const event = await namedEvent(context, c, c.req.param("slug"));
    if (event instanceof Response) {
      return event;
    }
    const body = await parseBody(c, enrolmentInputSchema);
    if (body instanceof Response) {
      return body;
    }
    const system = await callerSystem(context, c, body.systemId);
    if (system instanceof Response) {
      return system;
    }

    const written = await upsertEnrolment(context.db, {
      event,
      systemId: system.id,
      tags: body.tags,
      confirmedBy: callerId(c),
      confirmedAt: context.clock(),
    });
    if (!written.ok) {
      return enrolmentRefusal(c, written);
    }
    return c.json(
      {
        enrolment: enrolmentConfirmation(written.enrolment),
        event: eventDetailView(event),
      },
      201,
    );
  });

  /** Creates an event. It starts as a draft; opening it is a separate edit. */
  router.post("/admin/events", requireAdmin(), async (c) => {
    const body = await parseBody(c, eventInputSchema);
    if (body instanceof Response) {
      return body;
    }
    try {
      const created = await insertEvent(context.db, body);
      return c.json({ event: eventDetailView(created) }, 201);
    } catch (error) {
      if (isUniqueViolation(error, "event_slug_unique")) {
        return jsonError(
          c,
          409,
          "slug_taken",
          "An event already uses that slug, and every public address for an event is built from it.",
        );
      }
      throw error;
    }
  });

  /** Edits an event, including opening and closing it. */
  router.patch("/admin/events/:slug", requireAdmin(), async (c) => {
    const event = await namedEvent(context, c, c.req.param("slug"));
    if (event instanceof Response) {
      return event;
    }
    const body = await parseBody(c, eventPatchSchema);
    if (body instanceof Response) {
      return body;
    }
    if (
      body.status !== undefined &&
      !canChangeEventStatus(event.status, body.status)
    ) {
      return jsonError(
        c,
        409,
        "illegal_transition",
        `An event cannot go from ${event.status} to ${body.status}`,
      );
    }

    const edited = await updateEvent(context.db, {
      slug: event.slug,
      patch: body,
      now: context.clock(),
    });
    if (edited === undefined) {
      return jsonError(c, 404, "not_found", "No event has that slug");
    }
    return c.json({ event: eventDetailView(edited) });
  });
}
