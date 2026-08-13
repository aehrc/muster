/**
 * Reading and validating a request body.
 *
 * Every mutating handler starts the same way - parse JSON, validate against a contract,
 * refuse with something the participant can act on if it does not hold - and doing that
 * inline in each would be thirty copies of the same four lines, one of which would
 * eventually forget to name the field.
 *
 * A body that is not JSON at all is treated as an empty object rather than as a parse
 * error, so the response describes the fields that are missing instead of complaining about
 * syntax the sender can already see.
 *
 * The error envelope has no `issues` array - `contracts/http-api.md` fixes it at
 * `{ error, detail? }` - so the field-level problems are joined into `detail`. That is
 * enough for the console to show beside the form and enough for a person reading a `curl`
 * response.
 *
 * Author: John Grimes
 */

import { jsonError } from "./errors.js";

import type { Context } from "hono";
import type { output, ZodError, ZodType } from "zod";

/**
 * Describes every field-level problem in one sentence.
 *
 * The path is joined with dots, array indices included, so `redirectUris.0` addresses the
 * same field the console rendered.
 *
 * @param error - The validation failure.
 * @returns A human-readable summary naming each offending field.
 * @example
 * ```ts
 * detailFromZodError(error); // "redirectUris.0: Invalid URL; scopes: Too small"
 * ```
 */
export function detailFromZodError(error: ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.map(String).join(".");
      return path.length === 0 ? issue.message : `${path}: ${issue.message}`;
    })
    .join("; ");
}

/**
 * Reads and validates a request body.
 *
 * @param c - The request context.
 * @param schema - The contract the body must satisfy.
 * @returns The parsed body, or the refusal to return from the handler.
 * @example
 * ```ts
 * const body = await parseBody(c, signUpSchema);
 * if (body instanceof Response) {
 *   return body;
 * }
 * ```
 */
export async function parseBody<S extends ZodType>(
  c: Context,
  schema: S,
): Promise<output<S> | Response> {
  const raw: unknown = await c.req.json().catch(() => ({}));
  const result = schema.safeParse(raw);
  if (!result.success) {
    return jsonError(
      c,
      400,
      "invalid_request",
      detailFromZodError(result.error),
    );
  }
  return result.data;
}
