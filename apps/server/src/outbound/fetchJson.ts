/*
 * Copyright © 2026 Commonwealth Scientific and Industrial Research Organisation
 * (CSIRO) ABN 41 687 119 230. Licensed under the Apache License, Version 2.0.
 */

import { outboundFetch } from "./outboundFetch.ts";

import type {
  OutboundFailureMode,
  OutboundOverrides,
} from "./outboundFetch.ts";
import type { OutboundConfig } from "../config.ts";

/**
 * Fetching one JSON document from a participant-supplied address, under the
 * guard.
 *
 * Every part of Muster that reads somebody else's server does the same three
 * things: ask the guard, keep the status, and read the body as JSON if it is one.
 * This is that, once. The scheduler's liveness probes, the persona coverage
 * search and the proxied search of the persona source all go through here, so
 * there is one place where the outbound settings are applied and one place where
 * a body that is not JSON is turned into an absence rather than an exception.
 *
 * The status is kept rather than folded into success or failure, because callers
 * disagree about what a status means: a `401` from a liveness probe is an
 * unreadable document, and a `401` from a coverage search is the whole answer -
 * the server will not be searched without authorization, which is `unverifiable`
 * and not `missing` (FR-032).
 *
 * @author John Grimes
 */

/** What a guarded JSON fetch produced. */
export type JsonAnswer =
  /** the server answered; the body is undefined when it was not JSON */
  | {
      readonly ok: true;
      readonly status: number;
      readonly document: unknown;
    }
  /** nothing was reached, and this is why */
  | {
      readonly ok: false;
      readonly failureMode: OutboundFailureMode;
      readonly detail: string;
    };

/** How to make the request. */
export type JsonFetchOptions = {
  /** the deployment's outbound settings */
  readonly outbound: OutboundConfig;
  /** the injected fetch and resolver, empty in a deployment */
  readonly overrides: OutboundOverrides;
  /** the method, headers and body, beyond the JSON accept header */
  readonly request?: RequestInit;
};

/**
 * Fetches one JSON document through the guard.
 *
 * @param url - the absolute URL to fetch
 * @param options - the outbound settings, the injectables and the request
 * @returns the status and the body, or the guard's refusal
 * @example
 * ```ts
 * const answer = await fetchJson(searchUrl, {
 *   outbound: config.outbound,
 *   overrides: context.get("outbound"),
 * });
 * ```
 */
export const fetchJson = async (
  url: string,
  options: JsonFetchOptions,
): Promise<JsonAnswer> => {
  const result = await outboundFetch(url, {
    timeoutMs: options.outbound.timeoutMs,
    allowedHosts: options.outbound.allowedHosts,
    request: {
      ...options.request,
      headers: {
        accept: "application/fhir+json, application/json",
        ...options.request?.headers,
      },
    },
    ...options.overrides,
  });
  if (!result.ok) {
    return {
      ok: false,
      failureMode: result.refusal.failureMode,
      detail: result.refusal.detail,
    };
  }
  try {
    return {
      ok: true,
      status: result.response.status,
      document: await result.response.json(),
    };
  } catch {
    // A body that is not JSON is an absence rather than a failure: the status may
    // still be the whole answer, as it is for an authorization challenge.
    return { ok: true, status: result.response.status, document: undefined };
  }
};
