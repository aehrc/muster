import {
  resendVerificationRequestSchema,
  signInRequestSchema,
  signUpRequestSchema,
  verifyRequestSchema,
} from "@muster/contracts";
import {
  authoriseToken,
  authoriseVerificationResend,
  consume,
  emptyWindow,
  verificationTokenLifetimeMs,
} from "@muster/core";
import {
  findAccountByEmail,
  findAccountById,
  findAccountTokenByHash,
  insertAccount,
  insertAccountToken,
  isUniqueViolation,
  listMembershipsForAccount,
  listNotifiableAdmins,
  markAccountTokenUsed,
  markAccountVerified,
  supersedeAccountTokens,
} from "@muster/db";
import { Hono } from "hono";
import { getConnInfo } from "hono/bun";
import { HTTPException } from "hono/http-exception";

import {
  createOpaqueToken,
  endSession,
  factsFor,
  hashToken,
  refusalError,
  requireAccount,
  startSession,
} from "./sessions.ts";
import { accountView } from "../http/views.ts";
import {
  awaitingApprovalMessage,
  verificationMessage,
  verificationResendMessage,
} from "../mail/messages.ts";

import type { AppEnvironment } from "../app.ts";
import type { SessionView } from "@muster/contracts";
import type { RateLimitPolicy, SlidingWindow } from "@muster/core";
import type { AccountRow } from "@muster/db";
import type { SQL } from "bun";
import type { Context, MiddlewareHandler } from "hono";
import type { z } from "zod";

/**
 * Sign-up, email verification, sign-in, sign-out, and who the caller is.
 *
 * An account is created pending: verifying the address proves control of it,
 * and approval by a track admin is a separate decision that no one taking this
 * route can make for themselves (FR-001, FR-002). Both facts are reported by
 * `/api/auth/me`, so the console can show a member exactly where they are.
 *
 * A verification link works once and lives a day, so the resend is what keeps
 * FR-001's promise reachable after one lapses. It is asked for by address, since
 * whoever needs it has just been refused on a screen they are not signed in on,
 * and it answers every caller identically: what differs is only what arrives in
 * the mailbox.
 *
 * These are the routes an attacker reaches without an account, so they are rate
 * limited by client address and route (FR-035), passwords are hashed with
 * argon2id and never logged (FR-036), and a failed sign-in says nothing about
 * whether the address exists.
 *
 * @author John Grimes
 */

/**
 * How many credential attempts one address may make on one route.
 *
 * Ten a minute is far above what a person does and far below what a guessing
 * script needs.
 */
export const authRateLimitPolicy: RateLimitPolicy = {
  limit: 10,
  windowMs: 60_000,
};

/** The answer to a sign-in with credentials that were not recognised. */
const credentialRefusal = "Those credentials were not recognised.";

/**
 * Reads the client's address.
 *
 * A proxy's `X-Forwarded-For` is trusted when present, because Muster is
 * deployed behind one; the direct peer address is used otherwise. When neither
 * is available - which is the case when a suite drives the application in
 * process - every caller shares one bucket, which is the safe direction.
 *
 * @param context - the request being answered
 * @returns the address to key the limiter by
 */
const clientAddress = (context: Context<AppEnvironment>): string => {
  const forwarded = context.req.header("x-forwarded-for");
  if (forwarded !== undefined && forwarded.length > 0) {
    return forwarded.split(",")[0]?.trim() ?? "unknown";
  }
  try {
    return getConnInfo(context).remote.address ?? "unknown";
  } catch {
    // An in-process request has no peer; one bucket for all of them is the safe
    // direction, and it is what makes the limit testable.
    return "unknown";
  }
};

/**
 * Reads the caller's account and memberships.
 *
 * @param sql - the serving connection
 * @param account - the account as stored
 * @returns who the caller is
 */
const sessionView = async (
  sql: SQL,
  account: AccountRow,
): Promise<SessionView> => ({
  account: accountView(account),
  memberships: await listMembershipsForAccount(sql, account.id),
});

/**
 * Parses a JSON body against a schema.
 *
 * An unparseable body is a 400 naming the offending fields and nothing else: a
 * validation message that echoed the body would echo the password.
 *
 * @param context - the request being answered
 * @param schema - the schema the body must satisfy
 * @returns the parsed body
 * @throws {HTTPException} 400 when the body is absent or does not satisfy the
 *   schema
 */
export const parseBody = async <Schema extends z.ZodType>(
  context: Context<AppEnvironment>,
  schema: Schema,
): Promise<z.output<Schema>> => {
  let body: unknown;
  try {
    body = await context.req.json();
  } catch {
    throw new HTTPException(400, { message: "A JSON body is required." });
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const fields = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`)
      .join("; ");
    throw new HTTPException(400, { message: fields });
  }
  return parsed.data;
};

/** The limiter's state, held by the routes that own it. */
type LimiterState = {
  /** the window carried from one attempt to the next */
  window: SlidingWindow;
};

/**
 * Builds the credential rate limiter.
 *
 * @param state - the window this limiter carries forward
 * @returns the middleware
 */
const rateLimit =
  (state: LimiterState): MiddlewareHandler<AppEnvironment> =>
  async (context, next) => {
    const decision = consume({
      window: state.window,
      address: clientAddress(context),
      route: `${context.req.method} ${new URL(context.req.url).pathname}`,
      now: Date.now(),
      policy: authRateLimitPolicy,
    });
    state.window = decision.window;
    if (!decision.allowed) {
      // Answered here rather than thrown, so the wait reaches the caller as a
      // header they can act on.
      const detail = `Too many attempts. Try again in ${String(decision.retryAfterSeconds)} seconds.`;
      return context.json({ error: "rate_limited", detail }, 429, {
        "Retry-After": String(decision.retryAfterSeconds),
      });
    }
    await next();
    return undefined;
  };

/**
 * Builds the auth routes.
 *
 * The rate limiter's window belongs to the returned routes rather than to the
 * module, so one application's refusals cannot leak into another's - which is
 * what makes the limit testable.
 *
 * @returns the routes, to be mounted under `/api/auth`
 * @example
 * ```ts
 * app.route("/api/auth", createAuthRoutes());
 * ```
 */
export const createAuthRoutes = (): Hono<AppEnvironment> => {
  const routes = new Hono<AppEnvironment>();

  // FR-035: the routes that take a credential, spend a token or mint one, keyed by
  // address and route and nothing else. A refused attempt is answered with the
  // wait, so a client that backs off is let back in.
  //
  // Reading the session and signing out are deliberately not limited. A
  // connectathon venue is behind one address, and the console asks who the caller
  // is on every screen it renders: a limit on that would lock a whole room out of
  // the console between them. Neither route accepts a password or spends a
  // single-use token, which is what a limit is for; the session cookie they do
  // read is a 256-bit opaque token that is not worth guessing at.
  const limiter = rateLimit({ window: emptyWindow });
  routes.use("/sign-up", limiter);
  routes.use("/sign-in", limiter);
  routes.use("/verify", limiter);
  routes.use("/resend-verification", limiter);

  routes.post("/sign-up", async (context) => {
    const body = await parseBody(context, signUpRequestSchema);
    const sql = context.get("sql");
    const config = context.get("config");

    let account: AccountRow;
    try {
      account = await insertAccount(sql, {
        email: body.email,
        displayName: body.displayName,
        passwordHash: await Bun.password.hash(body.password, "argon2id"),
      });
    } catch (cause) {
      if (isUniqueViolation(cause)) {
        throw new HTTPException(409, {
          message: "An account already exists for that address.",
        });
      }
      throw cause;
    }

    const token = createOpaqueToken();
    await insertAccountToken(sql, {
      accountId: account.id,
      tokenHash: hashToken(token),
      purpose: "emailVerification",
      expiresAt: new Date(Date.now() + verificationTokenLifetimeMs),
    });
    const mail = context.get("mail");
    await mail.send(verificationMessage(config, account.email, token));

    // FR-003: the admins are told there is someone waiting, so approval does
    // not depend on anyone remembering to look.
    const admins = await listNotifiableAdmins(sql);
    if (admins.length > 0) {
      await mail.send(
        awaitingApprovalMessage(
          config,
          admins.map((admin) => admin.email),
          account,
        ),
      );
    }

    return context.json({ account: accountView(account) }, 201);
  });

  // The other half of the spec's edge case: a link used twice or used late fails
  // with an offer to resend, and this is what the offer does. Answered the same
  // way whatever was true of the address - no account, an account already
  // verified, or one still waiting - because an anonymous caller must not learn
  // from it which addresses hold accounts. What differs is what is sent, which
  // only the holder of the address ever sees.
  routes.post("/resend-verification", async (context) => {
    const body = await parseBody(context, resendVerificationRequestSchema);
    const sql = context.get("sql");
    const account = await findAccountByEmail(sql, body.email);
    const permitted =
      account === undefined
        ? undefined
        : authoriseVerificationResend(factsFor(account));
    if (account !== undefined && permitted?.ok === true) {
      // One live link at a time: whatever was outstanding is retired first, so a
      // resend cannot leave two usable links behind it.
      const now = new Date();
      await supersedeAccountTokens(sql, {
        accountId: account.id,
        purpose: "emailVerification",
        at: now,
      });
      const token = createOpaqueToken();
      await insertAccountToken(sql, {
        accountId: account.id,
        tokenHash: hashToken(token),
        purpose: "emailVerification",
        expiresAt: new Date(now.getTime() + verificationTokenLifetimeMs),
      });
      await context
        .get("mail")
        .send(
          verificationResendMessage(
            context.get("config"),
            account.email,
            token,
          ),
        );
    }
    return context.json({ requested: true } as const, 202);
  });

  routes.post("/verify", async (context) => {
    const body = await parseBody(context, verifyRequestSchema);
    const sql = context.get("sql");
    const token = await findAccountTokenByHash(sql, hashToken(body.token));
    if (token === undefined || token.purpose !== "emailVerification") {
      throw new HTTPException(422, {
        message: "That verification link is not one Muster issued.",
      });
    }
    const decision = authoriseToken(token, new Date());
    if (!decision.ok) {
      throw refusalError(decision.refusal);
    }

    const now = new Date();
    await markAccountTokenUsed(sql, { id: token.id, at: now });
    const account = await markAccountVerified(sql, token.accountId, now);
    if (account === undefined) {
      throw new HTTPException(422, {
        message: "That verification link is not one Muster issued.",
      });
    }
    return context.json({ account: accountView(account) });
  });

  routes.post("/sign-in", async (context) => {
    const body = await parseBody(context, signInRequestSchema);
    const sql = context.get("sql");
    const account = await findAccountByEmail(sql, body.email);
    // The same answer either way: the reply says nothing about which addresses
    // hold accounts. The hash is verified even when there is no account, so the
    // timing says nothing either.
    const matched = await Bun.password.verify(
      body.password,
      account?.passwordHash ?? placeholderHash,
    );
    if (account === undefined || !matched) {
      throw new HTTPException(401, { message: credentialRefusal });
    }

    await startSession(context, account.id);
    return context.json(await sessionView(sql, account));
  });

  routes.post("/sign-out", async (context) => {
    await endSession(context);
    return context.json({ signedOut: true });
  });

  routes.get("/me", async (context) => {
    const account = await requireAccount(context);
    // Read again rather than trusting the session's copy: an approval or a
    // revocation applies to the session already open.
    const current = await findAccountById(context.get("sql"), account.id);
    return context.json(
      await sessionView(context.get("sql"), current ?? account),
    );
  });

  return routes;
};

/**
 * An argon2id hash of a value no one holds.
 *
 * Verifying against it costs what verifying a real hash costs, so a sign-in for
 * an address with no account takes the same time as one with the wrong
 * password.
 */
const placeholderHash = await Bun.password.hash(
  crypto.randomUUID(),
  "argon2id",
);
