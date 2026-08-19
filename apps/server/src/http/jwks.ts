import { Hono } from "hono";

import { ensureActiveSigningKey, publishedJwks } from "../keys/keys.ts";

import type { AppEnvironment } from "../app.ts";
import type { SigningPurpose } from "@muster/contracts";

/**
 * The trust anchor's key set (FR-024).
 *
 * Anonymous, like every public read, because the servers that verify Muster's
 * statements have no account here and no reason to get one. It answers with the
 * active key of each purpose and with every superseded key that still has an
 * unexpired artefact behind it, which is what lets a key be rotated in the middle
 * of an event without invalidating the statements already in flight.
 *
 * Two response properties are the profile's rather than this route's taste. The
 * answer is cacheable only briefly, because the profile requires that
 * verification against a stale cache must not succeed once a key has been
 * withdrawn - a long cache would make a withdrawn key keep working. And it is
 * cross-origin readable, because a verifier is as often a browser as a server.
 *
 * The keys are generated on first read, so a fresh deployment publishes a usable
 * key set without anybody remembering to mint one.
 *
 * @author John Grimes
 */

/** Where the key set is published, as the profile states. */
export const jwksPath = "/.well-known/jwks.json";

/** How long a verifier may cache the key set, in seconds. */
const maximumCacheAgeSeconds = 60;

/** The purposes a key set is published for. */
const publishedPurposes: readonly SigningPurpose[] = ["statements", "tickets"];

/**
 * Builds the key set route.
 *
 * @returns the route, to be mounted at the root
 * @example
 * ```ts
 * app.route("/", createJwksRoutes());
 * ```
 */
export const createJwksRoutes = (): Hono<AppEnvironment> => {
  const routes = new Hono<AppEnvironment>();

  routes.get(jwksPath, async (context) => {
    const sql = context.get("sql");
    const masterKey = context.get("config").masterKey;
    for (const purpose of publishedPurposes) {
      await ensureActiveSigningKey(sql, { purpose, masterKey });
    }
    const jwks = await publishedJwks(sql, new Date());
    return context.json(jwks, 200, {
      "cache-control": `public, max-age=${String(maximumCacheAgeSeconds)}`,
      "access-control-allow-origin": "*",
    });
  });

  return routes;
};
