import { Hono } from "hono";
import { stat } from "node:fs/promises";
import { posix, relative, resolve, sep } from "node:path";

import type { AppEnvironment } from "../app.ts";

/**
 * Serving the built console.
 *
 * Muster deploys as one container: the JSON API and the console come out of the
 * same process, so a release is one image, one service and one public URL. That
 * is what keeps `MUSTER_PUBLIC_URL` the single source of every address, and it is
 * the reason the Helm chart has no second deployment for a static site.
 *
 * Three rules, in the order they are applied. A path that names a file inside the
 * configured directory is served as that file. A path that does not, and does not
 * look like a file, is answered with the document, because a console route like
 * `/pairings/abc` exists only in the browser's router. Anything under `/api` or
 * `/.well-known` is left alone, so a caller reading JSON is never handed HTML.
 *
 * Nothing outside the configured directory is reachable. The resolved path is
 * required to stay inside it, so a traversal in the request - however it is
 * encoded - reaches the fallback rather than the file system.
 *
 * A deployment with no console directory is a legitimate configuration: it serves
 * the API alone, and says so in the start-up log rather than answering HTML that
 * is not there.
 *
 * @author John Grimes
 */

/**
 * The prefixes this module never answers.
 *
 * The API routes are mounted first, so only paths they do not match arrive here,
 * and those must keep answering in the error envelope rather than as a document.
 */
const reservedPrefixes: readonly string[] = ["/api", "/.well-known"];

/** The document the console is bootstrapped from. */
const documentName = "index.html";

/**
 * How long a content-hashed asset may be cached. Vite names every asset by its
 * content, so an asset that changes changes its name.
 */
const assetCacheControl = "public, max-age=31536000, immutable";

/**
 * The document is revalidated every time, or a deployment would not take effect
 * in a browser that already has it.
 */
const documentCacheControl = "no-cache";

/** The directory Vite writes content-hashed assets into. */
const assetDirectory = "assets";

/**
 * The headers every document and asset carries.
 *
 * The console and the API share an origin, which is what makes these worth
 * sending: a policy that allows this origin and nothing else, no framing by
 * anybody, and no content-type guessing. Inline styles are allowed because React
 * sets style attributes; inline scripts are not, and the console has none - Vite
 * emits the whole of it as files.
 */
const securityHeaders: Readonly<Record<string, string>> = {
  "content-security-policy": [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; "),
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

/**
 * Resolves a request path to a file inside the served directory.
 *
 * @param directory - the directory the console is served from
 * @param pathname - the request path, as it arrived
 * @returns the absolute path of the file, or undefined when there is no such
 *   file inside the directory
 */
const fileWithin = async (
  directory: string,
  pathname: string,
): Promise<string | undefined> => {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    // An undecodable path is not a path to anything.
    return undefined;
  }
  const root = resolve(directory);
  // Normalising first collapses `..` segments, and resolving then puts the
  // result somewhere absolute; the containment check is what refuses a path that
  // climbed out, whatever notation it climbed out with.
  const target = resolve(root, `.${posix.normalize(decoded)}`);
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    return undefined;
  }
  try {
    const found = await stat(target);
    return found.isFile() ? target : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Builds the response for a file inside the served directory.
 *
 * The cache header is decided by where the file turned out to be rather than by
 * what the request looked like: `/assets/../index.html` is the document, and a
 * document cached for a year is a deployment that never takes effect.
 *
 * @param file - the absolute path of the file to serve
 * @param root - the directory being served
 * @returns the response
 */
const serve = (file: string, root: string): Response => {
  const within = relative(root, file);
  const cacheControl = within.startsWith(`${assetDirectory}${sep}`)
    ? assetCacheControl
    : documentCacheControl;
  return new Response(Bun.file(file), {
    headers: { ...securityHeaders, "cache-control": cacheControl },
  });
};

/**
 * Reports whether a path is asking for a file rather than a console route.
 *
 * A last segment with a dot in it is an asset request, and a missing asset is a
 * 404: answering it with the document would hand a browser HTML where it asked
 * for a script.
 *
 * @param pathname - the request path
 * @returns true when the path names a file
 */
const looksLikeAFile = (pathname: string): boolean =>
  (pathname.split("/").at(-1) ?? "").includes(".");

/**
 * Builds the console routes.
 *
 * Mount these last, after every API route: they answer whatever is left.
 *
 * @returns the routes, to be mounted at the root
 * @example
 * ```ts
 * app.route("/", createWebAppRoutes());
 * ```
 */
export const createWebAppRoutes = (): Hono<AppEnvironment> => {
  const routes = new Hono<AppEnvironment>();

  routes.get("*", async (context, next) => {
    const pathname = new URL(context.req.url).pathname;
    if (
      reservedPrefixes.some(
        (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
      )
    ) {
      return next();
    }

    const directory = context.get("config").webDirectory;
    const root = resolve(directory);
    const file = await fileWithin(directory, pathname);
    if (file !== undefined) {
      return serve(file, root);
    }
    if (looksLikeAFile(pathname)) {
      return next();
    }

    // The console's own router owns this path, so it is handed the document.
    const fallback = await fileWithin(directory, `/${documentName}`);
    return fallback === undefined ? next() : serve(fallback, root);
  });

  return routes;
};
