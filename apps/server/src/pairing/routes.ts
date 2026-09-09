/*
 * Copyright © 2026 Commonwealth Scientific and Industrial Research Organisation
 * (CSIRO) ABN 41 687 119 230. Licensed under the Apache License, Version 2.0.
 */

import {
  createPairingRequestSchema,
  declinePairingRequestSchema,
  discoveryHighlightsSchema,
  fulfilPairingRequestSchema,
  registrationFieldsSchema,
  serverProfileSchema,
} from "@muster/contracts";
import {
  applyPairingAction,
  authoriseHandFulfilment,
  authorisePairingRequest,
  normaliseRegistrationFields,
  scopeWarning,
} from "@muster/core";
import {
  findCheckStatus,
  findEnrolmentById,
  findLatestStatementForPairing,
  findPairingByKey,
  findPairingRecord,
  findSystemById,
  insertPairing,
  insertPairingEvent,
  isUniqueViolation,
  listMembershipsForAccount,
  listOrganisationContacts,
  listPairingEvents,
  listPairingRecordsForOrganisations,
  updatePairingState,
} from "@muster/db";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

import { pairingDetail, pairingSides, pairingSummary } from "./views.ts";
import { parseBody } from "../auth/routes.ts";
import { refusalError, requireWriter } from "../auth/sessions.ts";
import { requireEvent, requirePairingRecord } from "../http/lookups.ts";
import {
  pairingDeclinedMessage,
  pairingFulfilledMessage,
  pairingRequestedMessage,
} from "../mail/messages.ts";

import type { AppEnvironment } from "../app.ts";
import type { PairingNotice } from "../mail/messages.ts";
import type { MailMessage } from "../mail/transport.ts";
import type {
  PairingConflict,
  PairingDetail,
  PairingMutationResponse,
  PairingSide,
  ScopeWarning,
} from "@muster/contracts";
import type {
  AccountRow,
  EnrolmentRow,
  PairingRecordRow,
  SystemRow,
} from "@muster/db";
import type { Context } from "hono";

/**
 * The pairing tracker: request, fulfil, decline, and read.
 *
 * This is the workflow that replaces the email round-trip, so the rules about who
 * may do what are the substance of it. The client's organisation asks; the
 * server's organisation answers by issuing an identifier or declining with a
 * reason; neither can take the other's action, and a member of both organisations
 * can take either - with the timeline recording which organisation each action was
 * taken for.
 *
 * No handler decides a transition for itself. Each asks the state machine in
 * `@muster/core`, which is also what the event-closing routine asks, so a pairing
 * cannot reach a state by one path that it could not reach by another.
 *
 * @author John Grimes
 */

/** What a party asked to do to a pairing. */
type PairingMove =
  | { readonly action: "fulfil"; readonly clientId: string }
  | { readonly action: "decline"; readonly reason: string };

/** One side of a proposed pairing: its enrolment and the system enrolled. */
type ProposedSide = {
  /** the enrolment named in the request */
  readonly enrolment: EnrolmentRow;
  /** the system it enrolled */
  readonly system: SystemRow;
};

/**
 * Reads what a notification needs to say about a pairing.
 *
 * @param record - the pairing and its two sides
 * @returns the notice
 */
const noticeFor = (record: PairingRecordRow): PairingNotice => ({
  pairingId: record.pairing.id,
  eventName: record.eventName,
  clientName: record.client.systemName,
  serverName: record.server.systemName,
});

/**
 * Finds a named enrolment and the system it enrolled, or refuses.
 *
 * A system with no client profile cannot be the client side of a pairing, and one
 * with no server profile cannot be the server side, so both are refused here with
 * the field set naming which side was wrong.
 *
 * @param context - the request being answered
 * @param enrolmentId - the enrolment named in the request
 * @param side - which side of the pairing it is to be
 * @returns the enrolment and its system
 * @throws {HTTPException} 422 when there is no such enrolment, or the system it
 *   enrolled is not of the kind that side needs
 */
const requireSide = async (
  context: Context<AppEnvironment>,
  enrolmentId: string,
  side: PairingSide,
): Promise<ProposedSide> => {
  const sql = context.get("sql");
  const enrolment = await findEnrolmentById(sql, enrolmentId);
  if (enrolment === undefined) {
    throw new HTTPException(422, {
      message: `There is no such ${side} enrolment.`,
    });
  }
  const system = await findSystemById(sql, enrolment.systemId);
  if (system === undefined) {
    throw new HTTPException(422, {
      message: `That ${side} enrolment has no system.`,
    });
  }
  const profile =
    side === "client" ? system.clientProfile : system.serverProfile;
  if (profile == null) {
    throw new HTTPException(422, {
      message: `${system.name} is not a ${side}, so it cannot be the ${side} side of a pairing.`,
    });
  }
  return { enrolment, system };
};

/**
 * Reads the organisations an account belongs to.
 *
 * @param context - the request being answered
 * @param account - the account acting
 * @returns the organisation identifiers
 */
export const organisationsOf = async (
  context: Context<AppEnvironment>,
  account: AccountRow,
): Promise<string[]> => {
  const memberships = await listMembershipsForAccount(
    context.get("sql"),
    account.id,
  );
  return memberships.map((membership) => membership.organisationId);
};

/**
 * Reads which sides of a pairing the caller is on, or refuses.
 *
 * @param context - the request being answered
 * @param record - the pairing and its two sides
 * @param account - the account acting
 * @returns the sides, client before server
 * @throws {HTTPException} 403 when the caller is on neither side
 */
export const requireSides = async (
  context: Context<AppEnvironment>,
  record: PairingRecordRow,
  account: AccountRow,
): Promise<PairingSide[]> => {
  const sides = pairingSides(record, await organisationsOf(context, account));
  if (sides.length === 0) {
    throw refusalError({
      reason: "wrong_side",
      detail: "That pairing is between other organisations.",
    });
  }
  return sides;
};

/**
 * Computes the pairing's scope warning from the server's latest check (FR-019).
 *
 * The scopes compared are the ones snapshot into the pairing, because those are
 * what the server was actually asked for. A server nothing has checked, or one
 * whose discovery document advertised no scopes, produces no warning: a warning
 * drawn from silence would be a guess, and this warning is meant to be acted on.
 *
 * @param context - the request being answered
 * @param record - the pairing and its two sides
 * @returns the warning, or undefined when there is nothing to warn about
 */
const scopeWarningFor = async (
  context: Context<AppEnvironment>,
  record: PairingRecordRow,
): Promise<ScopeWarning | undefined> => {
  const status = await findCheckStatus(
    context.get("sql"),
    record.pairing.serverEnrolmentId,
  );
  if (status?.latest.discovery == null) {
    return undefined;
  }
  const discovery = discoveryHighlightsSchema.safeParse(
    status.latest.discovery,
  );
  if (!discovery.success) {
    return undefined;
  }
  return scopeWarning({
    requested: registrationFieldsSchema.parse(record.pairing.registrationFields)
      .scopes,
    advertised: discovery.data.scopesSupported,
    checkedAt: status.latest.checkedAt.toISOString(),
  });
};

/**
 * Renders a pairing with its timeline, as both parties read it.
 *
 * Shared with the trusted registration routes, so a pairing reads the same
 * whichever route answered for it.
 *
 * @param context - the request being answered
 * @param record - the pairing and its two sides
 * @param sides - the sides the caller is on
 * @returns the detail
 * @example
 * ```ts
 * return context.json({ pairing: await detailOf(context, record, sides) });
 * ```
 */
export const detailOf = async (
  context: Context<AppEnvironment>,
  record: PairingRecordRow,
  sides: readonly PairingSide[],
): Promise<PairingDetail> =>
  pairingDetail(
    record,
    sides,
    await listPairingEvents(context.get("sql"), record.pairing.id),
    await scopeWarningFor(context, record),
    await findLatestStatementForPairing(context.get("sql"), record.pairing.id),
  );

/** Whether the members who needed telling were told. */
export type NotificationOutcome =
  | {
      /** the message was handed over, to this many addresses */
      readonly ok: true;
      /** how many addresses it went to; zero when the organisation has none */
      readonly recipients: number;
    }
  | {
      /** the message could not be handed over */
      readonly ok: false;
      /** what the mail server said, for the member to read */
      readonly detail: string;
    };

/** How much of a mail server's complaint is quoted back to the member. */
const maximumMailFailureLength = 200;

/**
 * Tells an organisation's members what has happened to a pairing.
 *
 * Never throws. Every caller has already committed the transition it is
 * reporting, so a mail server that refuses the message must not turn a completed
 * action into a failed request - least of all a registration run, whose response
 * carries the only copy of a client secret that nothing in Muster can retrieve
 * again. The failure is returned for the caller to report alongside the result
 * (the constitution: every user-visible operation says what happened).
 *
 * An organisation with no members is left un-notified rather than treated as an
 * error: the specification's edge case is that an orphaned organisation's records
 * stay put until an admin reassigns it.
 *
 * @param context - the request being answered
 * @param organisationId - the organisation to tell
 * @param compose - builds the message from the addresses to send it to
 * @returns whether the message was handed over, and what stopped it if not
 * @example
 * ```ts
 * const told = await notify(context, record.server.organisationId, compose);
 * return context.json({ pairing, ...notificationFailureOf(told) });
 * ```
 */
export const notify = async (
  context: Context<AppEnvironment>,
  organisationId: string,
  compose: (recipients: readonly string[]) => MailMessage,
): Promise<NotificationOutcome> => {
  const contacts = await listOrganisationContacts(
    context.get("sql"),
    organisationId,
  );
  if (contacts.length === 0) {
    return { ok: true, recipients: 0 };
  }
  try {
    await context.get("mail").send(compose(contacts.map((one) => one.email)));
    return { ok: true, recipients: contacts.length };
  } catch (cause) {
    // Logged as well as returned: one member reading one response is not how an
    // operator finds out that mail is broken for everybody. No address and no
    // credential goes in the line - only what the mail server said.
    const detail =
      cause instanceof Error ? cause.message : "The mail server refused it.";
    console.warn(
      `Could not notify organisation ${organisationId}: ${detail.slice(0, maximumMailFailureLength)}`,
    );
    return { ok: false, detail: detail.slice(0, maximumMailFailureLength) };
  }
};

/**
 * Renders a notification outcome as the members a mutation response carries.
 *
 * Absent when nothing went wrong, so a member is never shown a warning about a
 * message that was sent.
 *
 * @param outcome - what the notification did
 * @returns the response members to spread
 */
export const notificationFailureOf = (
  outcome: NotificationOutcome,
): { readonly notificationFailure?: string } =>
  outcome.ok ? {} : { notificationFailure: outcome.detail };

/**
 * Applies a fulfilment or a decline.
 *
 * The two differ only in what they record and whom they tell, so they are one
 * function: the state machine decides both, and neither can be reached by a
 * caller on the wrong side of the pairing.
 *
 * @param context - the request being answered
 * @param id - the pairing being moved
 * @param move - the action and what it records
 * @returns the updated pairing
 * @throws {HTTPException} 403 when the caller is on the wrong side, 404 when there
 *   is no such pairing, 409 when the pairing cannot move that way, 422 when the
 *   server's registration mode does not admit the action
 */
const movePairing = async (
  context: Context<AppEnvironment>,
  id: string,
  move: PairingMove,
): Promise<Response> => {
  const account = await requireWriter(context);
  const sql = context.get("sql");
  const record = await requirePairingRecord(context, id);
  const sides = await requireSides(context, record, account);

  const result = applyPairingAction({
    action: move.action,
    state: record.pairing.state,
    sides,
    eventStatus: record.eventStatus,
  });
  if (!result.ok) {
    throw refusalError(result.refusal);
  }

  // Which workflow the pairing is in, which the transition table cannot see: at a
  // trusted-DCR server the run records the identifier the endpoint issued, so a
  // hand-recorded one would be Muster asserting a registration it never made.
  // Asked after the transition, so a settled pairing is reported as settled.
  if (move.action === "fulfil") {
    const byHand = authoriseHandFulfilment(
      serverProfileSchema.parse(record.serverProfile).registrationMode,
    );
    if (!byHand.ok) {
      throw refusalError(byHand.refusal);
    }
  }

  const updated = await updatePairingState(sql, {
    id: record.pairing.id,
    state: result.transition.to,
    ...(move.action === "fulfil"
      ? { clientId: move.clientId }
      : { declineReason: move.reason }),
  });
  if (updated === undefined) {
    throw new HTTPException(404, { message: "No such pairing." });
  }

  await insertPairingEvent(sql, {
    pairingId: record.pairing.id,
    actorAccountId: account.id,
    // The action belongs to the server's side, and the timeline says so even when
    // the person taking it also belongs to the client's organisation.
    actingForOrganisationId: record.server.organisationId,
    fromState: record.pairing.state,
    toState: result.transition.to,
    detail:
      move.action === "fulfil"
        ? { clientId: move.clientId }
        : { reason: move.reason },
  });

  const notice = noticeFor(record);
  const config = context.get("config");
  const told = await notify(
    context,
    record.client.organisationId,
    (recipients) =>
      move.action === "fulfil"
        ? pairingFulfilledMessage(config, recipients, notice, move.clientId)
        : pairingDeclinedMessage(config, recipients, notice, move.reason),
  );

  return context.json({
    pairing: await detailOf(context, { ...record, pairing: updated }, sides),
    ...notificationFailureOf(told),
  } satisfies PairingMutationResponse);
};

/**
 * Builds the pairing routes.
 *
 * @returns the routes, to be mounted under `/api`
 * @example
 * ```ts
 * app.route("/api", createPairingRoutes());
 * ```
 */
export const createPairingRoutes = (): Hono<AppEnvironment> => {
  const routes = new Hono<AppEnvironment>();

  // FR-013: every pairing involving the caller's organisations, in both
  // directions. The event is required rather than defaulted, because a list that
  // silently spans every event is not the list anyone asked for.
  routes.get("/pairings", async (context) => {
    const account = await requireWriter(context);
    const slug = context.req.query("event");
    if (slug === undefined) {
      throw new HTTPException(400, {
        message: "Name the event to list pairings for, as ?event={slug}.",
      });
    }
    const event = await requireEvent(context, slug);
    const organisationIds = await organisationsOf(context, account);
    const records = await listPairingRecordsForOrganisations(
      context.get("sql"),
      { eventId: event.id, organisationIds },
    );
    return context.json({
      pairings: records.map((record) =>
        pairingSummary(record, pairingSides(record, organisationIds)),
      ),
    });
  });

  // FR-012: the app owner's request, carrying the standard registration field set
  // as submitted. Every condition is checked before anything is written, and each
  // refusal names the one that failed.
  routes.post("/pairings", async (context) => {
    const body = await parseBody(context, createPairingRequestSchema);
    const account = await requireWriter(context);
    const sql = context.get("sql");
    const event = await requireEvent(context, body.eventSlug);

    const client = await requireSide(context, body.clientEnrolmentId, "client");
    const server = await requireSide(context, body.serverEnrolmentId, "server");
    const organisationIds = await organisationsOf(context, account);
    const sides: PairingSide[] = [
      ...(organisationIds.includes(client.system.organisationId)
        ? (["client"] as const)
        : []),
      ...(organisationIds.includes(server.system.organisationId)
        ? (["server"] as const)
        : []),
    ];

    const result = applyPairingAction({
      action: "request",
      state: null,
      sides,
      eventStatus: event.status,
    });
    if (!result.ok) {
      throw refusalError(result.refusal);
    }

    const key = {
      eventId: event.id,
      clientEnrolmentId: client.enrolment.id,
      serverEnrolmentId: server.enrolment.id,
    };
    const existing = await findPairingByKey(sql, key);
    const decision = authorisePairingRequest({
      registrationMode: serverProfileSchema.parse(server.system.serverProfile)
        .registrationMode,
      clientEnrolledInEvent: client.enrolment.eventId === event.id,
      serverEnrolledInEvent: server.enrolment.eventId === event.id,
      duplicateOf: existing?.id ?? null,
    });
    if (!decision.ok) {
      // FR-015: the duplicate is refused with the pairing that already exists, so
      // the console can offer it rather than only saying no.
      if (
        decision.refusal.reason === "duplicate_pairing" &&
        existing !== undefined
      ) {
        return context.json(
          {
            error: "conflict",
            detail: decision.refusal.detail,
            pairingId: existing.id,
          } satisfies PairingConflict,
          409,
        );
      }
      throw refusalError(decision.refusal);
    }

    let pairing;
    try {
      pairing = await insertPairing(sql, {
        ...key,
        registrationFields: normaliseRegistrationFields(
          body.registrationFields,
        ),
      });
    } catch (cause) {
      // Two requests arriving together: the constraint answers what the lookup
      // above could not have seen.
      if (isUniqueViolation(cause)) {
        throw new HTTPException(409, {
          message:
            "A pairing for that client and server already exists in this event.",
        });
      }
      throw cause;
    }

    await insertPairingEvent(sql, {
      pairingId: pairing.id,
      actorAccountId: account.id,
      actingForOrganisationId: client.system.organisationId,
      fromState: null,
      toState: result.transition.to,
      detail: {},
    });

    const record = await findPairingRecord(sql, pairing.id);
    if (record === undefined) {
      throw new HTTPException(404, { message: "No such pairing." });
    }
    const notice = noticeFor(record);
    const config = context.get("config");
    const told = await notify(
      context,
      server.system.organisationId,
      (recipients) => pairingRequestedMessage(config, recipients, notice),
    );

    return context.json(
      {
        pairing: await detailOf(context, record, sides),
        ...notificationFailureOf(told),
      } satisfies PairingMutationResponse,
      201,
    );
  });

  // Acceptance scenario 4: one record, one timeline, whichever party is reading.
  routes.get("/pairings/:id", async (context) => {
    const account = await requireWriter(context);
    const record = await requirePairingRecord(context, context.req.param("id"));
    const sides = await requireSides(context, record, account);
    return context.json({ pairing: await detailOf(context, record, sides) });
  });

  // FR-014: the server's organisation records the identifier it issued.
  routes.post("/pairings/:id/fulfil", async (context) => {
    const body = await parseBody(context, fulfilPairingRequestSchema);
    return movePairing(context, context.req.param("id"), {
      action: "fulfil",
      clientId: body.clientId,
    });
  });

  // FR-014: or declines, with a reason the app owner can act on.
  routes.post("/pairings/:id/decline", async (context) => {
    const body = await parseBody(context, declinePairingRequestSchema);
    return movePairing(context, context.req.param("id"), {
      action: "decline",
      reason: body.reason,
    });
  });

  return routes;
};
