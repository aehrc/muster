/**
 * Who is calling, and whether they may.
 *
 * Two middlewares, and the split is the point. {@link resolveSession} establishes *who*
 * without refusing anybody: every public read surface is reachable without an account
 * (constitution principle V), so the presence of a session is information rather than a
 * precondition. {@link requireApproved} and {@link requireAdmin} then refuse, and they are
 * attached per route because authority varies per route rather than per path prefix -
 * `GET /api/events/:slug` and `POST /api/events/:slug/enrolments` share a prefix and share
 * nothing else.
 *
 * Attaching a guard per route fails in the direction of publishing a route by omission, so
 * that omission is tested rather than trusted: `PUBLIC_REQUESTS` in `../api/router.ts`
 * enumerates every request answerable without a session, and a test compares the declaration
 * against the application's own route table in both directions.
 *
 * The refusal codes come from `writeRefusal` in `@muster/core`, so the reason the console
 * shows and the reason the server gave are the same string.
 *
 * Author: John Grimes
 */

import { writeRefusal } from "@muster/core";
import { findAccountBySessionToken } from "@muster/db";

import { presentedSessionToken } from "./sessions.js";
import { hashToken } from "./tokens.js";
import { jsonError } from "../http/errors.js";

import type { MusterEnvironment, ServerContext } from "../context.js";
import type { WriteRefusal } from "@muster/core";
import type { Context, MiddlewareHandler } from "hono";

/**
 * Puts the signed-in account on the request, when there is one.
 *
 * Refuses nothing. A request with no cookie, an unknown cookie or an expired one continues
 * as anonymous, which is how every public page is read.
 *
 * @param context - The server's dependencies.
 * @returns Hono middleware.
 * @example
 * ```ts
 * router.use("*", resolveSession(context));
 * ```
 */
export function resolveSession(
  context: ServerContext,
): MiddlewareHandler<MusterEnvironment> {
  return async (c, next) => {
    const token = presentedSessionToken(c.req.header("cookie"));
    if (token !== undefined) {
      const account = await findAccountBySessionToken(
        context.db,
        hashToken(token),
        context.clock(),
      );
      if (account !== undefined) {
        c.set("account", account);
      }
    }
    await next();
  };
}

/**
 * Refuses the request unless an approved, verified account is signed in.
 *
 * The one gate on every create, edit and members-only read.
 *
 * @returns Hono middleware.
 * @example
 * ```ts
 * router.post("/organisations", requireApproved(), createOrganisationHandler(context));
 * ```
 */
export function requireApproved(): MiddlewareHandler<MusterEnvironment> {
  return approvedGate;
}

/** The guard {@link requireApproved} returns. */
const approvedGate: MiddlewareHandler<MusterEnvironment> = async (c, next) => {
  const refusal = standingRefusal(c);
  if (refusal !== undefined) {
    return refusal;
  }
  await next();
  return;
};

/**
 * Refuses the request unless the caller is an approved track admin (FR-004).
 *
 * Written alongside {@link requireApproved} rather than wrapped around it, because the two
 * share the standing check and nothing else - and a middleware nested inside another
 * middleware's `next` is one of the few places where a refusal quietly becomes a success.
 *
 * @returns Hono middleware.
 */
export function requireAdmin(): MiddlewareHandler<MusterEnvironment> {
  return adminGate;
}

/** The guard {@link requireAdmin} returns. */
const adminGate: MiddlewareHandler<MusterEnvironment> = async (c, next) => {
  const refusal = standingRefusal(c);
  if (refusal !== undefined) {
    return refusal;
  }
  if (c.get("account")?.isAdmin !== true) {
    return jsonError(
      c,
      403,
      "not_an_admin",
      "This operation is for track admins",
    );
  }
  await next();
  return;
};

/**
 * Why this request may not proceed, or `undefined` when it may.
 *
 * The three ways it can refuse are distinct codes rather than one `forbidden`, because the
 * console shows a different thing for each: verify your address, wait for an admin, or talk
 * to the organisers.
 */
function standingRefusal(c: Context<MusterEnvironment>): Response | undefined {
  const account = c.get("account");
  if (account === undefined) {
    return jsonError(
      c,
      401,
      "not_signed_in",
      "Sign in to use this part of the directory",
    );
  }
  const refusal = writeRefusal(account);
  return refusal === undefined
    ? undefined
    : jsonError(c, 403, refusal, refusalDetail(refusal));
}

/** What to tell the holder of an account that may not write. */
function refusalDetail(refusal: WriteRefusal): string {
  switch (refusal) {
    case "email_unverified": {
      return "Follow the verification link in your email first";
    }
    case "awaiting_approval": {
      return "A track admin has yet to approve this account";
    }
    default: {
      return "This account's membership has been revoked";
    }
  }
}
