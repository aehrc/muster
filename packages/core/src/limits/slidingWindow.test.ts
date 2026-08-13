/**
 * The rate limiter's arithmetic, at the boundaries where it matters.
 *
 * Rate limiting on sign-in, sign-up and verification (FR-035) is the only thing
 * standing between an exposed password endpoint and unlimited guessing, so the
 * awkward cases are the subject here: what happens across a window boundary, whether
 * a refused request still costs the caller, and whether a key ever collides with
 * another. All of it is arithmetic over an injected clock, so none of it needs a
 * server or a timer.
 *
 * Author: John Grimes
 */

import { describe, expect, it } from "bun:test";

import {
  admitRequest,
  emptyWindow,
  isWindowStale,
  rateLimitKey,
  weightedCount,
} from "./slidingWindow.js";

import type { WindowLimit, WindowState } from "./slidingWindow.js";

/** Five requests a minute: the shape the auth routes use. */
const LIMIT: WindowLimit = { limit: 5, windowMs: 60_000 };

/** A round moment, so window arithmetic in the assertions is readable. */
const START = 1_800_000_000_000;

/**
 * Replays `count` requests from one moment, returning the last decision.
 *
 * @param count - How many requests to make.
 * @param now - When they are all made.
 */
function burst(
  count: number,
  now: number,
  from?: WindowState,
): { state: WindowState; allowed: boolean; remaining: number } {
  let state = from;
  let allowed = false;
  let remaining = 0;
  for (let index = 0; index < count; index += 1) {
    const decision = admitRequest(state, now, LIMIT);
    state = decision.state;
    allowed = decision.allowed;
    remaining = decision.remaining;
  }
  return { state: state!, allowed, remaining };
}

describe("admitRequest", () => {
  it("admits a key never seen before", () => {
    const decision = admitRequest(undefined, START, LIMIT);

    expect(decision.allowed).toBe(true);
    expect(decision.remaining).toBe(4);
  });

  it("admits up to the limit and refuses the next", () => {
    const fifth = burst(5, START);
    expect(fifth.allowed).toBe(true);
    expect(fifth.remaining).toBe(0);

    const sixth = admitRequest(fifth.state, START, LIMIT);
    expect(sixth.allowed).toBe(false);
  });

  // A refused request still increments the counter. Otherwise a caller hammering the
  // endpoint keeps their estimate at the threshold and is admitted once per window
  // regardless of how hard they push.
  it("counts a refused request", () => {
    const exhausted = burst(5, START).state;
    const refused = admitRequest(exhausted, START, LIMIT);

    expect(refused.allowed).toBe(false);
    expect(refused.state.current).toBe(6);
  });

  it("reports when to try again as the end of the current window", () => {
    const decision = admitRequest(undefined, START + 15_000, LIMIT);

    // The window's end, not the moment the estimate would fall below the limit:
    // that number tells a caller exactly how to pace their guessing.
    expect(decision.retryAt).toBe(START + 60_000);
  });

  // The failure a fixed window has: a caller spends their whole allowance in the last
  // moment of one window and the whole of it again in the first moment of the next,
  // which doubles the guessing rate at a predictable instant.
  it("does not admit twice the limit across a window boundary", () => {
    const exhausted = burst(5, START + 59_999).state;

    const justAfter = admitRequest(exhausted, START + 60_000, LIMIT);

    expect(justAfter.allowed).toBe(false);
  });

  it("admits again once the previous window has decayed out", () => {
    const exhausted = burst(5, START).state;

    // Most of the way through the following window, the previous one contributes
    // little enough that the caller is admitted.
    expect(admitRequest(exhausted, START + 115_000, LIMIT).allowed).toBe(true);
  });

  // Two whole windows of silence is indistinguishable from a caller never seen, and
  // treating them differently would keep state for every address that ever made a
  // request.
  it("forgets a key after two silent windows", () => {
    const exhausted = burst(5, START).state;
    const later = admitRequest(exhausted, START + 180_000, LIMIT);

    expect(later.allowed).toBe(true);
    expect(later.remaining).toBe(4);
    expect(later.state.previous).toBe(0);
  });

  it("never reports negative headroom", () => {
    const hammered = burst(20, START);

    expect(hammered.remaining).toBe(0);
  });
});

describe("weightedCount", () => {
  it("weights the previous window by how much of it still overlaps", () => {
    const state: WindowState = {
      windowStart: START,
      current: 2,
      previous: 4,
    };

    // At the very start of the window the previous one counts almost in full.
    expect(weightedCount(state, START, 60_000)).toBe(6);
    // Half way through, half of it.
    expect(weightedCount(state, START + 30_000, 60_000)).toBe(4);
    // At the end, none of it.
    expect(weightedCount(state, START + 60_000, 60_000)).toBe(2);
  });

  it("does not let a stale window contribute negatively", () => {
    const state = { windowStart: START, current: 1, previous: 4 };

    expect(weightedCount(state, START + 120_000, 60_000)).toBe(1);
  });
});

describe("emptyWindow", () => {
  it("aligns the window to the period rather than to the request", () => {
    // Aligned windows mean two keys first seen a second apart share a boundary, so
    // the store's sweep can reason about staleness uniformly.
    const state = emptyWindow(START + 12_345, 60_000);

    expect(state.windowStart).toBe(START);
    expect(state.current).toBe(0);
  });
});

describe("isWindowStale", () => {
  it("is true only once two whole windows have passed", () => {
    const state = emptyWindow(START, 60_000);

    expect(isWindowStale(state, START + 119_999, 60_000)).toBe(false);
    expect(isWindowStale(state, START + 120_000, 60_000)).toBe(true);
  });
});

describe("rateLimitKey", () => {
  // Strictly address and route. A key with anything from the request body in it lets
  // an attacker spread guesses across keys, or exhaust somebody else's allowance by
  // submitting their email address.
  it("distinguishes addresses and routes", () => {
    expect(rateLimitKey("198.51.100.7", "POST /api/auth/sign-in")).not.toBe(
      rateLimitKey("198.51.100.8", "POST /api/auth/sign-in"),
    );
    expect(rateLimitKey("198.51.100.7", "POST /api/auth/sign-in")).not.toBe(
      rateLimitKey("198.51.100.7", "POST /api/auth/sign-up"),
    );
  });

  it("is stable for the same address and route", () => {
    expect(rateLimitKey("198.51.100.7", "POST /api/auth/verify")).toBe(
      rateLimitKey("198.51.100.7", "POST /api/auth/verify"),
    );
  });

  // An address that could carry the separator must not be able to impersonate
  // another key: `a` on route `b:c` and `a:b` on route `c` are different callers.
  it("cannot be made to collide by an address containing the separator", () => {
    expect(rateLimitKey("a", "b:c")).not.toBe(rateLimitKey("a:b", "c"));
  });
});
