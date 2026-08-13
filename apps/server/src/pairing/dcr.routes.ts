/**
 * The trusted-DCR run: mint, present, record. And the statement, as a download.
 *
 * This is the one place in Muster that acts as a trust anchor, so it is worth stating in
 * full what it does and why in that order.
 *
 * **It decides nothing.** Whether a statement may exist at all is
 * `softwareStatementRefusal` in `@muster/core`, and what goes in it is
 * `buildSoftwareStatementClaims` beside it: both pure, both exhaustively unit-tested without
 * a database. This module supplies the three things those functions may not have - the
 * clock, the identifier and the signing key - and then does I/O.
 *
 * **It goes through the state machine, not around it.** A run on a `requested` pairing ends
 * in `fulfilled` or `failed`; a run on a `failed` one first records `failed → requested` -
 * the retry the data model names - and then proceeds. So the timeline reads as the history
 * of what was attempted, and a second attempt is visible rather than implied.
 *
 * **The order of the steps is a security decision.** The endpoint's address is checked
 * against the outbound guard *before* anything is minted, so a directory entry naming an
 * internal address cannot cause a signed artefact to exist at all. Minting happens next, and
 * the statement is recorded before it is presented, so the `jti` a server is about to
 * consume is durable even if the process dies mid-request - which is what makes the
 * profile's single-use rule enforceable from Muster's side too.
 *
 * **A refusal from the far end is data, not an error.** FR-026 requires the server's own
 * error to be recorded against the pairing, so a 400 from a participant's endpoint produces
 * a 200 from this route carrying the failure. What produces a 4xx here is Muster declining
 * to act: a revoked member, a closed event, a manual server, or an address the guard will
 * not reach.
 *
 * **The secret is relayed and forgotten.** A `client_secret` in the response is put in this
 * route's answer and nowhere else - not in the pairing, not in the timeline, not in a log
 * line (constitution principle IV, FR-026). `dcr.routes.test.ts` asserts its absence from
 * every table in the database rather than from the columns somebody thought of.
 *
 * Author: John Grimes
 */

import {
  buildSoftwareStatementClaims,
  softwareStatementRefusal,
  pairingTransition,
} from "@muster/core";
import {
  findLatestSoftwareStatement,
  insertSoftwareStatement,
  transitionPairing,
} from "@muster/db";

import { notifyPairing } from "./notifications.js";
import { callerPairing, pairingResponse } from "./pairingAccess.js";
import { callerId } from "../admin/access.js";
import { requireApproved } from "../auth/middleware.js";
import { jsonError } from "../http/errors.js";
import { softwareStatementView } from "../http/views.js";
import { loadSigningKey, signClaims } from "../keys/keys.js";
import { checkOutboundUrl, outboundFetch } from "../outbound/outboundFetch.js";

import type { CallerPairing } from "./pairingAccess.js";
import type { MusterEnvironment, ServerContext } from "../context.js";
import type {
  OutboundRefusal,
  OutboundResponse,
  OutboundResult,
} from "../outbound/outboundFetch.js";
import type {
  DcrRun,
  DcrRunStep,
  DcrServerAnswer,
  SoftwareStatementView,
} from "@muster/contracts";
import type { SoftwareStatementRefusal } from "@muster/core";
import type { PairingWithSides, SoftwareStatementRow } from "@muster/db";
import type { Context, Hono } from "hono";

/** How long a registration endpoint has to answer. */
const REGISTRATION_TIMEOUT_MS = 15_000;

/** How much of a server's response body is kept as evidence. */
const EVIDENCE_LIMIT = 4000;

/** The status each refusal to mint answers with. */
const MINT_REFUSAL_STATUS: Readonly<
  Record<SoftwareStatementRefusal, 403 | 409 | 422>
> = {
  email_unverified: 403,
  awaiting_approval: 403,
  revoked_member: 403,
  not_the_app_owner: 403,
  // Conflicts with the state of the event or the pairing, rather than bad requests.
  event_not_open: 409,
  pairing_not_open: 409,
  vouching_window_closed: 409,
  not_trusted_dcr: 422,
  no_registration_endpoint: 422,
  no_client_name: 422,
  no_launch_url: 422,
  no_redirect_uris: 422,
  no_scopes: 422,
};

/** What to tell somebody Muster will not mint for. */
const MINT_REFUSAL_DETAIL: Readonly<Record<SoftwareStatementRefusal, string>> =
  {
    email_unverified: "Follow the verification link in your email first",
    awaiting_approval: "A track admin has yet to approve this account",
    revoked_member: "This account's membership has been revoked",
    not_the_app_owner:
      "Only the app owner's organisation may register the app. Muster vouches for metadata on behalf of the organisation that owns the client.",
    event_not_open:
      "Muster mints statements only for open events. This event's records stay readable.",
    pairing_not_open:
      "This pairing has already been answered. A fulfilled, declined or lapsed pairing is not registered again.",
    vouching_window_closed:
      "This event's grace period has passed, so a statement minted now would already have expired.",
    not_trusted_dcr:
      "This server's registration mode is not trusted DCR, so it has not agreed to accept Muster-vouched registration. Its owner records the client identifier by hand.",
    no_registration_endpoint:
      "This server declares no registration endpoint to present a statement to",
    no_client_name: "The registration details need a client name",
    no_launch_url: "The registration details need a launch URL",
    no_redirect_uris: "The registration details need at least one redirect URI",
    no_scopes: "The registration details need at least one scope",
  };

/**
 * The guard's refusals that mean no request left the process.
 *
 * They are answered with a 422 and change nothing about the pairing, because there was no
 * attempt: the address itself is wrong, and what the owner has to fix is their own entry.
 * Every other refusal - a timeout, a connection refused - happened *at* the endpoint and is
 * recorded as a failed attempt.
 */
const ADDRESS_REFUSALS: ReadonlySet<OutboundRefusal> = new Set([
  "not-a-url",
  "insecure-scheme",
  "userinfo",
  "blocked-address",
  "unresolvable",
]);

/** A step, as the console renders it. */
function step(
  name: DcrRunStep["name"],
  outcome: DcrRunStep["outcome"],
  detail: string,
): DcrRunStep {
  return { name, outcome, detail };
}

/** What the far end said, as evidence. */
function serverAnswer(response: OutboundResponse): DcrServerAnswer {
  let error: string | null = null;
  let errorDescription: string | null = null;
  try {
    const parsed = JSON.parse(response.body) as Record<string, unknown>;
    error = typeof parsed["error"] === "string" ? parsed["error"] : null;
    errorDescription =
      typeof parsed["error_description"] === "string"
        ? parsed["error_description"]
        : null;
  } catch {
    // A response that is not JSON is still evidence. RFC 7591 requires JSON, so an endpoint
    // answering otherwise has failed the profile - which the harness reports and this route
    // records rather than hides.
  }
  return {
    status: response.status,
    error,
    errorDescription,
    body: response.body.slice(0, EVIDENCE_LIMIT),
  };
}

/** The identifier the server issued, when it issued one. */
function issuedCredentials(response: OutboundResponse): {
  readonly clientId: string | null;
  readonly clientSecret: string | null;
} {
  try {
    const parsed = JSON.parse(response.body) as Record<string, unknown>;
    return {
      clientId:
        typeof parsed["client_id"] === "string" ? parsed["client_id"] : null,
      clientSecret:
        typeof parsed["client_secret"] === "string"
          ? parsed["client_secret"]
          : null,
    };
  } catch {
    return { clientId: null, clientSecret: null };
  }
}

/**
 * Mints and records a statement for a pairing.
 *
 * Recorded before it is presented, deliberately. The profile makes the statement identifier
 * single-use at the server, and a statement that had been presented without being recorded
 * would be one Muster could not account for.
 */
async function mintStatement(
  context: ServerContext,
  row: PairingWithSides,
  actorAccountId: string,
): Promise<SoftwareStatementRow> {
  const now = context.clock();
  const claims = buildSoftwareStatementClaims({
    issuer: context.config.publicUrl,
    softwareId: row.client.system.id,
    // The only randomness in the run, and it is here rather than in `@muster/core` because
    // the pure package may not generate any (constitution principle II).
    jti: crypto.randomUUID(),
    eventSlug: row.event.slug,
    eventEndsOn: row.event.endsOn,
    graceDays: row.event.graceDays,
    fields: row.pairing.registrationFields,
    now,
  });
  const signing = await loadSigningKey(
    context.db,
    context.config.masterKey,
    "statements",
    now,
  );
  const jws = await signClaims(claims, signing);

  return await insertSoftwareStatement(context.db, {
    pairingId: row.pairing.id,
    jti: claims.jti,
    mintedBy: actorAccountId,
    keyId: signing.kid,
    claims,
    jws,
    expiresAt: new Date(claims.exp * 1000),
    now,
  });
}

/**
 * Moves the pairing and tells the counterparty.
 *
 * Always through the state machine, and always for the client's organisation: the run is the
 * app owner's act, whichever way it ends.
 */
async function recordOutcome(
  context: ServerContext,
  found: CallerPairing,
  c: Context<MusterEnvironment>,
  change:
    | { readonly to: "fulfilled"; readonly clientId: string }
    | { readonly to: "failed"; readonly reason: string },
): Promise<
  { readonly row: PairingWithSides; readonly notified: boolean } | Response
> {
  const from = found.row.pairing.state;
  const moved = await transitionPairing(context.db, {
    pairingId: found.row.pairing.id,
    from,
    change,
    actorAccountId: callerId(c),
    actingForOrganisationId: found.row.client.organisation.id,
    now: context.clock(),
  });
  if (!moved.ok) {
    // Somebody answered between the read and the write. The state they recorded stands.
    return jsonError(
      c,
      409,
      "state_changed",
      "This pairing was answered while the registration was in flight",
    );
  }
  const updated: PairingWithSides = { ...found.row, pairing: moved.pairing };
  const notified = await notifyPairing(
    context,
    updated,
    change.to === "fulfilled" ? "fulfilled" : "failed",
    pairingTransition(from, change.to)?.notifies ?? [],
  );
  return { row: updated, notified };
}

/**
 * Re-requests a failed pairing, which is the retry the data model names.
 *
 * Recorded as its own transition rather than folded into the attempt, so a member reading
 * the timeline sees that a second run happened and when.
 */
async function reRequest(
  context: ServerContext,
  found: CallerPairing,
  c: Context<MusterEnvironment>,
): Promise<PairingWithSides | Response> {
  if (found.row.pairing.state !== "failed") {
    return found.row;
  }
  const moved = await transitionPairing(context.db, {
    pairingId: found.row.pairing.id,
    from: "failed",
    change: { to: "requested" },
    actorAccountId: callerId(c),
    actingForOrganisationId: found.row.client.organisation.id,
    now: context.clock(),
  });
  if (!moved.ok) {
    return jsonError(
      c,
      409,
      "state_changed",
      "This pairing changed state while the registration was starting",
    );
  }
  const updated: PairingWithSides = { ...found.row, pairing: moved.pairing };
  await notifyPairing(
    context,
    updated,
    "requested",
    pairingTransition("failed", "requested")?.notifies ?? [],
  );
  return updated;
}

/** Assembles the run the console renders. */
function runOf(
  statement: SoftwareStatementView,
  registrationEndpoint: string,
  outcome: DcrRun["outcome"],
  steps: readonly DcrRunStep[],
  answer: DcrServerAnswer | null,
  credentials: {
    readonly clientId: string | null;
    readonly clientSecret: string | null;
  },
): DcrRun {
  return {
    outcome,
    steps: [...steps],
    statement,
    registrationEndpoint,
    answer,
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
  };
}

/** What the attempt amounted to: what to record, and what to show. */
interface JudgedAttempt {
  readonly outcome: DcrRun["outcome"];
  readonly change:
    | { readonly to: "fulfilled"; readonly clientId: string }
    | { readonly to: "failed"; readonly reason: string };
  /** The `present` step. */
  readonly presented: DcrRunStep;
  /** What the `record` step says when the notification went out. */
  readonly recorded: string;
  readonly answer: DcrServerAnswer | null;
  readonly credentials: {
    readonly clientId: string | null;
    readonly clientSecret: string | null;
  };
}

/**
 * What the far end's behaviour amounts to (FR-026).
 *
 * Three outcomes, and they are separated here rather than at three exits so that what is
 * recorded and what is displayed cannot disagree about which of them happened. Registration
 * requires both a success status and an identifier: a 201 with no `client_id` is a server that
 * has not registered anything, and treating it as success would fulfil a pairing with no
 * credential in it.
 */
function judgeAttempt(presented: OutboundResult): JudgedAttempt {
  if (!presented.ok) {
    return {
      outcome: "unreachable",
      change: { to: "failed", reason: presented.description },
      presented: step("present", "failed", presented.description),
      recorded: "Recorded as failed against the pairing",
      answer: null,
      credentials: { clientId: null, clientSecret: null },
    };
  }

  const answer = serverAnswer(presented.value);
  const credentials = issuedCredentials(presented.value);
  const from = `${String(answer.status)} from the registration endpoint`;

  if (
    (answer.status !== 200 && answer.status !== 201) ||
    credentials.clientId === null
  ) {
    const reason =
      answer.error === null
        ? `The registration endpoint answered ${String(answer.status)} without a client_id`
        : `${answer.error}${answer.errorDescription === null ? "" : `: ${answer.errorDescription}`}`;
    return {
      outcome: "refused",
      change: { to: "failed", reason },
      presented: step("present", "failed", from),
      recorded: reason,
      answer,
      // Nothing is relayed from a refusal, whatever the body happened to contain.
      credentials: { clientId: null, clientSecret: null },
    };
  }

  return {
    outcome: "registered",
    change: { to: "fulfilled", clientId: credentials.clientId },
    presented: step("present", "done", from),
    recorded: "Pairing fulfilled and the server's organisation notified",
    answer,
    credentials,
  };
}

/**
 * Registers the trusted-DCR run and the statement download.
 *
 * @param router - The API router.
 * @param context - The server's dependencies.
 * @example
 * ```ts
 * registerDcrRoutes(router, context);
 * ```
 */
export function registerDcrRoutes(
  router: Hono<MusterEnvironment>,
  context: ServerContext,
): void {
  /** Mints a statement, presents it, and records what happened (FR-026, scenario 2 and 3). */
  router.post("/pairings/:id/register", requireApproved(), async (c) => {
    const found = await callerPairing(context, c, c.req.param("id"));
    if (found instanceof Response) {
      return found;
    }
    const profile = found.row.server.system.serverProfile;

    const refusal = softwareStatementRefusal({
      standing: found.viewer.standing,
      ownsClientSide: found.viewer.sides.includes("client"),
      eventStatus: found.row.event.status,
      eventEndsOn: found.row.event.endsOn,
      graceDays: found.row.event.graceDays,
      pairingState: found.row.pairing.state,
      serverRegistrationMode: profile?.registrationMode ?? "manual",
      registrationEndpoint: profile?.registrationEndpoint ?? null,
      fields: found.row.pairing.registrationFields,
      now: context.clock(),
    });
    if (refusal !== undefined) {
      return jsonError(
        c,
        MINT_REFUSAL_STATUS[refusal],
        refusal,
        MINT_REFUSAL_DETAIL[refusal],
      );
    }
    // Narrowed by the refusal above, which returns `no_registration_endpoint` otherwise.
    const registrationEndpoint = profile?.registrationEndpoint ?? "";

    // Before anything is signed: an entry naming an internal address must not be able to
    // cause a vouching artefact to exist (constitution principle III, FR-020).
    const address = checkOutboundUrl(
      registrationEndpoint,
      context.config.outboundAllowedHosts,
    );
    if (!address.ok) {
      return jsonError(c, 422, "guarded_address", address.description);
    }

    const requested = await reRequest(context, found, c);
    if (requested instanceof Response) {
      return requested;
    }
    const attempt: CallerPairing = { row: requested, viewer: found.viewer };

    const statement = await mintStatement(context, requested, callerId(c));
    const view = softwareStatementView(statement);
    const minted = step(
      "mint",
      "done",
      `Signed with ${statement.keyId}, valid until ${statement.expiresAt.toISOString()}`,
    );

    const presented = await outboundFetch(registrationEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // Statement-only, per `contracts/registration-profile.md`: the anchor vouches for the
      // metadata, so a body that could add or override a field would reopen the gap that
      // vouching closes.
      body: JSON.stringify({ software_statement: statement.jws }),
      allowedHosts: context.config.outboundAllowedHosts,
      timeoutMs: REGISTRATION_TIMEOUT_MS,
      ...(context.outbound?.fetchImpl === undefined
        ? {}
        : { fetchImpl: context.outbound.fetchImpl }),
      ...(context.outbound?.resolve === undefined
        ? {}
        : { resolve: context.outbound.resolve }),
    });

    if (!presented.ok && ADDRESS_REFUSALS.has(presented.reason)) {
      // The address, not the endpoint: no request was made, so there is no attempt to record.
      return jsonError(c, 422, "guarded_address", presented.description);
    }

    // Judged before anything is written, so there is one place that decides how the run ended
    // and one place that records it.
    const judged = judgeAttempt(presented);

    const recorded = await recordOutcome(context, attempt, c, judged.change);
    if (recorded instanceof Response) {
      return recorded;
    }
    return c.json({
      pairing: await pairingResponse(context, recorded.row, found.viewer),
      notified: recorded.notified,
      run: runOf(
        view,
        registrationEndpoint,
        judged.outcome,
        [
          minted,
          judged.presented,
          step(
            "record",
            "done",
            recorded.notified
              ? judged.recorded
              : `${judged.recorded}; the notification could not be sent`,
          ),
        ],
        judged.answer,
        judged.credentials,
      ),
    });
  });

  /**
   * The statement, byte for byte as it was presented (FR-027, scenario 6).
   *
   * The app owner's alone. The profile gives a statement no audience claim, so whoever holds
   * one can present it at any server that trusts Muster - which makes handing it to as few
   * people as the requirement allows the conservative reading, and the requirement names the
   * owner.
   */
  router.get("/pairings/:id/statement", requireApproved(), async (c) => {
    const found = await callerPairing(context, c, c.req.param("id"));
    if (found instanceof Response) {
      return found;
    }
    if (!found.viewer.sides.includes("client")) {
      return jsonError(
        c,
        403,
        "not_the_app_owner",
        "The software statement is the app owner's to present or to hand over",
      );
    }
    const statement = await findLatestSoftwareStatement(
      context.db,
      found.row.pairing.id,
    );
    if (statement === undefined) {
      return jsonError(
        c,
        404,
        "not_found",
        "No software statement has been minted for this pairing",
      );
    }
    return c.body(statement.jws, 200, {
      // RFC 7519 §11.6 registers `application/jwt`, which a software statement is.
      "content-type": "application/jwt",
      "content-disposition": `attachment; filename="software-statement-${found.row.pairing.id}.jwt"`,
      // A vouching artefact is not something a shared cache should keep.
      "cache-control": "no-store",
    });
  });
}
