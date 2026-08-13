/**
 * The trust anchor's public keys, at the address RFC 8615 puts them.
 *
 * The whole of FR-024's first half, and it is four lines because everything difficult about
 * it lives elsewhere: which keys to publish is a question about outstanding artefacts and is
 * answered by `listPublishedSigningKeys`, and what a key looks like was decided when it was
 * made and is stored as the document served here.
 *
 * Three response headers matter, and each for a stated reason.
 *
 * `application/jwk-set+json` per RFC 7517 §8.5, because several JWKS clients accept only
 * that or `application/json` and the more specific one is the one that says what this is.
 *
 * A five-minute cache, because a vendor's verifier fetches this whenever it meets a `kid` it
 * does not know: without a cache that is one request per registration, and with a longer one
 * a rotation would take an hour to be visible. The profile requires a verifier to refetch on
 * an unknown `kid`, and five minutes is short enough that a withdrawn key stops verifying
 * promptly.
 *
 * `Access-Control-Allow-Origin: *`, because a browser-based verifier cannot read it
 * otherwise, and because this response is public by construction - it contains only public
 * keys and the route reads no cookie.
 *
 * Author: John Grimes
 */

import { publishedJwks } from "../keys/keys.js";

import type { MusterEnvironment, ServerContext } from "../context.js";
import type { Hono } from "hono";

/** The media type a JWK Set is published under (RFC 7517 §8.5). */
const JWK_SET_JSON = "application/jwk-set+json; charset=UTF-8";

/** How long a verifier may cache the document. See the module header. */
const CACHE_CONTROL = "public, max-age=300";

/**
 * Registers `GET /.well-known/jwks.json`.
 *
 * Attached to the application rather than to the `/api` router, because the address is fixed
 * by RFC 8615 and not by this project.
 *
 * @param app - The application.
 * @param context - The server's dependencies.
 * @example
 * ```ts
 * registerJwksRoute(app, context);
 * ```
 */
export function registerJwksRoute(
  app: Hono<MusterEnvironment>,
  context: ServerContext,
): void {
  app.get("/.well-known/jwks.json", async (c) => {
    const document = await publishedJwks(context.db, context.clock());
    // Serialised here rather than through `c.json`, which would label a JWK Set
    // `application/json`.
    return c.body(JSON.stringify(document), 200, {
      "content-type": JWK_SET_JSON,
      "cache-control": CACHE_CONTROL,
      "access-control-allow-origin": "*",
    });
  });
}
