import {
  registrationFieldsSchema,
  serverProfileSchema,
} from "@muster/contracts";
import {
  applyPairingAction,
  authoriseDirectoryRegistration,
  mintStatement,
} from "@muster/core";
import {
  findLatestStatementForPairing,
  insertPairingEvent,
  insertSoftwareStatement,
  updatePairingState,
} from "@muster/db";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

import { detailOf, notify, requireSides } from "./routes.ts";
import { statementView } from "./views.ts";
import { factsFor, refusalError, requireWriter } from "../auth/sessions.ts";
import { requireEvent, requirePairingRecord } from "../http/lookups.ts";
import { activeSigningKey, signJws } from "../keys/keys.ts";
import { pairingRegisteredMessage } from "../mail/messages.ts";
import { outboundFetch } from "../outbound/outboundFetch.ts";

import type { AppEnvironment } from "../app.ts";
import type {
  DcrRunResponse,
  DcrRunStep,
  PairingSide,
  RegistrationError,
} from "@muster/contracts";
import type {
  EventRow,
  PairingRecordRow,
  SoftwareStatementRow,
} from "@muster/db";
import type { Context } from "hono";

/**
 * Trusted dynamic client registration: the run, and the statement download.
 *
 * This is the ceiling of the pairing workflow (US5). The app's owner asks; Muster
 * mints a software statement carrying the metadata the pairing snapshot vetted,
 * presents it to the server's own registration endpoint, and records what came
 * back. No member of the server's organisation acts, because their entry already
 * said the server accepts registrations Muster vouches for.
 *
 * Four rules from the constitution are visible in the order of this file, and each
 * of them is a refusal rather than a fallback.
 *
 * Vouching is deny by default. The account must be approved, verified and
 * unrevoked; it must be on the client's side of the pairing; the server must
 * actually declare trusted registration and an endpoint; the event must be open
 * and the pairing must belong to it; and the statement's expiry is capped at the
 * event's end plus its grace days. Every one of those is decided in
 * `@muster/core`, not here.
 *
 * The guard is the only path to the network. A registration endpoint the guard
 * refuses produces a 422 naming the reason and no request at all - and it does not
 * mark the pairing failed, because Muster's refusal is not the server's rejection.
 *
 * A returned client secret is relayed once, in the answer to the run that
 * obtained it, and is written nowhere: not to the statement record, not to the
 * pairing, not to the timeline, and not to the log. It is stripped even out of the
 * registered metadata the run reports, so it cannot arrive twice by accident.
 *
 * The statement is recorded before it is presented. A `jti` Muster has issued is
 * spent whether the server accepted it or not, and a failed attempt is exactly the
 * artefact the app owner needs to be able to look at afterwards.
 *
 * @author John Grimes
 */

/**
 * The response members that are credentials rather than metadata.
 *
 * Removed from the metadata a run reports: the client secret is relayed once in
 * its own field and nowhere else, and a registration access token is the
 * conformance harness's business rather than a member's.
 */
const credentialMembers = new Set([
  "client_secret",
  "registration_access_token",
]);

/** How much of an unparseable refusal is quoted back to the member. */
const maximumQuotedBodyLength = 200;

/** What one run of the registration produced. */
type RunOutcome = {
  /** the identifier the server issued, when it issued one */
  readonly clientId: string | null;
  /** the secret the server returned, relayed once and stored nowhere */
  readonly clientSecret: string | undefined;
  /** the metadata the server says it registered, credentials removed */
  readonly registeredMetadata: Record<string, unknown> | null;
  /** the server's refusal, when it refused */
  readonly serverError: RegistrationError | null;
  /** what to say about the presentation step */
  readonly detail: string;
};

/**
 * Reads a JSON body without trusting it to be JSON.
 *
 * @param response - the registration endpoint's answer
 * @returns the parsed object, the raw text, and whether parsing worked
 */
const readJsonBody = async (
  response: Response,
): Promise<{
  /** the parsed object, when the body was a JSON object */
  readonly body: Record<string, unknown> | undefined;
  /** the body as text, for quoting back when it was not */
  readonly text: string;
}> => {
  const text = await response.text();
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? { body: parsed as Record<string, unknown>, text }
      : { body: undefined, text };
  } catch {
    return { body: undefined, text };
  }
};

/**
 * Reads a string member of a JSON body, or nothing.
 *
 * @param body - the parsed body
 * @param name - the member to read
 * @returns the value when it is a non-empty string
 */
const stringMember = (
  body: Record<string, unknown> | undefined,
  name: string,
): string | undefined => {
  const value = body?.[name];
  return typeof value === "string" && value !== "" ? value : undefined;
};

/**
 * Classifies what a registration endpoint answered.
 *
 * Deny by default applies to reading a response as much as to authorising one: a
 * 2xx that names no client identifier has not registered anything Muster can
 * record, so it is a failure rather than an optimistic success.
 *
 * @param response - the answer, after the guard
 * @returns what the run produced
 */
const classifyResponse = async (response: Response): Promise<RunOutcome> => {
  const { body, text } = await readJsonBody(response);
  const clientId = stringMember(body, "client_id");

  if (response.ok && clientId !== undefined) {
    // Credentials are removed from the reported metadata: the secret is relayed
    // in its own field, once, and a registration access token is the harness's
    // business rather than a member's.
    const metadata = Object.fromEntries(
      Object.entries(body ?? {}).filter(
        ([name]) => !credentialMembers.has(name),
      ),
    );
    return {
      clientId,
      clientSecret: stringMember(body, "client_secret"),
      registeredMetadata: metadata,
      serverError: null,
      detail: `Registered as ${clientId}.`,
    };
  }

  const error = stringMember(body, "error");
  const description = stringMember(body, "error_description");
  const refusal: RegistrationError =
    error === undefined
      ? response.ok
        ? {
            error: "invalid_response",
            errorDescription:
              "The server accepted the statement but named no client_id, so there is no registration to record.",
          }
        : {
            error: `http_${String(response.status)}`,
            errorDescription:
              text.trim() === ""
                ? "The server answered with no body."
                : text.trim().slice(0, maximumQuotedBodyLength),
          }
      : {
          error,
          ...(description === undefined
            ? {}
            : { errorDescription: description }),
        };

  return {
    clientId: null,
    clientSecret: undefined,
    registeredMetadata: null,
    serverError: refusal,
    detail: `${response.ok ? "Accepted with no client identifier" : `Refused with HTTP ${String(response.status)}`}: ${refusal.error}${refusal.errorDescription === undefined ? "" : ` - ${refusal.errorDescription}`}`,
  };
};

/**
 * Returns a failed pairing to `requested` so that it can be attempted again.
 *
 * The data model's retry, applied through the state machine like every other
 * transition, and recorded on the timeline: a member re-running a registration is
 * entitled to see that the pairing went back to being a request before it was
 * presented again.
 *
 * @param context - the request being answered
 * @param record - the pairing and its two sides
 * @param sides - the sides the caller is on
 * @param accountId - the account acting
 * @returns nothing
 * @throws {HTTPException} when the retry is not permitted
 */
const retryFailedPairing = async (
  context: Context<AppEnvironment>,
  record: PairingRecordRow,
  sides: readonly PairingSide[],
  accountId: string,
): Promise<void> => {
  const retry = applyPairingAction({
    action: "retry",
    state: record.pairing.state,
    sides,
    eventStatus: record.eventStatus,
  });
  if (!retry.ok) {
    throw refusalError(retry.refusal);
  }
  await updatePairingState(context.get("sql"), {
    id: record.pairing.id,
    state: retry.transition.to,
  });
  await insertPairingEvent(context.get("sql"), {
    pairingId: record.pairing.id,
    actorAccountId: accountId,
    actingForOrganisationId: record.client.organisationId,
    fromState: record.pairing.state,
    toState: retry.transition.to,
    detail: {},
  });
};

/**
 * Mints and records the statement for a run.
 *
 * @param context - the request being answered
 * @param record - the pairing and its two sides
 * @param event - the event the pairing belongs to
 * @param sides - the sides the caller is on
 * @param accountId - the account minting
 * @returns the recorded statement
 * @throws {HTTPException} when minting is refused
 */
const mintForPairing = async (
  context: Context<AppEnvironment>,
  record: PairingRecordRow,
  event: EventRow,
  sides: readonly PairingSide[],
  accountId: string,
): Promise<SoftwareStatementRow> => {
  const account = await requireWriter(context);
  const config = context.get("config");
  const sql = context.get("sql");

  const minted = mintStatement({
    issuer: config.publicUrl,
    member: factsFor(account),
    ownsClient: sides.includes("client"),
    eventStatus: event.status,
    eventSlug: event.slug,
    eventEndsOn: event.endsOn,
    graceDays: event.graceDays,
    pairingInEvent: record.pairing.eventId === event.id,
    softwareId: record.client.systemId,
    jti: crypto.randomUUID(),
    fields: registrationFieldsSchema.parse(record.pairing.registrationFields),
    now: new Date(),
  });
  if (!minted.ok) {
    throw refusalError(minted.refusal);
  }

  const key = await activeSigningKey(sql, {
    purpose: "statements",
    masterKey: config.masterKey,
  });
  return insertSoftwareStatement(sql, {
    pairingId: record.pairing.id,
    jti: minted.claims.jti,
    mintedBy: accountId,
    keyId: key.kid,
    claims: minted.claims,
    jws: await signJws(key, { ...minted.claims }),
    expiresAt: minted.expiresAt,
  });
};

/**
 * Builds the trusted registration routes.
 *
 * @returns the routes, to be mounted under `/api`
 * @example
 * ```ts
 * app.route("/api", createDcrRoutes());
 * ```
 */
export const createDcrRoutes = (): Hono<AppEnvironment> => {
  const routes = new Hono<AppEnvironment>();

  // FR-026: the owner's initiation, from mint to recorded outcome, reported as
  // the steps it actually took (FR-037).
  routes.post("/pairings/:id/register", async (context) => {
    const account = await requireWriter(context);
    const sql = context.get("sql");
    const config = context.get("config");
    const record = await requirePairingRecord(context, context.req.param("id"));
    const sides = await requireSides(context, record, account);
    const event = await requireEvent(context, record.eventSlug);

    // Whether this server accepts trusted registration at all, before anything is
    // minted or written: a manual server's organisation issues the identifier.
    const profile = serverProfileSchema.parse(record.serverProfile);
    const permitted = authoriseDirectoryRegistration({
      registrationMode: profile.registrationMode,
      registrationEndpoint: profile.registrationEndpoint ?? null,
    });
    if (!permitted.ok) {
      throw refusalError(permitted.refusal);
    }
    const endpoint = profile.registrationEndpoint ?? "";

    // A re-run after a failure is the data model's retry followed by a fresh
    // attempt, both recorded, rather than a second transition out of `failed`.
    if (record.pairing.state === "failed") {
      await retryFailedPairing(context, record, sides, account.id);
    }
    const state =
      record.pairing.state === "failed" ? "requested" : record.pairing.state;

    const registration = applyPairingAction({
      action: "register",
      state,
      sides,
      eventStatus: record.eventStatus,
    });
    if (!registration.ok) {
      throw refusalError(registration.refusal);
    }

    const statement = await mintForPairing(
      context,
      record,
      event,
      sides,
      account.id,
    );
    const steps: DcrRunStep[] = [
      {
        name: "Mint the software statement",
        outcome: "succeeded",
        detail: `Signed with key ${statement.keyId}, vouching until ${statement.expiresAt.toISOString()}.`,
      },
    ];

    const presented = await outboundFetch(endpoint, {
      timeoutMs: config.outbound.timeoutMs,
      allowedHosts: config.outbound.allowedHosts,
      request: {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
        // Statement only: the profile forbids a server honouring metadata
        // asserted outside the signed artefact, so none is sent.
        body: JSON.stringify({ software_statement: statement.jws }),
      },
      ...context.get("outbound"),
    });
    if (!presented.ok) {
      // Muster's own refusal, not the server's: the pairing stays as it was, and
      // the member is told which address was refused and why (FR-020).
      return context.json(
        {
          error: presented.refusal.failureMode,
          detail: presented.refusal.detail,
        },
        422,
      );
    }

    const outcome = await classifyResponse(presented.response);
    steps.push({
      name: `Present it to ${record.server.systemName}`,
      outcome: outcome.serverError === null ? "succeeded" : "failed",
      detail: outcome.detail,
    });

    const transition =
      outcome.serverError === null
        ? registration
        : applyPairingAction({
            action: "fail",
            state: "requested",
            sides,
            eventStatus: record.eventStatus,
          });
    if (!transition.ok) {
      throw refusalError(transition.refusal);
    }

    const reason =
      outcome.serverError === null
        ? undefined
        : `${outcome.serverError.error}${outcome.serverError.errorDescription === undefined ? "" : `: ${outcome.serverError.errorDescription}`}`;
    const updated = await updatePairingState(sql, {
      id: record.pairing.id,
      state: transition.transition.to,
      ...(outcome.clientId === null ? {} : { clientId: outcome.clientId }),
      ...(reason === undefined ? {} : { declineReason: reason }),
    });
    if (updated === undefined) {
      throw new HTTPException(404, { message: "No such pairing." });
    }
    await insertPairingEvent(sql, {
      pairingId: record.pairing.id,
      actorAccountId: account.id,
      // The run is the client organisation's action: the server's part was
      // publishing an endpoint that accepts Muster's vouching.
      actingForOrganisationId: record.client.organisationId,
      fromState: "requested",
      toState: transition.transition.to,
      detail:
        outcome.clientId === null
          ? { reason: reason ?? "" }
          : { clientId: outcome.clientId },
    });
    steps.push({
      name: "Record the outcome",
      outcome: "succeeded",
      detail:
        outcome.clientId === null
          ? "The pairing is marked failed, with the server's error, for both organisations to read."
          : `The pairing is fulfilled with ${outcome.clientId}, and ${record.server.organisationName} has been told.`,
    });

    if (outcome.clientId !== null) {
      await notify(context, record.server.organisationId, (recipients) =>
        pairingRegisteredMessage(
          config,
          recipients,
          {
            pairingId: record.pairing.id,
            eventName: record.eventName,
            clientName: record.client.systemName,
            serverName: record.server.systemName,
          },
          outcome.clientId ?? "",
        ),
      );
    }

    return context.json({
      pairing: await detailOf(context, { ...record, pairing: updated }, sides),
      statement: statementView(statement),
      steps,
      clientId: outcome.clientId,
      ...(outcome.clientSecret === undefined
        ? {}
        : { clientSecret: outcome.clientSecret }),
      registeredMetadata: outcome.registeredMetadata,
      serverError: outcome.serverError,
    } satisfies DcrRunResponse);
  });

  // FR-027: the identical artefact, for an owner registering out of band. Both
  // organisations may read it - it is what Muster vouched for, and the server's
  // organisation has as much reason to check that as the owner.
  routes.get("/pairings/:id/statement", async (context) => {
    const account = await requireWriter(context);
    const record = await requirePairingRecord(context, context.req.param("id"));
    await requireSides(context, record, account);

    const statement = await findLatestStatementForPairing(
      context.get("sql"),
      record.pairing.id,
    );
    if (statement === undefined) {
      throw new HTTPException(404, {
        message: "No software statement has been minted for this pairing.",
      });
    }
    return context.body(statement.jws, 200, {
      "content-type": "application/jwt",
      "content-disposition": `attachment; filename="${statement.jti}.jws"`,
    });
  });

  return routes;
};
