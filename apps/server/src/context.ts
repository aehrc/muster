/**
 * What every route is given, and what every route may read off a request.
 *
 * Passed in rather than reached for, so an integration test can substitute a throwaway
 * database, a recording mail transport, a limiter that admits everything and a fixed clock,
 * and drive the whole application through `app.request()` without opening a socket.
 *
 * Author: John Grimes
 */

import type { MusterConfig } from "./config.js";
import type { RateLimitStore } from "./http/rateLimit.js";
import type { MailTransport } from "./mail/transport.js";
import type {
  AddressResolver,
  OutboundFetchImpl,
} from "./outbound/outboundFetch.js";
import type { AccountRow } from "@muster/db";
import type { Database } from "@muster/db";

/** The server's dependencies. */
export interface ServerContext {
  readonly config: MusterConfig;
  readonly db: Database;
  readonly mail: MailTransport;
  /**
   * Where the credential routes' counters live.
   *
   * On the context rather than inside the middleware, so that one store serves every route
   * and a suite can choose one that admits everything.
   */
  readonly rateLimits: RateLimitStore;
  /**
   * The current time.
   *
   * Injected because the domain rules that decide expiry and validity are pure and take a
   * time; the server is where that time comes from.
   */
  readonly clock: () => Date;
  /**
   * The transport and resolver the outbound guard uses.
   *
   * Absent in a deployment, which is what makes the guard's own defaults - the real `fetch`
   * and the system resolver - the production behaviour. Present in a suite, so that a route
   * whose subject is what it does with a server's answer can be driven without a network,
   * and without a second code path to reach the network by.
   */
  readonly outbound?: OutboundInjection;
}

/** Where a suite substitutes the network. */
export interface OutboundInjection {
  readonly fetchImpl?: OutboundFetchImpl;
  readonly resolve?: AddressResolver;
}

/**
 * The guard's injection points, as options to pass it.
 *
 * Written once because every route that fetches a participant address needs the same three
 * lines, and two copies of "spread it only when it is present" is two chances to spread a
 * literal `undefined` - which would override the guard's production defaults with nothing.
 *
 * @param outbound - The injection, absent in a deployment.
 * @returns The options to merge into an `outboundFetch` call.
 * @example
 * ```ts
 * await outboundFetch(url, { allowedHosts, ...injectedOutbound(context.outbound) });
 * ```
 */
export function injectedOutbound(outbound: OutboundInjection | undefined): {
  readonly fetchImpl?: OutboundFetchImpl;
  readonly resolve?: AddressResolver;
} {
  return {
    ...(outbound?.fetchImpl === undefined
      ? {}
      : { fetchImpl: outbound.fetchImpl }),
    ...(outbound?.resolve === undefined ? {} : { resolve: outbound.resolve }),
  };
}

/**
 * Hono's per-request variable map.
 *
 * Declared once so `c.get("account")` is typed at every call site rather than widened to
 * `any` by an untyped Hono generic.
 */
export interface MusterVariables {
  /**
   * The signed-in account.
   *
   * Optional, and that is deliberate: every public read surface is reachable without an
   * account, so a route that reads this has to say what it does when there is none. The
   * guards in `auth/middleware.ts` are what turn it into a guarantee for the routes that
   * need one.
   */
  readonly account?: AccountRow;
}

/** Hono's generic parameter for a Muster app or router. */
export interface MusterEnvironment {
  readonly Variables: MusterVariables;
}
