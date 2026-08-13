/**
 * That nothing is public by accident.
 *
 * Muster attaches its guards per route, which is right - authority varies per route - and which
 * fails in the direction of publishing a route by forgetting one. This suite is what makes the
 * forgetting impossible rather than unlikely, and it works in both directions:
 *
 * - every route the application registers is asked anonymously, and one that answers must be
 *   named in `PUBLIC_REQUESTS` with the reason it is public;
 * - every entry in `PUBLIC_REQUESTS` must name a route the application actually registers, so
 *   an entry cannot outlive the route it was written for and quietly exempt a later one.
 *
 * The pattern is Signet's: enumerate the escape hatches, and compare the declaration against
 * the source in both directions.
 *
 * Author: John Grimes
 */

import { hasTestDatabase } from "@muster/db";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import { PUBLIC_REQUESTS } from "./router.js";
import { apiRequest } from "../test/api.js";
import { createTestStack } from "../test/harness.js";

import type { TestStack } from "../test/harness.js";

/** The statuses that mean "you are not allowed to ask this without a session". */
const REFUSALS = new Set([401, 403]);

describe.skipIf(!hasTestDatabase())("the API's public surface", () => {
  let stack: TestStack;

  beforeAll(async () => {
    stack = await createTestStack();
  });

  afterAll(async () => {
    await stack.close();
  });

  /**
   * Every route the application registers under `/api`, as `METHOD path`.
   *
   * Read off Hono's own route table rather than written out here, which is the whole point: a
   * route added tomorrow is in this list without anybody remembering to add it.
   */
  function registeredRequests(): readonly string[] {
    const seen = new Set<string>();
    for (const route of stack.app.routes) {
      // The wildcards are the session middleware and the catch-all, not routes.
      if (route.path.includes("*") || !route.path.startsWith("/api")) {
        continue;
      }
      seen.add(`${route.method} ${route.path}`);
    }
    return [...seen].toSorted();
  }

  /** A path with its parameters filled in with values that match nothing. */
  function concretePath(path: string): string {
    return path.replaceAll(/:(\w+)/g, "00000000-0000-0000-0000-000000000000");
  }

  it("refuses every request that is not declared public", async () => {
    const undeclared: string[] = [];

    for (const request of registeredRequests()) {
      if (request in PUBLIC_REQUESTS) {
        continue;
      }
      const [method = "GET", path = "/"] = request.split(" ", 2);
      const response = await apiRequest(
        stack,
        method,
        concretePath(path),
        // A body that fails validation would be refused at 400 before the guard is
        // consulted, so nothing is sent: the guards run before the body is read.
        {},
      );
      if (!REFUSALS.has(response.status)) {
        undeclared.push(`${request} answered ${String(response.status)}`);
      }
    }

    // Every entry in this list is a route that answers an anonymous caller and has not said
    // why. Either attach a guard, or declare it in PUBLIC_REQUESTS with its reason.
    expect(undeclared).toEqual([]);
  });

  it("declares nothing that is not a route", async () => {
    const registered = new Set(registeredRequests());

    const stale = Object.keys(PUBLIC_REQUESTS).filter(
      (request) => !registered.has(request),
    );

    // An entry that outlived its route would exempt whichever later route happened to take
    // the same method and pattern.
    expect(stale).toEqual([]);
    await Promise.resolve();
  });

  it("gives every declared public request a stated reason", () => {
    const unexplained = Object.entries(PUBLIC_REQUESTS).filter(
      ([, reason]) => reason.trim().length === 0,
    );

    expect(unexplained).toEqual([]);
  });
});
