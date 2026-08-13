/**
 * The conformance harness: present the profile's cases to a server, and report what it did.
 *
 * The judgement is not here. What each answer means is `harnessCheckJudgement` and its
 * neighbours in `@muster/core`, which are pure and exhaustively unit-tested (constitution
 * principle II); this module supplies the clock, the identifiers and the signing key, presents
 * five requests through the one guarded fetch, and records what came back. Six decisions are
 * worth stating.
 *
 * **Five exchanges decide six checks.** The metadata-fidelity check is a judgement about the
 * valid registration rather than a request of its own: it compares the client the server
 * created against the metadata Muster vouched for, and a second registration would only give
 * it a second client to clean up. Every other check has its own exchange, and the replay
 * deliberately re-presents the first one's statement, because the identifier the profile makes
 * single-use is the identifier the first exchange consumed.
 *
 * **The address is checked before anything is signed.** An entry naming an internal address
 * must not be able to cause a vouching artefact to exist at all (principle III, FR-020), so
 * the guard's verdict on the registration endpoint is taken first and answered with a 422.
 *
 * **The statements are not recorded.** `software_statement` rows belong to pairings: they are
 * the record of Muster having vouched for a participant's client. A harness statement vouches
 * for a throwaway client of Muster's own for the length of one run, and writing five of them
 * per run into the pairing's audit trail would put noise into the record that FR-027 exists to
 * keep clean. What is recorded is the run: its checks, its evidence and its verdict.
 *
 * **The statement never appears in the evidence.** A valid statement names no audience, so
 * whoever holds one can present it at any server that trusts Muster - and a run's evidence is
 * a public read surface (SC-005). So the request body is recorded with the statement described
 * by its identifier and its key rather than reproduced, which is enough for a vendor to
 * correlate it with their own logs and not enough to replay it.
 *
 * **The response body is kept and its credentials are redacted.** FR-030 requires the response
 * as evidence and principle IV forbids storing a client secret. `scrubCredentials` resolves it
 * before anything is written: the body a reader sees is the body the server sent with the
 * credential replaced by a marker, so the evidence survives and the credential does not. The
 * harness has no use for the secret at all - it never authenticates as the client it registers
 * - so unlike the trusted-DCR run it does not even relay it once.
 *
 * **Cleanup follows the standard or reports that it could not.** A client is deleted through
 * the `registration_client_uri` the response supplied (RFC 7592), with the
 * `registration_access_token` it supplied beside it and with redirects refused, because that
 * token is the far end's own credential and a redirect is a different host to hand it to. A
 * server that supplies neither has given the harness no way to clean up, and scenario 4 asks
 * for that to be stated rather than glossed over.
 *
 * Author: John Grimes
 */

import {
  harnessOutsideMetadata,
  harnessRegistrationFields,
  harnessRunRefusal,
  harnessStatementClaims,
  harnessVerdict,
  judgeHarnessCheck,
  readRegistrationResponse,
  scrubCredentials,
  tamperCompactJws,
} from "@muster/core";
import {
  findEnrolmentById,
  findHarnessRun,
  insertHarnessRun,
  isOrganisationMember,
  listHarnessRuns,
} from "@muster/db";

import { callerId } from "../admin/access.js";
import { requireApproved } from "../auth/middleware.js";
import { injectedOutbound } from "../context.js";
import { jsonError } from "../http/errors.js";
import { isIdentifier } from "../http/identifiers.js";
import { harnessRunView, harnessTargetView } from "../http/views.js";
import { loadSigningKey, signClaims } from "../keys/keys.js";
import { checkOutboundUrl, outboundFetch } from "../outbound/outboundFetch.js";

import type { MusterEnvironment, ServerContext } from "../context.js";
import type { OutboundFetchOptions } from "../outbound/outboundFetch.js";
import type { HarnessCheckView } from "@muster/contracts";
import type {
  HarnessCheckName,
  HarnessExchange,
  HarnessRunRefusal,
  SoftwareStatementClaims,
} from "@muster/core";
import type { AccountRow, EnrolledSystemInEventRow } from "@muster/db";
import type { Context, Hono } from "hono";

/** How long a registration endpoint has to answer one of the harness's requests. */
const HARNESS_TIMEOUT_MS = 15_000;

/** How much of a server's response body is kept as evidence. */
const EVIDENCE_LIMIT = 4000;

/** The status each refusal to run answers with. */
const RUN_REFUSAL_STATUS: Readonly<
  Record<HarnessRunRefusal, 401 | 403 | 404 | 409 | 422>
> = {
  not_signed_in: 401,
  email_unverified: 403,
  awaiting_approval: 403,
  revoked_member: 403,
  // A 403 would confirm that this identifier names somebody else's entry.
  not_the_server_owner: 404,
  event_not_open: 409,
  vouching_window_closed: 409,
  not_trusted_dcr: 422,
  no_registration_endpoint: 422,
};

/** What to tell somebody Muster will not run the harness for. */
const RUN_REFUSAL_DETAIL: Readonly<Record<HarnessRunRefusal, string>> = {
  not_signed_in: "Sign in as a member of the organisation that owns this entry",
  email_unverified: "Follow the verification link in your email first",
  awaiting_approval: "A track admin has yet to approve this account",
  revoked_member: "This account's membership has been revoked",
  not_the_server_owner: "No enrolment of yours has that id",
  event_not_open:
    "The harness runs against open events. This event's records stay readable.",
  vouching_window_closed:
    "This event's grace period has passed, so the valid statement the harness presents would already have expired - which would fail the run for Muster's reason rather than the server's.",
  not_trusted_dcr:
    "This entry's registration mode is not trusted DCR, so there is no registration profile for it to conform to. Change the mode to trusted DCR to prove it.",
  no_registration_endpoint:
    "This entry declares no registration endpoint to present statements to",
};

/** One case the harness presents. */
interface HarnessCase {
  /** The check this exchange decides. */
  readonly name: HarnessCheckName;
  /** The artefact to present, exactly as it will be sent. */
  readonly jws: string;
  /** The claims Muster vouched for in it. */
  readonly claims: SoftwareStatementClaims;
  /** Client metadata to assert outside the statement, for the statement-only case. */
  readonly outside?: Readonly<Record<string, unknown>>;
  /** How the recorded request body describes the statement. */
  readonly described: string;
}

/** A registered client the run has to clean up. */
interface ThrowawayClient {
  readonly clientId: string;
  /** RFC 7592's client configuration endpoint, or null when none was supplied. */
  readonly registrationClientUri: string | null;
  readonly registrationAccessToken: string | null;
}

/** The whole of one run, before it is recorded. */
interface RunOutcome {
  readonly checks: readonly HarnessCheckView[];
  readonly cleanup: string;
}

/** The guard's injection points, as this context supplies them. */
function outboundOptions(context: ServerContext): OutboundFetchOptions {
  return {
    allowedHosts: context.config.outboundAllowedHosts,
    timeoutMs: HARNESS_TIMEOUT_MS,
    ...injectedOutbound(context.outbound),
  };
}

/**
 * Presents one case and records the exchange.
 *
 * The recorded request body is the body that was sent with the statement replaced by a
 * description of it. See the module header: a statement is a bearer artefact and this evidence
 * is public.
 */
async function present(
  context: ServerContext,
  registrationEndpoint: string,
  presented: HarnessCase,
): Promise<HarnessExchange> {
  const body = JSON.stringify({
    ...presented.outside,
    software_statement: presented.jws,
  });
  const request = {
    method: "POST",
    url: registrationEndpoint,
    body: JSON.stringify({
      ...presented.outside,
      software_statement: presented.described,
    }),
  };

  const result = await outboundFetch(registrationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    ...outboundOptions(context),
  });
  if (!result.ok) {
    return { request, response: null, failure: result.description };
  }

  const scrubbed = scrubCredentials(result.value.body);
  let error: string | null = null;
  let errorDescription: string | null = null;
  try {
    const parsed = JSON.parse(scrubbed) as Record<string, unknown>;
    error = typeof parsed["error"] === "string" ? parsed["error"] : null;
    errorDescription =
      typeof parsed["error_description"] === "string"
        ? parsed["error_description"]
        : null;
  } catch {
    // A response that is not JSON has failed the profile, which the checks report. It is
    // still recorded, because what a vendor needs is the body their server actually sent.
  }
  return {
    request,
    response: {
      status: result.value.status,
      error,
      errorDescription,
      body: scrubbed.slice(0, EVIDENCE_LIMIT),
    },
    failure: null,
  };
}

/** The client an exchange created, when it created one. */
function throwawayClient(
  exchange: HarnessExchange,
): ThrowawayClient | undefined {
  if (exchange.response === null) {
    return undefined;
  }
  const registered = readRegistrationResponse(exchange.response.body);
  return registered.clientId === null
    ? undefined
    : {
        clientId: registered.clientId,
        registrationClientUri: registered.registrationClientUri,
        registrationAccessToken: registered.registrationAccessToken,
      };
}

/**
 * Deletes one throwaway client, and says what happened either way (scenario 4).
 *
 * Redirects are refused rather than followed: the request carries the far end's own
 * registration access token, and a redirect is a different host to hand it to.
 */
async function cleanUp(
  context: ServerContext,
  client: ThrowawayClient,
): Promise<string> {
  if (client.registrationClientUri === null) {
    return `Client ${client.clientId} was left behind: the registration response carried no registration_client_uri, so the profile gives the harness no address to delete it at.`;
  }
  const deleted = await outboundFetch(client.registrationClientUri, {
    method: "DELETE",
    ...(client.registrationAccessToken === null
      ? {}
      : {
          headers: {
            authorization: `Bearer ${client.registrationAccessToken}`,
          },
        }),
    maxRedirects: 0,
    ...outboundOptions(context),
  });
  if (!deleted.ok) {
    return `Client ${client.clientId} was left behind: ${deleted.description}`;
  }
  return deleted.value.status === 204 || deleted.value.status === 200
    ? `Deleted throwaway client ${client.clientId} at ${client.registrationClientUri}.`
    : `Client ${client.clientId} was left behind: the delete at ${client.registrationClientUri} answered ${String(deleted.value.status)}.`;
}

/** Signs one of the harness's statements and describes it for the evidence. */
async function mint(
  context: ServerContext,
  target: EnrolledSystemInEventRow,
  kind: "valid" | "expired",
): Promise<{
  readonly jws: string;
  readonly claims: SoftwareStatementClaims;
  readonly described: string;
}> {
  const now = context.clock();
  const claims = harnessStatementClaims({
    kind,
    issuer: context.config.publicUrl,
    // The only randomness in the run, and it is here rather than in `@muster/core` because
    // the pure package may not generate any (principle II).
    jti: crypto.randomUUID(),
    eventSlug: target.event.slug,
    eventEndsOn: target.event.endsOn,
    graceDays: target.event.graceDays,
    fields: harnessRegistrationFields(context.config.publicUrl),
    now,
  });
  const signing = await loadSigningKey(
    context.db,
    context.config.masterKey,
    "statements",
    now,
  );
  return {
    jws: await signClaims(claims, signing),
    claims,
    described: `<ES256 statement jti=${claims.jti} kid=${signing.kid}>`,
  };
}

/**
 * The five cases, in the order they are presented.
 *
 * The order matters in one place: the replay presents the first case's statement, so the
 * identifier has to have been consumed by then.
 */
async function harnessCases(
  context: ServerContext,
  target: EnrolledSystemInEventRow,
): Promise<readonly HarnessCase[]> {
  const [valid, forTampering, expired, forOutside] = await Promise.all([
    mint(context, target, "valid"),
    mint(context, target, "valid"),
    mint(context, target, "expired"),
    mint(context, target, "valid"),
  ]);
  return [
    { name: "valid-statement", ...valid },
    {
      name: "tampered-signature",
      ...forTampering,
      jws: tamperCompactJws(forTampering.jws),
      described: `${forTampering.described} with a broken signature`,
    },
    { name: "expired-statement", ...expired },
    // The same artefact again: the profile makes the identifier single-use, and this is the
    // identifier the first exchange consumed.
    { name: "replayed-statement", ...valid },
    {
      name: "statement-only",
      ...forOutside,
      outside: harnessOutsideMetadata(),
    },
  ];
}

/** Presents every case, judges every check, and cleans up what was created. */
async function conductRun(
  context: ServerContext,
  target: EnrolledSystemInEventRow,
  registrationEndpoint: string,
): Promise<RunOutcome> {
  const cases = await harnessCases(context, target);
  const exchanges: HarnessExchange[] = [];
  for (const presented of cases) {
    // Sequentially, because the replay depends on the first exchange having happened and
    // because a conformance run should not put five simultaneous requests on somebody's
    // server.
    exchanges.push(await present(context, registrationEndpoint, presented));
  }

  const judged = cases.map((presented, index) =>
    judgeHarnessCheck({
      name: presented.name,
      // Narrowed by construction: one exchange is pushed per case, in order.
      exchange: exchanges[index] as HarnessExchange,
      vetted: presented.claims,
    }),
  );
  // Fidelity is a second judgement about the valid registration rather than a sixth request.
  const valid = cases[0];
  const fidelity = judgeHarnessCheck({
    name: "metadata-fidelity",
    exchange: exchanges[0] as HarnessExchange,
    vetted: (valid as HarnessCase).claims,
  });
  const checks = [...judged.slice(0, 4), fidelity, ...judged.slice(4)];

  const created = exchanges.flatMap((exchange) => {
    const client = throwawayClient(exchange);
    return client === undefined ? [] : [client];
  });
  const reports: string[] = [];
  for (const client of created) {
    reports.push(await cleanUp(context, client));
  }

  return {
    checks: checks.map((check) => ({
      ...check,
      advisories: [...check.advisories],
    })),
    cleanup:
      reports.length === 0
        ? "No client was registered, so there was nothing to clean up."
        : reports.join(" "),
  };
}

/** Whether one of the caller's organisations owns the entry, for a caller who has one. */
async function ownsTarget(
  context: ServerContext,
  target: EnrolledSystemInEventRow,
  account: AccountRow | undefined,
): Promise<boolean> {
  return (
    account !== undefined &&
    (await isOrganisationMember(context.db, {
      organisationId: target.system.organisationId,
      accountId: account.id,
    }))
  );
}

/** Why this caller may not run the harness against this entry, or `undefined`. */
async function refusalFor(
  context: ServerContext,
  target: EnrolledSystemInEventRow,
  account: AccountRow | undefined,
): Promise<HarnessRunRefusal | undefined> {
  const profile = target.system.serverProfile;
  return harnessRunRefusal({
    standing: account ?? null,
    ownsServer: await ownsTarget(context, target, account),
    eventStatus: target.event.status,
    eventEndsOn: target.event.endsOn,
    graceDays: target.event.graceDays,
    registrationMode: profile?.registrationMode ?? "manual",
    registrationEndpoint: profile?.registrationEndpoint ?? null,
    now: context.clock(),
  });
}

/** The enrolment a path names, or the 404 to answer with. */
async function namedEnrolment(
  context: ServerContext,
  c: Context<MusterEnvironment>,
  enrolmentId: string,
): Promise<EnrolledSystemInEventRow | Response> {
  if (!isIdentifier(enrolmentId)) {
    // Not something that could name an enrolment. The same answer as one that names nothing:
    // a malformed identifier is a caller's mistake rather than a fault of Muster's.
    return jsonError(c, 404, "not_found", "No enrolment has that id");
  }
  const target = await findEnrolmentById(context.db, enrolmentId);
  return target ?? jsonError(c, 404, "not_found", "No enrolment has that id");
}

/**
 * Registers the harness routes.
 *
 * @param router - The API router.
 * @param context - The server's dependencies.
 * @example
 * ```ts
 * registerHarnessRoutes(router, context);
 * ```
 */
export function registerHarnessRoutes(
  router: Hono<MusterEnvironment>,
  context: ServerContext,
): void {
  /** Runs the profile's checks against the enrolment's registration endpoint (FR-029). */
  router.post("/enrolments/:id/harness-runs", requireApproved(), async (c) => {
    const target = await namedEnrolment(context, c, c.req.param("id"));
    if (target instanceof Response) {
      return target;
    }
    const account = c.get("account");
    const refusal = await refusalFor(context, target, account);
    if (refusal !== undefined) {
      return jsonError(
        c,
        RUN_REFUSAL_STATUS[refusal],
        refusal === "not_the_server_owner" ? "not_found" : refusal,
        RUN_REFUSAL_DETAIL[refusal],
      );
    }
    // Narrowed by the refusal above, which answers `no_registration_endpoint` otherwise.
    const registrationEndpoint =
      target.system.serverProfile?.registrationEndpoint ?? "";

    // Before anything is signed: an entry naming an internal address must not be able to
    // cause a vouching artefact to exist at all (principle III, FR-020).
    const address = checkOutboundUrl(
      registrationEndpoint,
      context.config.outboundAllowedHosts,
    );
    if (!address.ok) {
      return jsonError(c, 422, "guarded_address", address.description);
    }

    const outcome = await conductRun(context, target, registrationEndpoint);
    const run = await insertHarnessRun(context.db, {
      enrolmentId: target.enrolment.id,
      runBy: callerId(c),
      ranAt: context.clock(),
      verdict: harnessVerdict(outcome.checks),
      checks: outcome.checks,
      cleanup: outcome.cleanup,
    });
    return c.json({
      target: harnessTargetView(target),
      run: harnessRunView(run),
    });
  });

  /**
   * One enrolment's runs, newest first, and whether this caller may add one.
   *
   * Public, per principle V: the badge on the event view is a claim about these runs, and a
   * claim whose evidence needs an account is not evidence (SC-005). Nothing here carries a
   * contact detail, and the registration endpoint is already part of the public entry.
   */
  router.get("/enrolments/:id/harness-runs", async (c) => {
    const target = await namedEnrolment(context, c, c.req.param("id"));
    if (target instanceof Response) {
      return target;
    }
    const runs = await listHarnessRuns(context.db, target.enrolment.id);
    return c.json({
      target: harnessTargetView(
        target,
        await refusalFor(context, target, c.get("account")),
      ),
      runs: runs.map(harnessRunView),
    });
  });

  /** One run, with its evidence (SC-005). Public, for the same reason as the list. */
  router.get("/harness-runs/:id", async (c) => {
    const runId = c.req.param("id");
    const run = isIdentifier(runId)
      ? await findHarnessRun(context.db, runId)
      : undefined;
    if (run === undefined) {
      return jsonError(c, 404, "not_found", "No conformance run has that id");
    }
    return c.json({ run: harnessRunView(run) });
  });
}
