/**
 * The pairing tracker: request, answer, and watch.
 *
 * Four decisions worth stating.
 *
 * **Authority is per side, and it comes from the state machine.** Only the client side's
 * organisation may request; only the server side's may fulfil or decline (FR-014). Rather than
 * writing that twice, both answers ask `transitionRefusal` in `@muster/core`, which knows which
 * side may make which transition - so the console's offered actions, the server's refusal and the
 * timeline's record of who acted all come from one table.
 *
 * **A pairing somebody is not party to answers 404.** Not 403: a 403 would confirm that two named
 * organisations are negotiating, which is a thing anybody with an account could then enumerate.
 * The same reasoning as `admin/access.ts` applies, for the same reason.
 *
 * **Every refusal names something the participant can act on.** A duplicate carries the existing
 * pairing's identifier so the console can link to it (FR-015); an open-registration server is
 * told it needs no pairing at all (FR-016); a closed event says its records stay readable.
 *
 * **The notification is part of the answer.** FR-014 promises the counterparty is told, so a
 * fulfilment whose notification bounced reports `notified: false` rather than plain success
 * (FR-037). The transition stands either way: it is recorded, and re-sending an email is not
 * something the actor could do from here.
 *
 * What is deliberately absent: scope warnings, which need a check to have run (User Story 3), and
 * the trusted-DCR run with its `failed → requested` retry (User Story 5). Both extend this module
 * rather than replacing it.
 *
 * Author: John Grimes
 */

import {
  pairingDeclineSchema,
  pairingFulfilmentSchema,
  pairingRequestSchema,
} from "@muster/contracts";
import {
  pairingRequestRefusal,
  pairingTransition,
  registrationFieldRefusal,
  REQUEST_NOTIFIES,
  transitionRefusal,
} from "@muster/core";
import {
  findPairing,
  findPairingSide,
  insertPairing,
  isOrganisationMember,
  listOrganisationsForAccount,
  listPairingsForOrganisations,
  listPairingTimeline,
  transitionPairing,
} from "@muster/db";

import { notifyPairing } from "./notifications.js";
import { callerId, namedEvent } from "../admin/access.js";
import { requireApproved } from "../auth/middleware.js";
import { jsonError } from "../http/errors.js";
import { parseBody } from "../http/requestBody.js";
import {
  pairingDetailView,
  pairingSides,
  pairingSummaryView,
} from "../http/views.js";

import type { MusterEnvironment, ServerContext } from "../context.js";
import type { PairingSideName } from "@muster/contracts";
import type {
  PairingChange,
  PairingSideRow,
  PairingWithSides,
} from "@muster/db";
import type { Context, Hono } from "hono";

/** The refusals a pairing request can meet, and the status each answers with. */
const REQUEST_REFUSAL_STATUS = {
  // A closed or draft event is a conflict with the state of the event, not a bad request.
  event_not_open: 409,
  cross_event: 422,
  not_a_client: 422,
  not_a_server: 422,
  no_registration_needed: 422,
} as const;

/** What to tell somebody whose request was refused. */
const REQUEST_REFUSAL_DETAIL: Readonly<Record<string, string>> = {
  event_not_open:
    "This event is not accepting pairing requests. Its records stay readable.",
  cross_event:
    "A pairing exists within a single event, and these two systems are enrolled in different events.",
  not_a_client: "The requesting side is not registered as a client",
  not_a_server: "The other side is not registered as a server",
  no_registration_needed:
    "This server's registration mode is open: it needs no registration, so there is no pairing to request.",
  no_client_name: "The registration details need a client name",
  no_launch_url: "The registration details need a launch URL",
  no_redirect_uris: "The registration details need at least one redirect URI",
  no_scopes: "The registration details need at least one scope",
};

/** The pairing named in the path, and the sides the caller holds, or the refusal. */
async function callerPairing(
  context: ServerContext,
  c: Context<MusterEnvironment>,
  pairingId: string,
): Promise<
  | {
      readonly row: PairingWithSides;
      readonly sides: readonly PairingSideName[];
    }
  | Response
> {
  const row = await findPairing(context.db, pairingId);
  const mine =
    row === undefined
      ? []
      : await listOrganisationsForAccount(context.db, callerId(c));
  const sides =
    row === undefined
      ? []
      : pairingSides(
          row,
          mine.map((organisation) => organisation.id),
        );
  if (row === undefined || sides.length === 0) {
    // One answer for both cases. See the module header.
    return jsonError(c, 404, "not_found", "No pairing of yours has that id");
  }
  return { row, sides };
}

/** Whether a system acts as a client, and whether it acts as a server. */
function sideKinds(side: PairingSideRow) {
  return {
    eventId: side.enrolment.eventId,
    isClient: side.system.clientProfile !== null,
    isServer: side.system.serverProfile !== null,
    // Only read when `isServer` holds, which the request rules check first.
    registrationMode: side.system.serverProfile?.registrationMode ?? "manual",
  };
}

/**
 * Registers the pairing tracker's routes.
 *
 * @param router - The API router.
 * @param context - The server's dependencies.
 * @example
 * ```ts
 * registerPairingRoutes(router, context);
 * ```
 */
export function registerPairingRoutes(
  router: Hono<MusterEnvironment>,
  context: ServerContext,
): void {
  /** Everything the caller's organisations are party to, newest activity first. */
  router.get("/pairings", requireApproved(), async (c) => {
    const mine = await listOrganisationsForAccount(context.db, callerId(c));
    const organisationIds = mine.map((organisation) => organisation.id);
    const eventSlug = c.req.query("event");
    const rows = await listPairingsForOrganisations(context.db, {
      organisationIds,
      ...(eventSlug === undefined ? {} : { eventSlug }),
    });
    return c.json({
      pairings: rows.map((row) =>
        pairingSummaryView(row, pairingSides(row, organisationIds)),
      ),
    });
  });

  /** Requests a pairing between one of the caller's clients and an enrolled server. */
  router.post("/pairings", requireApproved(), async (c) => {
    const body = await parseBody(c, pairingRequestSchema);
    if (body instanceof Response) {
      return body;
    }
    const event = await namedEvent(context, c, body.eventSlug);
    if (event instanceof Response) {
      return event;
    }

    const [client, server] = await Promise.all([
      findPairingSide(context.db, body.clientEnrolmentId),
      findPairingSide(context.db, body.serverEnrolmentId),
    ]);
    if (client === undefined || server === undefined) {
      return jsonError(
        c,
        404,
        "not_found",
        "No enrolment has one of those ids in this event",
      );
    }
    if (
      !(await isOrganisationMember(context.db, {
        organisationId: client.organisation.id,
        accountId: callerId(c),
      }))
    ) {
      // The client side is the requester's own: asking a server to register somebody else's app
      // is not a thing a member may do for them.
      return jsonError(
        c,
        404,
        "not_found",
        "No enrolment of yours has that id on the client side",
      );
    }

    const refusal = pairingRequestRefusal({
      eventId: event.id,
      eventStatus: event.status,
      client: sideKinds(client),
      server: sideKinds(server),
    });
    if (refusal !== undefined) {
      return jsonError(
        c,
        REQUEST_REFUSAL_STATUS[refusal],
        refusal,
        REQUEST_REFUSAL_DETAIL[refusal],
      );
    }
    const incomplete = registrationFieldRefusal(body.registrationFields);
    if (incomplete !== undefined) {
      return jsonError(c, 422, incomplete, REQUEST_REFUSAL_DETAIL[incomplete]);
    }

    const written = await insertPairing(context.db, {
      eventId: event.id,
      clientEnrolmentId: client.enrolment.id,
      serverEnrolmentId: server.enrolment.id,
      registrationFields: body.registrationFields,
      actorAccountId: callerId(c),
      actingForOrganisationId: client.organisation.id,
      now: context.clock(),
    });
    if (!written.ok) {
      // The one refusal that carries a third field, so the console can link to the pairing
      // that already exists rather than mention it (FR-015, `pairingConflictSchema`).
      return c.json(
        {
          error: "pairing_exists",
          detail:
            "This client already has a pairing with this server at this event",
          pairingId: written.pairingId,
        },
        409,
      );
    }

    const row: PairingWithSides = {
      pairing: written.pairing,
      event,
      client,
      server,
    };
    const notified = await notifyPairing(
      context,
      row,
      "requested",
      REQUEST_NOTIFIES,
    );
    return c.json(
      { pairing: await detail(context, row, ["client"]), notified },
      201,
    );
  });

  /** One pairing, with the timeline both organisations read. */
  router.get("/pairings/:id", requireApproved(), async (c) => {
    const found = await callerPairing(context, c, c.req.param("id"));
    if (found instanceof Response) {
      return found;
    }
    return c.json({
      pairing: await detail(context, found.row, found.sides),
    });
  });

  /** Records the identifier the server issued (FR-014, scenario 2). */
  router.post("/pairings/:id/fulfil", requireApproved(), async (c) => {
    const body = await parseBody(c, pairingFulfilmentSchema);
    if (body instanceof Response) {
      return body;
    }
    return await answer(context, c, c.req.param("id"), {
      to: "fulfilled",
      clientId: body.clientId,
    });
  });

  /** Declines the request, with the reason the app owner needs (FR-014, scenario 3). */
  router.post("/pairings/:id/decline", requireApproved(), async (c) => {
    const body = await parseBody(c, pairingDeclineSchema);
    if (body instanceof Response) {
      return body;
    }
    return await answer(context, c, c.req.param("id"), {
      to: "declined",
      reason: body.reason,
    });
  });
}

/** A pairing in full, with its history read in one further query. */
async function detail(
  context: ServerContext,
  row: PairingWithSides,
  sides: readonly PairingSideName[],
) {
  return pairingDetailView(
    row,
    sides,
    await listPairingTimeline(context.db, row.pairing.id),
  );
}

/**
 * Answers a request: the shared half of fulfilling and declining.
 *
 * Written once because the two differ in the state they ask for and in what they record, and in
 * nothing else - and the half that would drift between two copies is the notification.
 */
async function answer(
  context: ServerContext,
  c: Context<MusterEnvironment>,
  pairingId: string,
  change: PairingChange,
): Promise<Response> {
  const found = await callerPairing(context, c, pairingId);
  if (found instanceof Response) {
    return found;
  }
  const { row, sides } = found;
  const from = row.pairing.state;

  const refusal = transitionRefusal(from, change.to, sides);
  if (refusal === "wrong_side") {
    return jsonError(
      c,
      403,
      refusal,
      `Only ${pairingTransition(from, change.to)?.by === "client" ? "the app" : "the server"} owner's organisation may do that`,
    );
  }
  if (refusal !== undefined) {
    return jsonError(
      c,
      409,
      refusal,
      `This pairing is ${from} and cannot become ${change.to}`,
    );
  }
  const transition = pairingTransition(from, change.to);
  if (transition === undefined) {
    // Unreachable: `transitionRefusal` already admitted it. Narrowed rather than asserted.
    return jsonError(c, 409, "illegal_transition");
  }

  const moved = await transitionPairing(context.db, {
    pairingId: row.pairing.id,
    from,
    change,
    actorAccountId: callerId(c),
    actingForOrganisationId:
      transition.by === "client"
        ? row.client.organisation.id
        : row.server.organisation.id,
    now: context.clock(),
  });
  if (!moved.ok) {
    // Somebody answered between the read and the write. The state it moved to is whatever they
    // recorded, and this caller is told rather than overwriting it.
    return moved.reason === "not-found"
      ? jsonError(c, 404, "not_found", "No pairing of yours has that id")
      : jsonError(
          c,
          409,
          "state_changed",
          "Somebody in your organisation answered this pairing first",
        );
  }

  const updated: PairingWithSides = { ...row, pairing: moved.pairing };
  const notified = await notifyPairing(
    context,
    updated,
    change.to === "fulfilled" ? "fulfilled" : "declined",
    transition.notifies,
  );
  return c.json({ pairing: await detail(context, updated, sides), notified });
}
