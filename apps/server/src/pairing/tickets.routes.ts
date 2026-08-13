/**
 * Minting a permission ticket: build, sign, record, show once.
 *
 * This is the second of the two things Muster signs, and the more dangerous of them. A
 * software statement asks an authorization server to create a client; a permission ticket
 * asks a data holder to release a patient's record to whoever presents it. So it is worth
 * stating in full what this route does and why in that order.
 *
 * **It decides nothing.** Whether a ticket may exist at all is `permissionTicketRefusal` in
 * `@muster/core`, and what goes in it is `buildPermissionTicketClaims` beside it: both pure,
 * both exhaustively unit-tested without a database. This module supplies the three things
 * those functions may not have - the clock, the identifier and the signing key - and then
 * does I/O.
 *
 * **The validity is derived, never accepted.** The request carries a `validUntil` and the
 * builder takes the smaller of it and the event's cap, so a member asking for a year gets
 * the event's end plus its grace (FR-033, scenario 5). There is no branch here that could
 * let a longer one through, because there is no branch here at all.
 *
 * **The record is written and the artefact is not.** `data-model.md`: the compact JWT is
 * displayed at mint time and not stored. The row says who minted it, when, for which
 * persona, with which constraints and under which key - which is exactly what FR-033 asks
 * to be recorded - and the JWT exists only in this route's response. Nothing here logs it
 * either (constitution principle IV, FR-036); `tickets.routes.test.ts` asserts both against
 * the whole database and against the console.
 *
 * **The subject is bound by IHI, and the IHI is read rather than accepted.** The request
 * names a persona; the identifier comes from that persona's row and the namespace from the
 * deployment's configuration. A body asserting an IHI could otherwise mint a ticket for a
 * patient nobody curated.
 *
 * **Recording comes before answering.** The row is written before the response is built, so
 * a ticket a member is holding is a ticket Muster has accounted for - the same order the
 * DCR run uses, and for the same reason.
 *
 * Author: John Grimes
 */

import { ticketMintInputSchema } from "@muster/contracts";
import {
  buildPermissionTicketClaims,
  permissionTicketRefusal,
} from "@muster/core";
import { findPersonaById, insertTicket } from "@muster/db";

import { callerId } from "../admin/access.js";
import { namedEvent } from "../admin/access.js";
import { requireApproved } from "../auth/middleware.js";
import { jsonError } from "../http/errors.js";
import { parseBody } from "../http/requestBody.js";
import { loadSigningKey, signClaims } from "../keys/keys.js";

import type { MusterEnvironment, ServerContext } from "../context.js";
import type { MintedTicket } from "@muster/contracts";
import type { PermissionTicketRefusal } from "@muster/core";
import type { Hono } from "hono";

/** The status each refusal to mint answers with. */
const MINT_REFUSAL_STATUS: Readonly<
  Record<PermissionTicketRefusal, 403 | 409 | 422>
> = {
  email_unverified: 403,
  awaiting_approval: 403,
  revoked_member: 403,
  // A conflict with the state of the event, rather than a bad request.
  event_not_open: 409,
  ticket_window_closed: 409,
  unknown_ticket_type: 422,
  no_subject_identifier: 422,
  validity_in_the_past: 422,
  no_scopes: 422,
  not_a_patient_scope: 422,
};

/** What to tell somebody Muster will not mint for. */
const MINT_REFUSAL_DETAIL: Readonly<Record<PermissionTicketRefusal, string>> = {
  email_unverified: "Follow the verification link in your email first",
  awaiting_approval: "A track admin has yet to approve this account",
  revoked_member: "This account's membership has been revoked",
  event_not_open:
    "Muster mints tickets only for open events. This event's records stay readable.",
  ticket_window_closed:
    "This event's grace period has passed, so a ticket minted now would already have expired.",
  unknown_ticket_type:
    "Only the patient self-access ticket type is defined so far",
  no_subject_identifier:
    "This persona carries no IHI, so there is no subject to bind the ticket to",
  validity_in_the_past:
    "That date has already passed, so the ticket would be expired the moment it was signed",
  no_scopes: "Choose at least one scope for the ticket to permit",
  not_a_patient_scope:
    "A patient self-access ticket may only carry patient-compartment scopes: the subject is permitting access to their own record",
};

/**
 * Registers the ticket playground's mint route (FR-033, FR-034).
 *
 * @param router - The API router.
 * @param context - The server's dependencies.
 * @example
 * ```ts
 * registerTicketRoutes(router, context);
 * ```
 */
export function registerTicketRoutes(
  router: Hono<MusterEnvironment>,
  context: ServerContext,
): void {
  /** Mints a ticket for a persona, and shows it once. */
  router.post("/events/:slug/tickets", requireApproved(), async (c) => {
    const event = await namedEvent(context, c, c.req.param("slug"));
    if (event instanceof Response) {
      return event;
    }
    const input = await parseBody(c, ticketMintInputSchema);
    if (input instanceof Response) {
      return input;
    }

    const persona = await findPersonaById(context.db, input.personaId);
    if (persona === undefined || persona.eventId !== event.id) {
      // A persona of another event is answered the same way as one that does not exist:
      // from this event's point of view there is no difference.
      return jsonError(
        c,
        404,
        "not_found",
        "No persona with that id belongs to this event",
      );
    }

    const account = c.get("account");
    const now = context.clock();
    const refusal = permissionTicketRefusal({
      standing: {
        status: account?.status ?? "pending",
        emailVerifiedAt: account?.emailVerifiedAt ?? null,
      },
      eventStatus: event.status,
      eventEndsOn: event.endsOn,
      graceDays: event.graceDays,
      ticketType: input.ticketType,
      ihi: persona.ihi,
      scopes: input.scopes,
      validUntil: input.validUntil,
      now,
    });
    if (refusal !== undefined) {
      return jsonError(
        c,
        MINT_REFUSAL_STATUS[refusal],
        refusal,
        MINT_REFUSAL_DETAIL[refusal],
      );
    }

    const claims = buildPermissionTicketClaims({
      issuer: context.config.publicUrl,
      // The only randomness in the mint, and it is here rather than in `@muster/core`
      // because the pure package may not generate any (constitution principle II).
      jti: crypto.randomUUID(),
      eventSlug: event.slug,
      eventEndsOn: event.endsOn,
      graceDays: event.graceDays,
      ticketType: input.ticketType,
      ihi: persona.ihi,
      ihiSystem: context.config.ihiSystem,
      scopes: input.scopes,
      validUntil: input.validUntil,
      now,
    });
    const signing = await loadSigningKey(
      context.db,
      context.config.masterKey,
      // The tickets key, never the statements one: a vendor who trusts Muster to vouch for
      // a client registration has not agreed to it releasing a patient's record.
      "tickets",
      now,
    );
    const jwt = await signClaims(claims, signing);

    const stored = await insertTicket(context.db, {
      eventId: event.id,
      personaId: persona.id,
      mintedBy: callerId(c),
      jti: claims.jti,
      keyId: signing.kid,
      claims,
      expiresAt: new Date(claims.exp * 1000),
      now,
    });

    const minted: MintedTicket = {
      // Here and nowhere else. Not stored, not logged, not readable again.
      jwt,
      jti: stored.jti,
      keyId: stored.keyId,
      claims,
      expiresAt: stored.expiresAt.toISOString(),
      mintedAt: stored.createdAt.toISOString(),
      personaId: persona.id,
    };
    return c.json(
      { ticket: minted },
      200,
      // A bearer credential is not something a shared cache should keep.
      { "cache-control": "no-store" },
    );
  });
}
