/**
 * Serving the built console.
 *
 * One process serves the API and the console, which is what makes the session cookie
 * work without CORS and without a second deployment to keep in step. In development
 * this is absent - Vite serves the console on its own port and proxies `/api` here -
 * so everything below is dead code in a developer's terminal and load-bearing in the
 * image, where the Dockerfile sets `MUSTER_WEB_ROOT`.
 *
 * The file serving itself is `@hono/node-server`'s, which already refuses a path
 * containing `..`, a doubled separator or a backslash, and which resolves and streams
 * the file. Reimplementing that would mean owning the traversal checks; what is added
 * here is the part that is Muster's decision rather than the adapter's.
 *
 * **The fallback, and what it must not swallow.** A single-page application needs an
 * unknown path to answer with `index.html` so its router can handle it. Applied
 * blindly, that turns a mistyped `/api/events` into a page of HTML with a 200, which
 * tells a script its request succeeded. So the fallback applies only to paths the API
 * does not own, and only to requests that asked for HTML.
 *
 * Author: John Grimes
 */

import { serveStatic } from "@hono/node-server/serve-static";

import type { MiddlewareHandler } from "hono";

/**
 * Path prefixes the server owns. Never served from disk, never given the shell.
 *
 * Matched as whole segments rather than as string prefixes, so a console route may
 * legitimately begin with the same letters.
 */
const RESERVED_SEGMENTS = new Set(["api", "healthz", "readyz", ".well-known"]);

/**
 * Whether a request path belongs to the server rather than to the console.
 *
 * @param path - The request path.
 * @returns `true` when the console must not answer it.
 * @example
 * ```ts
 * isReservedPath("/api/events"); // true
 * isReservedPath("/events"); // false
 * ```
 */
export function isReservedPath(path: string): boolean {
  const first = path.split("/", 2)[1] ?? "";
  return RESERVED_SEGMENTS.has(first);
}

/**
 * Whether an unmatched request should be answered with the application shell.
 *
 * A navigation asks for HTML; a script's `fetch` does not.
 *
 * @param method - The request method.
 * @param accept - The `Accept` header, if any.
 * @returns `true` when the shell is the right answer.
 */
export function wantsApplicationShell(
  method: string,
  accept: string | undefined,
): boolean {
  return (
    (method === "GET" || method === "HEAD") &&
    accept !== undefined &&
    accept.includes("text/html")
  );
}

/**
 * Serves a file from the built console, or passes the request on.
 *
 * @param root - The directory a Vite build produced, from `MUSTER_WEB_ROOT`.
 * @returns Middleware that answers with the file when there is one.
 */
export function serveConsoleAssets(root: string): MiddlewareHandler {
  const files = serveStatic({ root });
  return async (context, next) => {
    if (isReservedPath(context.req.path)) {
      return await next();
    }
    return await files(context, next);
  };
}

/**
 * Answers a navigation to an unmatched console route with `index.html`.
 *
 * @param root - The directory a Vite build produced.
 * @returns Middleware that answers navigations and passes everything else on, so an
 *   unmatched data request falls through to the JSON 404.
 */
export function serveConsoleShell(root: string): MiddlewareHandler {
  const shell = serveStatic({ root, path: "index.html" });
  return async (context, next) => {
    if (
      isReservedPath(context.req.path) ||
      !wantsApplicationShell(context.req.method, context.req.header("accept"))
    ) {
      return await next();
    }
    return await shell(context, next);
  };
}
