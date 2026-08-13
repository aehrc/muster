/**
 * Sliding-window rate limiting, as arithmetic.
 *
 * Pure, so the awkward parts are testable without a clock or a server: the boundary
 * between two windows, a burst of simultaneous requests, and whether a caller who
 * waits exactly long enough is admitted.
 *
 * The algorithm is a two-window approximation rather than a fixed window or a log of
 * timestamps, and the choice matters. A fixed window admits twice the limit across a
 * boundary - a caller who spends their whole allowance in the last moment of one
 * window and again in the first moment of the next - which on a sign-in route means
 * twice the guessing rate at a predictable instant. A log of every request timestamp
 * is exact but grows with traffic, which is the wrong shape for something that runs
 * in front of every request.
 *
 * So each key keeps two counters: the current window's and the previous one's. The
 * estimate weights the previous window by how much of it still overlaps the trailing
 * period, which removes the boundary doubling and errs slightly high inside a window
 * when traffic is bursty - the direction that refuses rather than admits.
 *
 * Nothing here knows about processes or replicas. Muster runs one instance, so an
 * in-memory store over these functions is the whole limiter; a deployment that
 * changed that would have to say what it wanted instead.
 *
 * Author: John Grimes
 */

/** What a key's counters look like between requests. */
export interface WindowState {
  /** Start of the current window, in epoch milliseconds. */
  readonly windowStart: number;
  /** Requests counted in the current window. */
  readonly current: number;
  /** Requests counted in the window before it. */
  readonly previous: number;
}

/** How much a key may do, and over what period. */
export interface WindowLimit {
  readonly limit: number;
  readonly windowMs: number;
}

/** What a request costs a key, and what the caller should be told. */
export interface WindowDecision {
  readonly allowed: boolean;
  /** The state to store back. Always advances, admitted or not. */
  readonly state: WindowState;
  /** How many more requests this key may make in the window, at best. */
  readonly remaining: number;
  /**
   * When the caller should try again, in epoch milliseconds: the end of the current
   * window.
   *
   * Deliberately not the moment at which the estimate would fall below the limit.
   * That number tells a caller exactly how to pace their guessing, and a whole
   * window is a reasonable thing to ask them to wait.
   */
  readonly retryAt: number;
}

/** The start of the window a moment falls in. */
function alignWindow(now: number, windowMs: number): number {
  return Math.floor(now / windowMs) * windowMs;
}

/**
 * A key that has never been seen.
 *
 * @param now - The current time, in epoch milliseconds.
 * @param windowMs - The window length.
 * @returns Zeroed counters, aligned to the window `now` falls in.
 */
export function emptyWindow(now: number, windowMs: number): WindowState {
  return { windowStart: alignWindow(now, windowMs), current: 0, previous: 0 };
}

/**
 * Rolls a key's state forward to the window `now` falls in.
 *
 * One window on, the current count becomes the previous one. Two or more, both are
 * dropped: a caller silent for two whole windows is indistinguishable from one never
 * seen, and treating them differently would keep state for every address that ever
 * made a request.
 */
function rollForward(
  state: WindowState,
  now: number,
  windowMs: number,
): WindowState {
  const windowStart = alignWindow(now, windowMs);
  const elapsed = windowStart - state.windowStart;
  if (elapsed <= 0) {
    return state;
  }
  return elapsed === windowMs
    ? { windowStart, current: 0, previous: state.current }
    : { windowStart, current: 0, previous: 0 };
}

/**
 * The weighted count for a key, without recording a request.
 *
 * The previous window contributes in proportion to how much of it is still inside
 * the trailing window: at the start of a window it counts almost in full, and by the
 * end it counts for nothing.
 *
 * @param state - The key's counters.
 * @param now - The current time, in epoch milliseconds.
 * @param windowMs - The window length.
 * @returns The estimated request count over the trailing window.
 */
export function weightedCount(
  state: WindowState,
  now: number,
  windowMs: number,
): number {
  const elapsed = now - state.windowStart;
  const overlap = Math.max(0, Math.min(1, 1 - elapsed / windowMs));
  return state.current + state.previous * overlap;
}

/**
 * Decides whether a request is admitted, and returns the state to store.
 *
 * A refused request still increments the counter, deliberately: a caller hammering a
 * limited route must not be able to hold their estimate at the threshold by being
 * refused, which is what the alternative does - it admits one request every time the
 * window rolls, however hard they push.
 *
 * @param state - The key's counters, or undefined for a key never seen.
 * @param now - The current time, in epoch milliseconds. Injected: this package may
 *   not read the clock.
 * @param limit - How much the key may do, and over what period.
 * @returns Whether to admit, the state to store back, the headroom left and when to
 *   retry.
 * @example
 * ```ts
 * const decision = admitRequest(store.get(key), Date.now(), {
 *   limit: 5,
 *   windowMs: 60_000,
 * });
 * store.set(key, decision.state);
 * ```
 */
export function admitRequest(
  state: WindowState | undefined,
  now: number,
  limit: WindowLimit,
): WindowDecision {
  const rolled = rollForward(
    state ?? emptyWindow(now, limit.windowMs),
    now,
    limit.windowMs,
  );
  const estimate = weightedCount(rolled, now, limit.windowMs);

  return {
    allowed: estimate < limit.limit,
    state: { ...rolled, current: rolled.current + 1 },
    remaining: Math.max(0, Math.floor(limit.limit - estimate - 1)),
    retryAt: rolled.windowStart + limit.windowMs,
  };
}

/**
 * Whether a key's state can be forgotten.
 *
 * True once two whole windows have passed with nothing recorded, which is exactly
 * when {@link admitRequest} would reset it anyway. A store that sweeps on this is
 * what stops it from growing once per address that ever made a request.
 *
 * @param state - The key's counters.
 * @param now - The current time, in epoch milliseconds.
 * @param windowMs - The window length.
 * @returns `true` when the state carries no information.
 */
export function isWindowStale(
  state: WindowState,
  now: number,
  windowMs: number,
): boolean {
  return now - state.windowStart >= windowMs * 2;
}

/**
 * The key a request is limited under: its client address and its route, and nothing
 * else.
 *
 * The exclusion is the point. A key derived from anything in the request body lets an
 * attacker spread guesses across keys by varying that value, and lets them exhaust
 * somebody else's allowance by submitting that person's email address. Both parts are
 * escaped, so no address can be spelled to collide with another key.
 *
 * @param address - The client address the request arrived from.
 * @param route - A stable identifier for the route, such as `POST /api/auth/sign-in`.
 * @returns The store key.
 * @example
 * ```ts
 * const key = rateLimitKey(clientAddress, `POST ${route}`);
 * ```
 */
export function rateLimitKey(address: string, route: string): string {
  return `${encodeURIComponent(address)}:${encodeURIComponent(route)}`;
}
