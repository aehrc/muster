/*
 * Copyright © 2026 Commonwealth Scientific and Industrial Research Organisation
 * (CSIRO) ABN 41 687 119 230. Licensed under the Apache License, Version 2.0.
 */

import {
  createTicketRequestSchema,
  ticketClaimsSchema,
} from "@muster/contracts";
import { mintTicket } from "@muster/core";
import { findPersonaById, insertTicket } from "@muster/db";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

import { parseBody } from "../auth/routes.ts";
import { factsFor, refusalError, requireWriter } from "../auth/sessions.ts";
import { requireEvent } from "../http/lookups.ts";
import { ticketRecord } from "../http/views.ts";
import { activeSigningKey, signJws } from "../keys/keys.ts";

import type { AppEnvironment } from "../app.ts";
import type { TicketResponse } from "@muster/contracts";

/**
 * The permission ticket playground: minting one, and recording that it happened
 * (US8).
 *
 * This is the largest thing Muster vouches for. A software statement says "this
 * client is who it says it is"; a permission ticket says "the holder of this token
 * may read this patient's record", to a server that has never met the holder. So
 * the route is deny by default in the same way and for stronger reasons: the
 * account must be approved, verified and unrevoked; the event must be open; the
 * persona must belong to that event; the constraints must actually constrain
 * something; and the validity is capped at the event's end plus its grace days.
 * Every one of those decisions is made in `@muster/core`, not here.
 *
 * The artefact is handed over exactly once. It is answered to the member who minted
 * it, and it is not stored, not logged and not retrievable - there is no column for
 * it and no route that would serve it. What is recorded is the claims, which is
 * what makes the mint auditable without making the token replayable by anybody who
 * reaches the database.
 *
 * Nothing here touches the network. A ticket is presented by the member, to a data
 * holder of their choosing, which is why the playground is a playground.
 *
 * @author John Grimes
 */

/**
 * Builds the permission ticket routes.
 *
 * @returns the routes, to be mounted under `/api`
 * @example
 * ```ts
 * app.route("/api", createTicketRoutes());
 * ```
 */
export const createTicketRoutes = (): Hono<AppEnvironment> => {
  const routes = new Hono<AppEnvironment>();

  // FR-033: the mint. One route, because the ticket is the whole feature: what is
  // minted is displayed and recorded, and nothing else happens to it.
  routes.post("/events/:slug/tickets", async (context) => {
    const account = await requireWriter(context);
    const event = await requireEvent(context, context.req.param("slug"));
    const sql = context.get("sql");
    const config = context.get("config");
    const body = await parseBody(context, createTicketRequestSchema);

    const persona = await findPersonaById(sql, body.personaId);
    if (persona === undefined) {
      throw new HTTPException(404, { message: "No such persona." });
    }

    const minted = mintTicket({
      issuer: config.publicUrl,
      member: factsFor(account),
      eventStatus: event.status,
      eventSlug: event.slug,
      eventEndsOn: event.endsOn,
      graceDays: event.graceDays,
      // The persona is the subject, so a persona from another event's set is not
      // this event's test patient and cannot be named by its tickets.
      personaInEvent: persona.eventId === event.id,
      ticketType: body.ticketType,
      ihiSystem: config.ihiSystem,
      ihi: persona.ihi,
      scopes: body.scopes,
      validUntil:
        body.validUntil === undefined ? null : new Date(body.validUntil),
      jti: crypto.randomUUID(),
      now: new Date(),
    });
    if (!minted.ok) {
      throw refusalError(minted.refusal);
    }

    const key = await activeSigningKey(sql, {
      purpose: "tickets",
      masterKey: config.masterKey,
    });
    // Parsed against the contract before it is signed and before it is stored, so
    // the artefact a data holder validates and the row Muster keeps are both the
    // shape the published profile describes.
    const claims = ticketClaimsSchema.parse(minted.claims);
    const jwt = await signJws(key, { ...claims });
    const row = await insertTicket(sql, {
      eventId: event.id,
      personaId: persona.id,
      mintedBy: account.id,
      jti: claims.jti,
      keyId: key.kid,
      claims,
      expiresAt: minted.expiresAt,
    });

    return context.json(
      { jwt, ticket: ticketRecord(row) } satisfies TicketResponse,
      201,
    );
  });

  return routes;
};
