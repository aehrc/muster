/*
 * Copyright © 2026 Commonwealth Scientific and Industrial Research Organisation
 * (CSIRO) ABN 41 687 119 230. Licensed under the Apache License, Version 2.0.
 */

import type { MusterConfig } from "../config.ts";
import type {
  AddressResolver,
  FetchImplementation,
  OutboundOverrides,
} from "../outbound/outboundFetch.ts";
import type { EventStatus } from "@muster/contracts";
import type { SQL } from "bun";

/**
 * What the scheduler's passes are given, and which events they act on.
 *
 * Both passes - the liveness and discovery checks, and the persona coverage and
 * source checks - take the same dependencies and read the same set of events, so
 * those are declared once here rather than twice with a chance to drift. The
 * database connection, the configuration, the clock and the two outbound
 * collaborators arrive as arguments, which is what lets a suite drive a real pass
 * over a real schema with a stand-in server and a fixed clock.
 *
 * @author John Grimes
 */

/** What a scheduler pass needs in order to run. */
export type SchedulerDependencies = {
  /** the connection held by the serving database role */
  readonly sql: SQL;
  /** the runtime configuration, which carries the outbound settings */
  readonly config: MusterConfig;
  /** the clock, called once per pass; injected by tests */
  readonly now?: () => Date;
  /** the fetch implementation, injected by tests */
  readonly fetchImplementation?: FetchImplementation;
  /** the address resolver, injected by tests */
  readonly resolve?: AddressResolver;
  /** how often to look for due targets, in milliseconds */
  readonly tickIntervalMs?: number;
  /** where to write what the scheduler did */
  readonly log?: (line: string) => void;
};

/**
 * The event statuses whose entries and personas are acted on.
 *
 * Every status: a draft event's entries are being prepared and their owners want
 * to know they work, and a closed event's stay readable, so both are checked - on
 * the daily cadence rather than the open one.
 */
export const scheduledEventStatuses: readonly EventStatus[] = [
  "draft",
  "open",
  "closed",
];

/**
 * Reads the guard's injectable collaborators out of the dependencies.
 *
 * Absent in a deployment, which is the point: the guard resolves and fetches for
 * itself unless a suite has handed it something else.
 *
 * @param dependencies - the pass's dependencies
 * @returns the overrides to pass to a guarded fetch
 * @example
 * ```ts
 * await fetchJson(url, {
 *   outbound: dependencies.config.outbound,
 *   overrides: outboundOverrides(dependencies),
 * });
 * ```
 */
export const outboundOverrides = (
  dependencies: SchedulerDependencies,
): OutboundOverrides => ({
  ...(dependencies.resolve === undefined
    ? {}
    : { resolve: dependencies.resolve }),
  ...(dependencies.fetchImplementation === undefined
    ? {}
    : { fetchImplementation: dependencies.fetchImplementation }),
});
