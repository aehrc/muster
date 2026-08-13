/**
 * The one shape a refusal arrives in.
 *
 * `{ error, detail? }`, per `contracts/http-api.md`: a stable code the console
 * branches on, and an optional sentence a person reads. Every route refuses through
 * `jsonError`, so there is one place that decides what a refusal looks like and one
 * thing for the console's client to parse.
 *
 * The code is not the status. A 403 can be `revoked_member` or `not_a_member`, and the
 * console shows different things for each; collapsing both into the status would make
 * the API answer "no" without saying why.
 *
 * Author: John Grimes
 */

import type { ErrorEnvelope } from "@muster/contracts";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/**
 * Builds a refusal body.
 *
 * @param error - The machine-readable code.
 * @param detail - A sentence for a person, when there is something to add.
 * @returns The envelope, with `detail` omitted rather than undefined - a serialised
 *   `"detail": null` would be one more case for every caller to handle.
 * @example
 * ```ts
 * errorEnvelope("guarded_address", "10.0.0.1 is not publicly routable");
 * ```
 */
export function errorEnvelope(error: string, detail?: string): ErrorEnvelope {
  return detail === undefined ? { error } : { error, detail };
}

/**
 * Answers a request with a refusal.
 *
 * @param context - The request context.
 * @param status - The HTTP status.
 * @param error - The machine-readable code.
 * @param detail - A sentence for a person.
 * @returns The response, for the handler to return.
 * @example
 * ```ts
 * return jsonError(c, 404, "not_found", "No event has that slug");
 * ```
 */
export function jsonError(
  context: Context,
  status: ContentfulStatusCode,
  error: string,
  detail?: string,
): Response {
  return context.json(errorEnvelope(error, detail), status);
}
