/**
 * Rate limiting the credential routes (FR-035).
 *
 * The arithmetic is in `@muster/core`, pure and unit tested; what is here is the store, the
 * key and the response. Three decisions are worth stating.
 *
 * **The key is the client address and the route, and nothing else.** A key derived from
 * anything in the body lets an attacker spread guesses across keys by varying that value,
 * and lets them exhaust somebody else's allowance by submitting that person's address. The
 * route is the matched pattern rather than the requested path, so a path parameter cannot
 * be used to mint fresh keys.
 *
 * **The client address is the rightmost entry of `X-Forwarded-For`.** Muster runs behind an
 * ingress that sets that header, and the rightmost entry is the one the nearest trusted
 * proxy appended - so a client that forges the header only adds entries to the left of it,
 * which are ignored. Falling back to the connection's own address covers a deployment with
 * no proxy in front of it.
 *
 * **A deployment gets one limiter per instance.** The store is in memory, and Muster runs
 * one instance by constitution, so that is the whole of it. Two replicas would allow twice
 * the limit; a deployment that wanted otherwise would have to say what it wanted instead.
 *
 * Author: John Grimes
 */

import { getConnInfo } from "@hono/node-server/conninfo";
import { admitRequest, isWindowStale, rateLimitKey } from "@muster/core";

import { jsonError } from "./errors.js";

import type { WindowLimit, WindowState } from "@muster/core";
import type { Context, MiddlewareHandler } from "hono";

/**
 * The limits, per client address, for each protected route.
 *
 * Only the credential routes are limited. The public reads are cheap, cacheable and
 * carry nothing worth guessing.
 */
export const RATE_LIMITS = {
  /**
   * Signing in.
   *
   * Ten a minute. A person who has mistyped their password ten times in a minute will not
   * get it right on the eleventh, and ten a minute is four orders of magnitude short of
   * what guessing a twelve-character password needs.
   */
  signIn: { limit: 10, windowMs: 60_000 },
  /**
   * Signing up.
   *
   * Five a minute. Each one sends an email to an address the requester chose, so the limit
   * is as much about not being a mail relay as about the account table.
   */
  signUp: { limit: 5, windowMs: 60_000 },
  /**
   * Redeeming or re-requesting a verification link.
   *
   * Ten a minute, covering both: a token is 256 bits of randomness, so this is not about
   * guessing one - it is about the resend, which sends mail.
   */
  verify: { limit: 10, windowMs: 60_000 },
} as const satisfies Readonly<Record<string, WindowLimit>>;

/** Which limit a route is under. */
export type RateLimitName = keyof typeof RATE_LIMITS;

/** Where a limiter keeps its counters. */
export interface RateLimitStore {
  readonly decide: (key: string, now: number, limit: WindowLimit) => boolean;
  /** When a refused caller may try again, in epoch milliseconds. */
  readonly retryAt: (key: string, now: number, limit: WindowLimit) => number;
}

/**
 * How many decisions between sweeps of the store.
 *
 * Swept on a counter rather than on a timer: a timer keeps the process awake, has to be
 * cleared in every test that builds an application, and buys nothing here - the store only
 * grows when requests arrive, so a request is exactly when it is worth tidying.
 */
const SWEEP_EVERY = 200;

/**
 * Builds an in-memory limiter.
 *
 * @returns The store, which decides and remembers.
 * @example
 * ```ts
 * const context = { ...rest, rateLimits: createRateLimitStore() };
 * ```
 */
export function createRateLimitStore(): RateLimitStore {
  const states = new Map<string, WindowState>();
  let sinceSweep = 0;

  /** Drops the keys whose counters no longer carry information. */
  const sweep = (now: number, windowMs: number): void => {
    for (const [key, state] of states) {
      if (isWindowStale(state, now, windowMs)) {
        states.delete(key);
      }
    }
  };

  return {
    decide: (key, now, limit) => {
      sinceSweep += 1;
      if (sinceSweep >= SWEEP_EVERY) {
        sinceSweep = 0;
        sweep(now, limit.windowMs);
      }
      const decision = admitRequest(states.get(key), now, limit);
      states.set(key, decision.state);
      return decision.allowed;
    },
    retryAt: (key, now, limit) => {
      const state = states.get(key);
      return state === undefined
        ? now + limit.windowMs
        : admitRequest(state, now, limit).retryAt;
    },
  };
}

/**
 * Builds a limiter that admits everything.
 *
 * For the integration suites, which drive far more sign-ins per frozen minute than a person
 * could. A suite whose subject is the limiter asks for the real one.
 *
 * @returns A store that never refuses.
 */
export function createUnlimitedStore(): RateLimitStore {
  return { decide: () => true, retryAt: (_key, now) => now };
}

/**
 * The address a request arrived from.
 *
 * @param c - The request context.
 * @returns The client address, or `"unknown"` when neither the header nor the connection
 *   names one - which groups those requests together rather than exempting them.
 */
export function clientAddress(c: Context): string {
  const forwarded = c.req.header("x-forwarded-for");
  if (forwarded !== undefined) {
    // The rightmost entry: the one the nearest trusted proxy appended. Anything a client
    // forged sits to the left of it.
    const hops = forwarded
      .split(",")
      .map((hop) => hop.trim())
      .filter((hop) => hop.length > 0);
    const nearest = hops.at(-1);
    if (nearest !== undefined) {
      return nearest;
    }
  }
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    // `app.request()` has no socket behind it, which is how every route test runs.
    return "unknown";
  }
}

/**
 * Refuses or admits a request under one of the {@link RATE_LIMITS}.
 *
 * The store and the clock are passed rather than reached for, so a suite can pin the
 * instant and choose between the real limiter and one that admits everything.
 *
 * @returns Hono middleware.
 * @example
 * ```ts
 * router.post("/auth/sign-in", rateLimit("signIn", context), signInHandler(context));
 * ```
 */
export function rateLimit(
  name: RateLimitName,
  context: {
    readonly rateLimits: RateLimitStore;
    readonly clock: () => Date;
  },
): MiddlewareHandler {
  const limit = RATE_LIMITS[name];
  return async (c, next) => {
    const store = context.rateLimits;
    const now = context.clock().getTime();
    const key = rateLimitKey(clientAddress(c), `${name}:${c.req.routePath}`);
    if (store.decide(key, now, limit)) {
      await next();
      return;
    }

    const seconds = Math.max(
      1,
      Math.ceil((store.retryAt(key, now, limit) - now) / 1000),
    );
    c.header("Retry-After", String(seconds));
    // The message says nothing about whether the account exists: a limit that leaked that
    // would be a better enumeration oracle than the route it protects.
    return jsonError(
      c,
      429,
      "too_many_requests",
      `Too many attempts. Try again in ${String(seconds)} seconds.`,
    );
  };
}
