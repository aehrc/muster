/**
 * The one fetch in the browser.
 *
 * Four verbs over one request function, so a query hook reads as `get(path)` rather
 * than as a fetch with options. Three things then hold everywhere: the session cookie is
 * always sent, a refusal always arrives as an {@link ApiError} carrying the server's own
 * words, and no caller has to check `response.ok`.
 *
 * There is no bearer token here, deliberately. The console authenticates with an
 * httpOnly cookie, which JavaScript cannot read - that is the point of it - so
 * `credentials: "same-origin"` is the whole of the credential handling.
 *
 * Author: John Grimes
 */

import { toApiError } from "./errors.js";

/** What a request may carry. */
interface RequestOptions {
  readonly method?: "GET" | "POST" | "PATCH" | "DELETE";
  /** Serialised as JSON. Omitted for a request with no body. */
  readonly body?: unknown;
  /** Aborts the request; supplied by TanStack Query. */
  readonly signal?: AbortSignal;
}

/**
 * Makes a request and returns its parsed body.
 *
 * @param path - An absolute path on this origin.
 * @param options - The method, the body and the abort signal.
 * @returns The parsed JSON body, or undefined for a response with no content.
 * @throws {ApiError} For any non-2xx response, carrying the server's own message.
 */
async function requestJson<T>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const response = await fetch(path, {
    method: options.method ?? "GET",
    // Same-origin rather than `include`: the API is served by the same process as this
    // bundle, and a cross-origin credentialed request is not something the console
    // should be able to make by accident.
    credentials: "same-origin",
    headers: {
      accept: "application/json",
      ...(options.body === undefined
        ? {}
        : { "content-type": "application/json" }),
    },
    ...(options.body === undefined
      ? {}
      : { body: JSON.stringify(options.body) }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });

  if (response.status === 204) {
    return undefined as T;
  }

  // Parsed before the status is inspected, because a refusal's body is where the code and
  // the detail are. A body that is not JSON yields undefined, and `toApiError` falls back
  // to describing the status.
  const body: unknown = await response.json().catch(() => {});

  if (!response.ok) {
    throw toApiError(response.status, body);
  }
  return body as T;
}

/**
 * Reads a resource.
 *
 * @param path - An absolute path on this origin.
 * @param signal - Abort signal, supplied by TanStack Query.
 * @returns The parsed body.
 * @throws {ApiError} For any non-2xx response.
 */
export async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  return await requestJson<T>(path, {
    ...(signal === undefined ? {} : { signal }),
  });
}

/**
 * Creates a resource, or performs an action on one.
 *
 * @param path - An absolute path on this origin.
 * @param body - The request body, when the action needs one.
 * @returns The updated resource, which every mutation returns so the interface can
 *   render the new state without a second round trip.
 * @throws {ApiError} For any non-2xx response.
 */
export async function post<T>(path: string, body?: unknown): Promise<T> {
  return await requestJson<T>(path, {
    method: "POST",
    ...(body === undefined ? {} : { body }),
  });
}

/**
 * Edits a resource.
 *
 * @param path - An absolute path on this origin.
 * @param body - The fields to change.
 * @returns The updated resource.
 * @throws {ApiError} For any non-2xx response.
 */
export async function patch<T>(path: string, body: unknown): Promise<T> {
  return await requestJson<T>(path, { method: "PATCH", body });
}

/**
 * Deletes a resource.
 *
 * @param path - An absolute path on this origin.
 * @throws {ApiError} For any non-2xx response.
 */
export async function remove(path: string): Promise<void> {
  await requestJson<void>(path, { method: "DELETE" });
}
