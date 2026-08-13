/**
 * How the console understands a refusal.
 *
 * The API answers a refusal with `{ error, detail? }` - a code to branch on and,
 * usually, a sentence to read. Turning that into something the interface can use is
 * done here, once, because every page needs the same three answers: what to show, and
 * whether this means "sign in" (FR-037).
 *
 * `ApiError` is a class, which is the one exception the coding conventions make: it
 * subclasses `Error` so that it can be thrown, caught by TanStack Query and
 * distinguished with `instanceof`.
 *
 * Author: John Grimes
 */

/** A refusal from the API. */
export class ApiError extends Error {
  /** The HTTP status, for the cases where the code is not enough. */
  public readonly status: number;
  /** The API's own code: `not_found`, `forbidden`, `guarded_address`, and so on. */
  public readonly code: string;
  /**
   * Whatever the response body parsed to.
   *
   * Kept because one refusal carries more than the envelope: a duplicate pairing request answers
   * with the existing pairing's identifier, and FR-015 asks the console to link to it rather than
   * mention it. Reading it is {@link conflictingPairingId}'s job, so no page touches this
   * directly.
   */
  public readonly body: unknown;

  /**
   * @param status - The HTTP status.
   * @param code - The API error code.
   * @param message - What to show a person.
   * @param body - The parsed response body, when there was one.
   */
  public constructor(
    status: number,
    code: string,
    message: string,
    body?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

/**
 * Builds an {@link ApiError} from a response body.
 *
 * Tolerant of a body that is not the envelope: a proxy returning an HTML error page, or
 * a crash producing plain text, must still surface as a readable message rather than as
 * a parse failure inside an error handler.
 *
 * @param status - The HTTP status.
 * @param body - Whatever the response body parsed to, if it parsed at all.
 * @returns The error to throw.
 * @example
 * ```ts
 * throw toApiError(response.status, await response.json());
 * ```
 */
export function toApiError(status: number, body: unknown): ApiError {
  const record =
    typeof body === "object" && body !== null
      ? (body as Record<string, unknown>)
      : {};

  const code = typeof record["error"] === "string" ? record["error"] : "error";
  const detail =
    typeof record["detail"] === "string" ? record["detail"] : undefined;

  // The code itself is a better fallback than a generic sentence: `conflict` at least
  // says what happened, where "the request failed" says nothing.
  const message =
    detail ??
    (code === "error" ? `The server answered ${String(status)}` : code);

  return new ApiError(status, code, message, body);
}

/**
 * The pairing a duplicate request collided with (FR-015).
 *
 * @param error - The value that was thrown.
 * @returns The existing pairing's identifier, or `undefined` for any other failure.
 * @example
 * ```ts
 * const existing = conflictingPairingId(request.error);
 * {existing === undefined ? null : <Link to={pairingPath(existing)}>the pairing you already have</Link>}
 * ```
 */
export function conflictingPairingId(error: unknown): string | undefined {
  if (!(error instanceof ApiError) || error.code !== "pairing_exists") {
    return undefined;
  }
  const body =
    typeof error.body === "object" && error.body !== null
      ? (error.body as Record<string, unknown>)
      : {};
  return typeof body["pairingId"] === "string" ? body["pairingId"] : undefined;
}

/**
 * The sentence to show for a failure.
 *
 * Every path returns something readable, including the one where what was thrown is not
 * an error at all.
 *
 * @param error - The value that was thrown.
 * @returns A sentence for a person.
 */
export function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    return error.message;
  }
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  return "Something went wrong. Try again, or check the server logs.";
}

/**
 * Whether a failure means the caller is not signed in.
 *
 * Used to send the browser to the sign-in page rather than showing an error on a page it
 * cannot populate. A 403 deliberately does not count: the person is signed in and simply
 * lacks the standing, and signing them out would be an unhelpful answer to that.
 *
 * @param error - The value that was thrown.
 * @returns `true` for a 401.
 */
export function isUnauthenticated(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}
