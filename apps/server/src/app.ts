/**
 * Building the Muster application.
 *
 * Kept separate from the process entry point so an integration test can drive it
 * through `app.request()` without opening a socket, which is how every route and every
 * refusal is exercised against a real database.
 *
 * Two decisions live here rather than in any route. Every unmatched path answers with
 * the error envelope, so a caller never has to distinguish "no such route" from a
 * proxy's HTML error page. And every uncaught error answers with a code and nothing
 * else: the message may carry a connection string or a token, so it goes to the
 * server's log and not to the caller.
 *
 * Author: John Grimes
 */

import { pingDatabase } from "@muster/db";
import { Hono } from "hono";

import { API_BASE_PATH, createApiRouter } from "./api/router.js";
import { registerDocsRoutes } from "./http/docs.js";
import { jsonError } from "./http/errors.js";
import { registerJwksRoute } from "./http/jwks.js";
import { serveConsoleAssets, serveConsoleShell } from "./http/staticFiles.js";

import type { MusterEnvironment, ServerContext } from "./context.js";

/**
 * Builds the Hono application.
 *
 * @param context - The server's dependencies. Passed in rather than constructed here,
 *   so a test can substitute a throwaway database and a fixed clock.
 * @returns The application, ready to be served or driven by `app.request()`.
 * @example
 * ```ts
 * const app = createApp({ config, db, mail, clock: () => new Date() });
 * serve({ fetch: app.fetch, port: config.port });
 * ```
 */
export function createApp(context: ServerContext): Hono<MusterEnvironment> {
  const app = new Hono<MusterEnvironment>();

  // Liveness answers from the process alone. A pod whose database is down is still
  // alive, and restarting it would neither fix the database nor help anybody.
  app.get("/healthz", (c) => c.json({ status: "ok" }));

  // Readiness does consult the database: a pod that cannot reach Postgres can serve no
  // request, and should leave the load balancer rather than answering every one with a
  // 500.
  app.get("/readyz", async (c) => {
    try {
      await pingDatabase(context.db);
      return c.json({ status: "ok" });
    } catch {
      return jsonError(c, 503, "database_unreachable");
    }
  });

  // The anchor's own surfaces, which are not under `/api` because their addresses are fixed
  // by other specifications: `.well-known/jwks.json` by RFC 8615, and `/docs/*` by
  // `contracts/http-api.md`. Both are anonymous, and both are declared in `PUBLIC_REQUESTS`
  // with the rest of the public surface so one list covers everything.
  registerJwksRoute(app, context);
  registerDocsRoutes(app, context);

  app.route(API_BASE_PATH, createApiRouter(context));

  // Last, and only when a build is present: the console answers whatever the API did
  // not claim. Mounted here rather than first, which is what keeps an unmatched API
  // route a JSON 404 instead of a page of HTML.
  if (context.config.webRoot !== undefined) {
    app.use("*", serveConsoleAssets(context.config.webRoot));
    app.use("*", serveConsoleShell(context.config.webRoot));
  }

  app.notFound((c) => jsonError(c, 404, "not_found"));

  app.onError((error, c) => {
    // The cause is logged rather than returned. A thrown message can carry a
    // connection string, a token or a client secret, and none of those may reach a
    // caller or a log line a caller can influence.
    console.error(
      JSON.stringify({
        message: "muster.request.failed",
        method: c.req.method,
        path: c.req.path,
        error: error.message,
      }),
    );
    return jsonError(c, 500, "internal_error");
  });

  return app;
}
