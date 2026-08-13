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
