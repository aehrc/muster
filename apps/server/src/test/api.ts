/**
 * Making an API request in a suite.
 *
 * Two functions, and the second exists for one reason: a suite that reads a field off an
 * unexpected response fails with "cannot read property of undefined", which says nothing about
 * what went wrong. {@link apiJson} asserts the status first and puts the body in the message.
 *
 * Author: John Grimes
 */

import type { TestStack } from "./harness.js";

/** What a request may carry. */
export interface ApiRequestOptions {
  /** Serialised as JSON. */
  readonly body?: unknown;
  /** The `name=value` pair a browser would send back. */
  readonly cookie?: string;
  /** Extra headers, for the cases whose subject is one - a forwarded address, say. */
  readonly headers?: Readonly<Record<string, string>>;
}

/**
 * Makes an API request.
 *
 * @param stack - The stack under test.
 * @param method - The HTTP method.
 * @param path - An absolute path, including `/api`.
 * @param options - The body, the cookie and any extra headers.
 * @returns The response, whatever its status.
 * @example
 * ```ts
 * const response = await apiRequest(stack, "GET", "/api/events");
 * ```
 */
export async function apiRequest(
  stack: TestStack,
  method: string,
  path: string,
  options: ApiRequestOptions = {},
): Promise<Response> {
  return await stack.app.request(path, {
    method,
    headers: {
      accept: "application/json",
      ...(options.body === undefined
        ? {}
        : { "content-type": "application/json" }),
      ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
      ...options.headers,
    },
    ...(options.body === undefined
      ? {}
      : { body: JSON.stringify(options.body) }),
  });
}

/**
 * Makes an API request and returns its parsed body.
 *
 * @param stack - The stack under test.
 * @param method - The HTTP method.
 * @param path - An absolute path, including `/api`.
 * @param options - The body, the cookie and any extra headers.
 * @param expectedStatus - The status the suite is relying on. Defaults to 200.
 * @returns The parsed body.
 * @throws {Error} When the status is not the one expected, with the body in the message - a
 *   failed assertion on a field of `undefined` says much less.
 * @example
 * ```ts
 * const body = await apiJson<{ systems: EnrolledSystem[] }>(
 *   stack, "GET", "/api/events/sparked/systems",
 * );
 * ```
 */
export async function apiJson<T>(
  stack: TestStack,
  method: string,
  path: string,
  options: ApiRequestOptions = {},
  expectedStatus = 200,
): Promise<T> {
  const response = await apiRequest(stack, method, path, options);
  const text = await response.text();
  if (response.status !== expectedStatus) {
    throw new Error(
      `${method} ${path} answered ${String(response.status)}, expected ${String(expectedStatus)}: ${text}`,
    );
  }
  return JSON.parse(text) as T;
}
