/**
 * The route table the nav and the router share.
 *
 * One list, so a nav item cannot point at a path the router does not serve. The active
 * test is here because "which nav item is current" is the console's answer to Nielsen's
 * first heuristic and is otherwise the kind of thing that is wrong on nested routes
 * forever.
 *
 * Author: John Grimes
 */

import { describe, expect, it } from "bun:test";

import { isActivePath, NAVIGATION, ROUTES } from "./routes.js";

describe("NAVIGATION", () => {
  // Public by default (constitution principle V): everything a visitor can read is
  // reachable without signing in, and the member-only destinations are marked as such
  // rather than hidden from the list.
  it("leads with the public surfaces", () => {
    const publicPaths = NAVIGATION.filter((item) => !item.membersOnly).map(
      (item) => item.path,
    );

    expect(publicPaths).toContain(ROUTES.events);
    expect(publicPaths).toContain(ROUTES.docs);
  });

  it("marks the member and admin destinations", () => {
    const restricted = NAVIGATION.filter((item) => item.membersOnly).map(
      (item) => item.path,
    );

    expect(restricted).toContain(ROUTES.pairings);
    expect(restricted).toContain(ROUTES.myOrganisation);
    expect(restricted).toContain(ROUTES.admin);
  });

  it("names every destination exactly once", () => {
    expect(new Set(NAVIGATION.map((item) => item.path)).size).toBe(
      NAVIGATION.length,
    );
  });
});

describe("isActivePath", () => {
  it("matches the destination itself", () => {
    expect(isActivePath("/events", "/events")).toBe(true);
  });

  it("matches a page nested under the destination", () => {
    // A system detail page is reached from the event view, and the nav should still show
    // where the reader is.
    expect(isActivePath("/events", "/events/sparked-2026-09/systems/1")).toBe(
      true,
    );
  });

  it("does not match a sibling that merely shares a prefix", () => {
    expect(isActivePath("/events", "/eventsomething")).toBe(false);
  });

  it("matches the home destination only exactly", () => {
    // Otherwise every path is under `/` and the home item is always current.
    expect(isActivePath("/", "/")).toBe(true);
    expect(isActivePath("/", "/events")).toBe(false);
  });
});
