import { errorEnvelopeSchema } from "@muster/contracts";

/**
 * The console's only route to Muster's API.
 *
 * Every failure comes back as an {@link ApiFailure}, whether the server sent
 * the `{ error, detail? }` envelope, a proxy sent an HTML error page, the
 * connection dropped, or the body did not match the contract. Nothing throws,
 * so a screen always has something true to render - which is what keeps the
 * console honest about pending, failed and succeeded.
 *
 * @author John Grimes
 */

/** A call that did not return a resource. */
export type ApiFailure = {
  /** the HTTP status, or 0 when nothing answered */
  readonly status: number;
  /** the machine-readable code from the envelope */
  readonly error: string;
  /** what went wrong, when it could be established */
  readonly detail?: string;
};

/** The outcome of a call. */
export type ApiResult<Output> =
  | { readonly ok: true; readonly data: Output }
  | { readonly ok: false; readonly failure: ApiFailure };

/** Anything that validates an unknown value, such as a Zod schema. */
export type ResponseParser<Output> = {
  /** parses the value, throwing when it does not match */
  readonly parse: (value: unknown) => Output;
};

/** How to build a client. */
export type ApiClientOptions = {
  /** prefix for every path; defaults to the page's own origin */
  readonly baseUrl?: string;
  /** fetch implementation; injected by tests */
  readonly fetchImplementation?: (
    url: string,
    init?: RequestInit,
  ) => Promise<Response>;
};

/** A call that sends a JSON body. */
type BodyCall = <Output>(
  path: string,
  body: unknown,
  parser: ResponseParser<Output>,
) => Promise<ApiResult<Output>>;

/** A call that sends no body. */
type BodylessCall = <Output>(
  path: string,
  parser: ResponseParser<Output>,
) => Promise<ApiResult<Output>>;

/** Calls Muster's JSON API. */
export type ApiClient = {
  /** reads a resource */
  readonly get: BodylessCall;
  /** creates or acts on a resource */
  readonly post: BodyCall;
  /** edits a resource */
  readonly patch: BodyCall;
  /** removes a resource */
  readonly delete: BodylessCall;
};

/**
 * Describes a failure that did not arrive in the envelope.
 *
 * @param response - the response received
 * @returns the failure to hand the caller
 */
const unexpectedResponse = (response: Response): ApiFailure => ({
  status: response.status,
  error: "unexpected_response",
  detail:
    `The server answered ${String(response.status)} ${response.statusText}`.trim(),
});

/**
 * Builds a client for Muster's JSON API.
 *
 * @param options - the base URL to prefix paths with, and the fetch seam tests
 *   inject
 * @returns a client whose calls resolve to a resource or a failure, never throw
 * @example
 * ```ts
 * const api = createApiClient();
 * const result = await api.get("/api/events", eventPageSchema);
 * if (!result.ok) {
 *   setMessage(result.failure.detail ?? result.failure.error);
 * }
 * ```
 */
export const createApiClient = (options: ApiClientOptions = {}): ApiClient => {
  const baseUrl = (options.baseUrl ?? "").replace(/\/+$/, "");
  const fetcher = options.fetchImplementation ?? globalThis.fetch;

  const call = async <Output>(
    path: string,
    init: RequestInit,
    parser: ResponseParser<Output>,
  ): Promise<ApiResult<Output>> => {
    let response: Response;
    try {
      response = await fetcher(`${baseUrl}${path}`, init);
    } catch (cause) {
      return {
        ok: false,
        failure: {
          status: 0,
          error: "network_error",
          detail: cause instanceof Error ? cause.message : String(cause),
        },
      };
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { ok: false, failure: unexpectedResponse(response) };
    }

    if (!response.ok) {
      const envelope = errorEnvelopeSchema.safeParse(body);
      if (!envelope.success) {
        return { ok: false, failure: unexpectedResponse(response) };
      }
      const { error, detail } = envelope.data;
      return {
        ok: false,
        failure: {
          status: response.status,
          error,
          ...(detail === undefined ? {} : { detail }),
        },
      };
    }

    try {
      return { ok: true, data: parser.parse(body) };
    } catch {
      return {
        ok: false,
        failure: {
          status: response.status,
          error: "unexpected_response",
          detail: "The server's answer did not match the contract",
        },
      };
    }
  };

  // One builder for the two methods that carry a body, and one for the two that
  // do not, so a header cannot be right on one verb and wrong on another.
  const withBody =
    (method: string): BodyCall =>
    (path, body, parser) =>
      call(
        path,
        {
          method,
          headers: {
            accept: "application/json",
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        },
        parser,
      );

  const withoutBody =
    (method?: string): BodylessCall =>
    (path, parser) =>
      call(
        path,
        {
          ...(method === undefined ? {} : { method }),
          headers: { accept: "application/json" },
        },
        parser,
      );

  return {
    get: withoutBody(),
    post: withBody("POST"),
    patch: withBody("PATCH"),
    delete: withoutBody("DELETE"),
  };
};
