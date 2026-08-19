import { serverProfileSchema } from "@muster/contracts";
import {
  authoriseHarnessRun,
  cleanupTarget,
  describeCleanup,
  expiredClaims,
  harnessCheckTitles,
  harnessProbeFields,
  harnessRequestEvidence,
  harnessResponseEvidence,
  harnessVerdict,
  judgeAcceptance,
  judgeFidelity,
  judgeRefusal,
  judgeStatementOnly,
  registeredClientId,
  statementClaims,
  tamperedStatement,
  vouchedMetadata,
} from "@muster/core";
import {
  findCheckStatus,
  findEnrolledSystem,
  findEnrolmentById,
  findEventById,
  findHarnessRun,
  findLatestHarnessRun,
  insertHarnessRun,
  listHarnessRuns,
} from "@muster/db";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

import { organisationsOf } from "./routes.ts";
import {
  currentAccount,
  factsFor,
  refusalError,
  requireWriter,
} from "../auth/sessions.ts";
import { enrolledSystem, eventDetail, harnessRun } from "../http/views.ts";
import { activeSigningKey, signJws } from "../keys/keys.ts";
import { outboundFetch } from "../outbound/outboundFetch.ts";

import type { AppEnvironment } from "../app.ts";
import type { SigningKey } from "../keys/keys.ts";
import type {
  EnrolledSystem,
  HarnessCheck,
  HarnessCheckName,
  ServerProfile,
} from "@muster/contracts";
import type {
  CleanupAttempt,
  HarnessCheckJudgement,
  HarnessExchange,
  StatementClaims,
} from "@muster/core";
import type {
  AccountRow,
  EnrolledSystemRow,
  EnrolmentRow,
  EventRow,
} from "@muster/db";
import type { Context } from "hono";

/**
 * The conformance harness: running the profile against a server, and the report.
 *
 * This is what turns `contracts/registration-profile.md` from a document into
 * something a vendor can prove they implement without contacting an organiser
 * (US6). A run makes five real registration requests at the server's own
 * endpoint - a valid statement, a tampered one, an expired one, a replay of the
 * valid one, and one asserting metadata outside the signature - and every
 * judgement about what came back is made by `@muster/core`, not here. This module
 * does the I/O and nothing else: mint, present, delete, record.
 *
 * Four rules from the constitution are visible in the order of this file.
 *
 * A run is a vouching action, so it is deny by default. Only an approved,
 * verified, unrevoked member of the organisation that owns the entry may ask for
 * one, the event must be open, and the entry must declare trusted registration
 * with an endpoint - because a run has Muster fire signed statements at an address
 * somebody typed in, and nobody but that address's owner may ask for that.
 *
 * The guard is the only path to the network. A registration endpoint the guard
 * refuses produces a 422 naming the reason, and no run is recorded: Muster's own
 * refusal is not the vendor's failure, and recording it as one would take away a
 * badge the server had earned.
 *
 * No credential is stored. The evidence is redacted by the core module before it
 * is written, so a client secret or a registration access token appears in the
 * public report as `[redacted]` and a statement appears without its signature.
 *
 * The clients a run registers are cleaned up. Where the server returned RFC 7592's
 * management members they are deleted, and where it did not the report says which
 * client was left behind and why (acceptance scenario 4). A management address on
 * another origin is not followed.
 *
 * @author John Grimes
 */

/** How many runs an entry's history shows. */
const historyLength = 20;

/** The error RFC 7591 and the profile state for a statement that fails. */
const statementRefusal = "invalid_software_statement";

/** The metadata field the statement-only check asserts outside the statement. */
const outsideField = "client_name";

/** What it asserts, which no conformant server registers. */
const outsideValue = "Asserted outside the statement, and must be ignored";

/** The entry a run is against, with everything deciding one needs. */
type HarnessTarget = {
  /** the enrolment */
  readonly enrolment: EnrolmentRow;
  /** the event it belongs to */
  readonly event: EventRow;
  /** the enrolled system, joined to its organisation */
  readonly entry: EnrolledSystemRow;
  /** its server profile, absent when the entry has no server side */
  readonly profile: ServerProfile | undefined;
};

/** One registration request and what it produced. */
type Presentation =
  | {
      /** the server answered */
      readonly ok: true;
      /** the exchange, redacted, as the report records it */
      readonly exchange: HarnessExchange;
      /** the response body as it arrived, for the management members only */
      readonly body: Record<string, unknown> | undefined;
    }
  | {
      /** nothing was reached */
      readonly ok: false;
      /** the guard's refusal, which is Muster's rather than the server's */
      readonly refusal: {
        readonly failureMode: string;
        readonly detail: string;
      };
    };

/** A throwaway client a run registered, to be deleted. */
type Throwaway = {
  /** the identifier the server issued */
  readonly clientId: string;
  /** the management address it named, when it named one */
  readonly registrationClientUri: string | undefined;
  /** the management token it named, when it named one */
  readonly registrationAccessToken: string | undefined;
};

/**
 * Reads a string member of a response body.
 *
 * @param body - the body as it arrived
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
 * Parses a body as a JSON object, or nothing.
 *
 * @param text - the body as it arrived
 * @returns the object, or undefined when it was not one
 */
const parseObject = (text: string): Record<string, unknown> | undefined => {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Finds the entry a run is addressed to, or refuses.
 *
 * @param context - the request being answered
 * @param id - the enrolment identifier
 * @returns the enrolment, its event, its entry and its server profile
 * @throws {HTTPException} 404 when there is no such enrolment
 */
const requireTarget = async (
  context: Context<AppEnvironment>,
  id: string,
): Promise<HarnessTarget> => {
  const sql = context.get("sql");
  const enrolment = await findEnrolmentById(sql, id);
  const event =
    enrolment === undefined
      ? undefined
      : await findEventById(sql, enrolment.eventId);
  const entry =
    enrolment === undefined
      ? undefined
      : await findEnrolledSystem(sql, {
          eventId: enrolment.eventId,
          systemId: enrolment.systemId,
        });
  if (enrolment === undefined || event === undefined || entry === undefined) {
    throw new HTTPException(404, { message: "No such enrolment." });
  }
  return {
    enrolment,
    event,
    entry,
    profile:
      entry.system.serverProfile == null
        ? undefined
        : serverProfileSchema.parse(entry.system.serverProfile),
  };
};

/**
 * Decides whether an account may run the harness against an entry.
 *
 * @param context - the request being answered
 * @param target - the entry the run would be against
 * @param account - the account asking, or undefined when the caller is anonymous
 * @returns the decision, refusing an anonymous caller like any other
 */
const decideRun = async (
  context: Context<AppEnvironment>,
  target: HarnessTarget,
  account: AccountRow | undefined,
) =>
  account === undefined
    ? {
        ok: false as const,
        refusal: {
          reason: "not_member" as const,
          detail: "Sign in to run the conformance harness.",
        },
      }
    : authoriseHarnessRun({
        member: factsFor(account),
        ownsServer: (await organisationsOf(context, account)).includes(
          target.entry.organisation.id,
        ),
        eventStatus: target.event.status,
        registrationMode: target.profile?.registrationMode ?? "manual",
        registrationEndpoint: target.profile?.registrationEndpoint ?? null,
      });

/**
 * Renders the entry a report is about, with its check and its latest verdict.
 *
 * Contact details are never included: a conformance report is a public document
 * and there is nothing in it a reader needs a person's address for (FR-007).
 *
 * @param context - the request being answered
 * @param target - the entry
 * @returns the entry as the report shows it
 */
const entryView = async (
  context: Context<AppEnvironment>,
  target: HarnessTarget,
): Promise<EnrolledSystem> => {
  const sql = context.get("sql");
  const [check, conformance] = await Promise.all([
    findCheckStatus(sql, target.enrolment.id),
    findLatestHarnessRun(sql, target.enrolment.id),
  ]);
  return enrolledSystem(target.entry, {
    ...(check === undefined ? {} : { check }),
    ...(conformance === undefined ? {} : { conformance }),
  });
};

/**
 * Presents one body at the registration endpoint, through the guard.
 *
 * @param context - the request being answered
 * @param endpoint - the registration endpoint
 * @param body - the request body to send
 * @returns the exchange, or the guard's refusal
 */
const present = async (
  context: Context<AppEnvironment>,
  endpoint: string,
  body: Record<string, unknown>,
): Promise<Presentation> => {
  const config = context.get("config");
  const result = await outboundFetch(endpoint, {
    timeoutMs: config.outbound.timeoutMs,
    allowedHosts: config.outbound.allowedHosts,
    request: {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(body),
    },
    ...context.get("outbound"),
  });
  if (!result.ok) {
    return { ok: false, refusal: result.refusal };
  }
  const text = await result.response.text();
  return {
    ok: true,
    exchange: {
      request: harnessRequestEvidence("POST", endpoint, body),
      response: harnessResponseEvidence(result.response.status, text),
    },
    body: parseObject(text),
  };
};

/**
 * Deletes one throwaway client, and says what happened.
 *
 * @param context - the request being answered
 * @param endpoint - the registration endpoint the client was created at
 * @param throwaway - the client and the management members the server named
 * @returns what became of it
 */
const cleanUp = async (
  context: Context<AppEnvironment>,
  endpoint: string,
  throwaway: Throwaway,
): Promise<CleanupAttempt> => {
  const target = cleanupTarget({
    registrationEndpoint: endpoint,
    registrationClientUri: throwaway.registrationClientUri,
    registrationAccessToken: throwaway.registrationAccessToken,
  });
  if (!target.ok) {
    return {
      clientId: throwaway.clientId,
      deleted: false,
      reason: target.reason,
    };
  }
  const config = context.get("config");
  const result = await outboundFetch(target.url, {
    timeoutMs: config.outbound.timeoutMs,
    allowedHosts: config.outbound.allowedHosts,
    request: {
      method: "DELETE",
      headers: { authorization: `Bearer ${target.accessToken}` },
    },
    ...context.get("outbound"),
  });
  if (!result.ok) {
    return {
      clientId: throwaway.clientId,
      deleted: false,
      reason: `the deletion could not be made: ${result.refusal.detail}`,
    };
  }
  return result.response.status >= 200 && result.response.status < 300
    ? { clientId: throwaway.clientId, deleted: true, reason: "" }
    : {
        clientId: throwaway.clientId,
        deleted: false,
        reason: `the server refused the deletion with HTTP ${String(result.response.status)}`,
      };
};

/**
 * Builds one check of a report.
 *
 * @param name - the check
 * @param exchange - the exchange it was decided from
 * @param judgement - the outcome and its reason
 * @returns the check, as the report records it
 */
const checkOf = (
  name: HarnessCheckName,
  exchange: HarnessExchange,
  judgement: HarnessCheckJudgement,
): HarnessCheck => ({
  name,
  title: harnessCheckTitles[name],
  outcome: judgement.outcome,
  detail: judgement.detail,
  request: exchange.request,
  response: exchange.response,
});

/**
 * Mints the statements one run presents.
 *
 * Four statements, each with its own identifier: the valid one (presented twice,
 * which is what makes the second presentation a replay), a second one whose
 * signature is then corrupted, a third dated wholly in the past, and a fourth for
 * the request that also asserts metadata outside the signature.
 *
 * Every one is signed with the key Muster publishes, because that is the point:
 * the only thing wrong with the tampered statement is its signature, and the only
 * thing wrong with the expired one is its expiry.
 *
 * @param key - the active statement signing key
 * @param claims - the claims to build each statement from
 * @param now - the moment of the run
 * @returns the four artefacts, and the claims the valid one carries
 */
const mintVariants = async (
  key: SigningKey,
  claims: (jti: string) => StatementClaims,
  now: Date,
): Promise<{
  /** the valid statement */
  readonly valid: string;
  /** the claims it carries, which fidelity is measured against */
  readonly validClaims: StatementClaims;
  /** a valid statement with a corrupted signature */
  readonly tampered: string;
  /** a correctly signed statement whose vouching window has closed */
  readonly expired: string;
  /** a valid statement, for the request that asserts metadata outside it */
  readonly outside: string;
}> => {
  const validClaims = claims(crypto.randomUUID());
  return {
    validClaims,
    valid: await signJws(key, { ...validClaims }),
    tampered: tamperedStatement(
      await signJws(key, { ...claims(crypto.randomUUID()) }),
    ),
    expired: await signJws(key, {
      ...expiredClaims(claims(crypto.randomUUID()), now),
    }),
    outside: await signJws(key, { ...claims(crypto.randomUUID()) }),
  };
};

/**
 * Builds the harness routes.
 *
 * @returns the routes, to be mounted under `/api`
 * @example
 * ```ts
 * app.route("/api", createHarnessRoutes());
 * ```
 */
export const createHarnessRoutes = (): Hono<AppEnvironment> => {
  const routes = new Hono<AppEnvironment>();

  // FR-029: the run. Five requests, six judgements, one verdict.
  routes.post("/enrolments/:id/harness-runs", async (context) => {
    const account = await requireWriter(context);
    const sql = context.get("sql");
    const config = context.get("config");
    const target = await requireTarget(context, context.req.param("id"));

    const decision = await decideRun(context, target, account);
    if (!decision.ok) {
      throw refusalError(decision.refusal);
    }
    const endpoint = target.profile?.registrationEndpoint ?? "";

    const now = new Date();
    const key = await activeSigningKey(sql, {
      purpose: "statements",
      masterKey: config.masterKey,
    });
    const variants = await mintVariants(
      key,
      (jti) =>
        statementClaims({
          issuer: config.publicUrl,
          eventSlug: target.event.slug,
          eventEndsOn: target.event.endsOn,
          graceDays: target.event.graceDays,
          // Named for the entry it is probing, so a server owner reading their
          // own log can see which of their entries the harness was run against.
          softwareId: `harness:${target.enrolment.id}`,
          jti,
          fields: harnessProbeFields({ publicUrl: config.publicUrl }),
          now,
        }),
      now,
    );

    // What the requests are, in the order they are made: the valid statement
    // first, because its replay is the fourth request and a replay needs
    // something to replay.
    const requests: readonly {
      readonly name: HarnessCheckName;
      readonly body: Record<string, unknown>;
    }[] = [
      { name: "validStatement", body: { software_statement: variants.valid } },
      {
        name: "tamperedSignature",
        body: { software_statement: variants.tampered },
      },
      {
        name: "expiredStatement",
        body: { software_statement: variants.expired },
      },
      {
        name: "replayedStatement",
        body: { software_statement: variants.valid },
      },
      {
        name: "statementOnly",
        body: {
          software_statement: variants.outside,
          [outsideField]: outsideValue,
        },
      },
    ];

    const exchanges = new Map<HarnessCheckName, HarnessExchange>();
    const throwaways: Throwaway[] = [];
    let refused:
      { readonly failureMode: string; readonly detail: string } | undefined;
    for (const attempt of requests) {
      const presented = await present(context, endpoint, attempt.body);
      if (!presented.ok) {
        refused = presented.refusal;
        break;
      }
      exchanges.set(attempt.name, presented.exchange);
      const clientId = registeredClientId(presented.exchange.response);
      if (clientId !== undefined) {
        // Whatever the check made of it, a client that was created is a client
        // to be deleted.
        throwaways.push({
          clientId,
          registrationClientUri: stringMember(
            presented.body,
            "registration_client_uri",
          ),
          registrationAccessToken: stringMember(
            presented.body,
            "registration_access_token",
          ),
        });
      }
    }

    const attempts: CleanupAttempt[] = [];
    for (const throwaway of throwaways) {
      attempts.push(await cleanUp(context, endpoint, throwaway));
    }

    if (refused !== undefined) {
      // Muster's own refusal, not the server's: nothing is recorded, so a badge
      // the server earned is not taken away by an address Muster would not
      // reach (FR-020). What was registered before the refusal has been cleaned
      // up, and the answer says so.
      return context.json(
        {
          error: refused.failureMode,
          detail: `${refused.detail}. ${describeCleanup(attempts)}`,
        },
        422,
      );
    }

    const valid = exchanges.get("validStatement");
    const tampered = exchanges.get("tamperedSignature");
    const expired = exchanges.get("expiredStatement");
    const replayed = exchanges.get("replayedStatement");
    const outside = exchanges.get("statementOnly");
    if (
      valid === undefined ||
      tampered === undefined ||
      expired === undefined ||
      replayed === undefined ||
      outside === undefined
    ) {
      // Unreachable: every request either produced an exchange or set `refused`.
      throw new HTTPException(500, { message: "The run did not complete." });
    }

    const vouched = vouchedMetadata(variants.validClaims);
    const checks: readonly HarnessCheck[] = [
      checkOf("validStatement", valid, judgeAcceptance(valid)),
      checkOf(
        "tamperedSignature",
        tampered,
        judgeRefusal(tampered, statementRefusal),
      ),
      checkOf(
        "expiredStatement",
        expired,
        judgeRefusal(expired, statementRefusal),
      ),
      checkOf(
        "replayedStatement",
        replayed,
        judgeRefusal(replayed, statementRefusal),
      ),
      // Judged from the valid statement's own exchange: fidelity is a question
      // about the client that was created, not about a request of its own.
      checkOf("metadataFidelity", valid, judgeFidelity(vouched, valid)),
      checkOf(
        "statementOnly",
        outside,
        judgeStatementOnly(vouched, outside, [outsideField]),
      ),
    ];

    const row = await insertHarnessRun(sql, {
      enrolmentId: target.enrolment.id,
      runBy: account.id,
      verdict: harnessVerdict(checks),
      checks,
      cleanup: describeCleanup(attempts),
    });
    // The updated resource, as every mutation answers with: the entry now
    // carries the verdict this run produced.
    return context.json(
      {
        event: eventDetail(target.event),
        system: await entryView(context, target),
        run: harnessRun(row),
      },
      201,
    );
  });

  // Public: the entry's runs, newest first, with whether this caller may add one.
  routes.get("/enrolments/:id/harness-runs", async (context) => {
    const sql = context.get("sql");
    const target = await requireTarget(context, context.req.param("id"));
    const decision = await decideRun(
      context,
      target,
      await currentAccount(context),
    );
    return context.json({
      event: eventDetail(target.event),
      system: await entryView(context, target),
      mayRun: decision.ok,
      runs: (
        await listHarnessRuns(sql, {
          enrolmentId: target.enrolment.id,
          limit: historyLength,
        })
      ).map(harnessRun),
    });
  });

  // Public: one report. A shareable report that needs a sign-in is not evidence
  // (SC-005), so this is answered to anybody.
  routes.get("/harness-runs/:id", async (context) => {
    const row = await findHarnessRun(
      context.get("sql"),
      context.req.param("id"),
    );
    if (row === undefined) {
      throw new HTTPException(404, { message: "No such conformance run." });
    }
    const target = await requireTarget(context, row.enrolmentId);
    return context.json({
      event: eventDetail(target.event),
      system: await entryView(context, target),
      run: harnessRun(row),
    });
  });

  return routes;
};
