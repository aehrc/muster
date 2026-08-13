/**
 * Whether a path segment could be one of Muster's identifiers.
 *
 * Every identifier in this schema is a UUID, and every route that names one reads it out of a
 * URL. A route that handed a malformed one to Postgres got a driver error rather than an
 * answer, which surfaced as a 500 - so `/api/events/sparked/systems/undefined` reported an
 * internal error rather than "no such system", and a public read surface answered a bad request
 * by looking broken.
 *
 * The check is a shape test rather than a validation of a real identifier: something that is
 * not a UUID cannot name a row, and something that is a UUID and names nothing is the 404 the
 * routes already answer with. Both cases end in the same answer, which is the point - a caller
 * learns nothing from the difference, and neither does an enumerator.
 *
 * Author: John Grimes
 */

/** RFC 9562's textual form, in any version. */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether a value has the shape of one of Muster's identifiers.
 *
 * @param value - The path segment, as it arrived.
 * @returns `true` when it could name a row.
 * @example
 * ```ts
 * if (!isIdentifier(c.req.param("id"))) {
 *   return jsonError(c, 404, "not_found", "No enrolment has that id");
 * }
 * ```
 */
export function isIdentifier(value: string): boolean {
  return UUID_PATTERN.test(value);
}
