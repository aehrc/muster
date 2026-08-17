import { describe, expect, test } from "bun:test";

import { consume, emptyWindow, pruneWindow } from "./slidingWindow.ts";

import type { RateLimitPolicy, SlidingWindow } from "./slidingWindow.ts";

/**
 * The limiter is pure: the clock arrives as an argument and every call returns
 * the next window rather than mutating the one it was given. Times below are
 * plain millisecond counts, which no real clock would produce, so a test that
 * passes cannot be reading `Date.now()` behind our back.
 */

/** Three attempts per minute, the shape the auth routes use. */
const policy: RateLimitPolicy = { limit: 3, windowMs: 60_000 };

// Exhausts an allowance, returning the window sitting at the limit.
const fillAllowance = (
  window: SlidingWindow,
  options: {
    readonly address: string;
    readonly route: string;
    readonly at: number;
  },
): SlidingWindow => {
  let current = window;
  for (let index = 0; index < policy.limit; index += 1) {
    const decision = consume({
      window: current,
      address: options.address,
      route: options.route,
      now: options.at + index,
      policy,
    });
    expect(decision.allowed).toBe(true);
    current = decision.window;
  }
  return current;
};

describe("consume", () => {
  test("allows attempts up to the limit and counts down the remainder", () => {
    let window = emptyWindow;
    const remaining: number[] = [];

    for (let index = 0; index < policy.limit; index += 1) {
      const decision = consume({
        window,
        address: "203.0.113.7",
        route: "POST /api/auth/sign-in",
        now: 1_000 + index,
        policy,
      });
      expect(decision.allowed).toBe(true);
      expect(decision.retryAfterSeconds).toBe(0);
      remaining.push(decision.remaining);
      window = decision.window;
    }

    expect(remaining).toEqual([2, 1, 0]);
  });

  test("refuses the attempt past the limit and says when to retry", () => {
    const window = fillAllowance(emptyWindow, {
      address: "203.0.113.7",
      route: "POST /api/auth/sign-in",
      at: 0,
    });

    // The oldest of the three hits was at 0, so the allowance frees at 60_000;
    // 30 seconds after that hit, 30 seconds remain.
    const decision = consume({
      window,
      address: "203.0.113.7",
      route: "POST /api/auth/sign-in",
      now: 30_000,
      policy,
    });

    expect(decision.allowed).toBe(false);
    expect(decision.remaining).toBe(0);
    expect(decision.retryAfterSeconds).toBe(30);
  });

  test("always advises at least a second when refusing", () => {
    const window = fillAllowance(emptyWindow, {
      address: "203.0.113.7",
      route: "POST /api/auth/sign-in",
      at: 0,
    });

    // 1 millisecond of the window is left, which rounds up rather than to zero:
    // a Retry-After of 0 would invite an immediate retry that also fails.
    const decision = consume({
      window,
      address: "203.0.113.7",
      route: "POST /api/auth/sign-in",
      now: 59_999,
      policy,
    });

    expect(decision.allowed).toBe(false);
    expect(decision.retryAfterSeconds).toBe(1);
  });

  test("does not let a refused attempt extend the window", () => {
    const filled = fillAllowance(emptyWindow, {
      address: "203.0.113.7",
      route: "POST /api/auth/sign-in",
      at: 0,
    });

    // Hammering at 59_999 must not push the recovery time out; the first hit
    // still ages out at 60_000, so the attempt just after it is allowed.
    const refused = consume({
      window: filled,
      address: "203.0.113.7",
      route: "POST /api/auth/sign-in",
      now: 59_999,
      policy,
    });
    const afterRecovery = consume({
      window: refused.window,
      address: "203.0.113.7",
      route: "POST /api/auth/sign-in",
      now: 60_001,
      policy,
    });

    expect(afterRecovery.allowed).toBe(true);
  });

  test("frees allowance one hit at a time as hits age out", () => {
    // Hits at 0, 1 and 2 (from fillAllowance). At 60_001 the cutoff is 1, so
    // the hits at 0 and 1 have aged out and the hit at 2 has not: exactly two
    // attempts are available, and the third is refused.
    const filled = fillAllowance(emptyWindow, {
      address: "203.0.113.7",
      route: "POST /api/auth/sign-in",
      at: 0,
    });

    const first = consume({
      window: filled,
      address: "203.0.113.7",
      route: "POST /api/auth/sign-in",
      now: 60_001,
      policy,
    });
    const second = consume({
      window: first.window,
      address: "203.0.113.7",
      route: "POST /api/auth/sign-in",
      now: 60_001,
      policy,
    });
    const third = consume({
      window: second.window,
      address: "203.0.113.7",
      route: "POST /api/auth/sign-in",
      now: 60_001,
      policy,
    });

    expect([first.allowed, second.allowed, third.allowed]).toEqual([
      true,
      true,
      false,
    ]);
  });

  // The key is the client address and the route, and nothing else. A key that
  // took anything from the request body would let an attacker spread guesses
  // across bodies, or exhaust another account's allowance by naming it.
  test("keeps allowances independent per client address", () => {
    const window = fillAllowance(emptyWindow, {
      address: "203.0.113.7",
      route: "POST /api/auth/sign-in",
      at: 0,
    });

    const other = consume({
      window,
      address: "198.51.100.4",
      route: "POST /api/auth/sign-in",
      now: 10,
      policy,
    });

    expect(other.allowed).toBe(true);
    expect(other.remaining).toBe(policy.limit - 1);
  });

  test("keeps allowances independent per route", () => {
    const window = fillAllowance(emptyWindow, {
      address: "203.0.113.7",
      route: "POST /api/auth/sign-in",
      at: 0,
    });

    const other = consume({
      window,
      address: "203.0.113.7",
      route: "POST /api/auth/sign-up",
      now: 10,
      policy,
    });

    expect(other.allowed).toBe(true);
    expect(other.remaining).toBe(policy.limit - 1);
  });

  test("shares one allowance for the same address and route", () => {
    const window = fillAllowance(emptyWindow, {
      address: "203.0.113.7",
      route: "POST /api/auth/sign-in",
      at: 0,
    });

    const again = consume({
      window,
      address: "203.0.113.7",
      route: "POST /api/auth/sign-in",
      now: 10,
      policy,
    });

    expect(again.allowed).toBe(false);
  });

  test("never mutates the window it was given", () => {
    const window = fillAllowance(emptyWindow, {
      address: "203.0.113.7",
      route: "POST /api/auth/sign-in",
      at: 0,
    });
    const before = [...window].map(([key, hits]) => [key, [...hits]] as const);

    consume({
      window,
      address: "203.0.113.7",
      route: "POST /api/auth/sign-in",
      now: 10,
      policy,
    });
    consume({
      window,
      address: "198.51.100.4",
      route: "POST /api/auth/sign-in",
      now: 10,
      policy,
    });

    expect([...window].map(([key, hits]) => [key, [...hits]] as const)).toEqual(
      before,
    );
  });

  test("forgets a key once its hits have aged out", () => {
    const filled = fillAllowance(emptyWindow, {
      address: "203.0.113.7",
      route: "POST /api/auth/sign-in",
      at: 0,
    });

    const later = consume({
      window: filled,
      address: "198.51.100.4",
      route: "POST /api/auth/sign-in",
      now: 200_000,
      policy,
    });

    // Only the new caller's key survives: an expired key is dropped rather
    // than accumulating one entry per address ever seen.
    expect([...later.window.keys()]).toHaveLength(2);
    expect([...pruneWindow(later.window, 200_000, policy).keys()]).toHaveLength(
      1,
    );
  });

  // Deny by default: a policy that cannot be honoured is a fault, not
  // something to approximate.
  test("refuses a policy that permits nothing or spans no time", () => {
    for (const invalid of [
      { limit: 0, windowMs: 60_000 },
      { limit: -1, windowMs: 60_000 },
      { limit: 3, windowMs: 0 },
      { limit: 1.5, windowMs: 60_000 },
    ]) {
      expect(() =>
        consume({
          window: emptyWindow,
          address: "203.0.113.7",
          route: "POST /api/auth/sign-in",
          now: 0,
          policy: invalid,
        }),
      ).toThrow(/policy/i);
    }
  });
});

describe("pruneWindow", () => {
  test("keeps live hits and drops expired ones", () => {
    const window: SlidingWindow = new Map([
      ["POST /api/auth/sign-in\u0000203.0.113.7", [10, 59_000]],
      ["POST /api/auth/sign-in\u0000198.51.100.4", [10]],
    ]);

    // At 70_000 the cutoff is 10_000: the hits at 10 have expired, 59_000 has
    // not, so one key keeps one hit and the other key goes entirely.
    const pruned = pruneWindow(window, 70_000, policy);

    expect([...pruned.keys()]).toEqual([
      "POST /api/auth/sign-in\u0000203.0.113.7",
    ]);
    expect(pruned.get("POST /api/auth/sign-in\u0000203.0.113.7")).toEqual([
      59_000,
    ]);
  });

  test("returns an empty window when everything has expired", () => {
    const window: SlidingWindow = new Map([["a\u0000b", [1, 2, 3]]]);

    expect([...pruneWindow(window, 1_000_000, policy)]).toEqual([]);
  });
});
