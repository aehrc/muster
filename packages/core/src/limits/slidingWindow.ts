/**
 * Sliding-window rate limiter.
 *
 * Pure: the clock arrives as an argument and every call returns the next window
 * instead of mutating the one it was given, so the caller owns the state and
 * the rules are testable without a server or a wall clock.
 *
 * The key is the client address and the route, and nothing else. A key drawn
 * from a request body would let an attacker spread guesses across bodies, or
 * exhaust another account's allowance by naming it.
 *
 * @author John Grimes
 */

/** Hit times per key. */
export type SlidingWindow = ReadonlyMap<string, readonly number[]>;

/** How many attempts are allowed in how long. */
export type RateLimitPolicy = {
  /** attempts allowed within the window */
  readonly limit: number;
  /** width of the window, in milliseconds */
  readonly windowMs: number;
};

/** What one attempt decided. */
export type RateLimitDecision = {
  /** whether the attempt is allowed */
  readonly allowed: boolean;
  /** attempts left in the window after this one */
  readonly remaining: number;
  /** seconds until the next attempt can succeed; 0 when allowed */
  readonly retryAfterSeconds: number;
  /** the window to carry forward */
  readonly window: SlidingWindow;
};

/** What {@link consume} needs to decide an attempt. */
export type ConsumeOptions = {
  /** the window carried forward from the previous attempt */
  readonly window: SlidingWindow;
  /** the client's address, as seen by the server */
  readonly address: string;
  /** the route being attempted, for example `POST /api/auth/sign-in` */
  readonly route: string;
  /** the current clock reading, in milliseconds */
  readonly now: number;
  /** the policy to apply */
  readonly policy: RateLimitPolicy;
};

/** A window holding no hits. */
export const emptyWindow: SlidingWindow = new Map<string, readonly number[]>();

/** Separates route from address in a key; neither may contain a NUL. */
const keySeparator = "\u0000";

/** One second, in milliseconds. */
const secondMs = 1000;

/**
 * Rejects a policy that cannot be honoured.
 *
 * @param policy - the policy to check
 * @throws {Error} when the policy permits no attempt or spans no time
 */
const requireUsablePolicy = (policy: RateLimitPolicy): void => {
  if (!Number.isInteger(policy.limit) || policy.limit < 1) {
    throw new Error(
      "Rate limit policy limit must be a whole number above zero",
    );
  }
  if (!Number.isFinite(policy.windowMs) || policy.windowMs <= 0) {
    throw new Error("Rate limit policy windowMs must be above zero");
  }
};

/**
 * Records an attempt and decides whether it is allowed.
 *
 * A refused attempt is not recorded. Recording it would push the recovery time
 * out on every retry, so a client that hammers the route would never be let
 * back in - a self-inflicted denial of service.
 *
 * @param options - the window, client address, route, clock reading and policy
 * @returns whether the attempt is allowed, what is left, when to retry, and the
 *   window to carry forward
 * @throws {Error} when the policy permits no attempt or spans no time
 * @example
 * ```ts
 * const decision = consume({
 *   window,
 *   address: "203.0.113.7",
 *   route: "POST /api/auth/sign-in",
 *   now: Date.now(),
 *   policy: { limit: 5, windowMs: 60_000 },
 * });
 * if (!decision.allowed) {
 *   return refuse(429, { "Retry-After": String(decision.retryAfterSeconds) });
 * }
 * ```
 */
export const consume = (options: ConsumeOptions): RateLimitDecision => {
  const { window, address, route, now, policy } = options;
  requireUsablePolicy(policy);

  const key = `${route}${keySeparator}${address}`;
  const cutoff = now - policy.windowMs;
  const live = (window.get(key) ?? []).filter((hit) => hit > cutoff);

  if (live.length >= policy.limit) {
    // The allowance frees when the oldest live hit leaves the window. The
    // oldest is first because hits are appended in clock order.
    const oldest = live[0] ?? now;
    const waitMs = oldest + policy.windowMs - now;
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil(waitMs / secondMs)),
      window: replaceKey(window, key, live),
    };
  }

  const recorded = [...live, now];
  return {
    allowed: true,
    remaining: policy.limit - recorded.length,
    retryAfterSeconds: 0,
    window: replaceKey(window, key, recorded),
  };
};

/**
 * Drops expired hits, and keys left with none.
 *
 * Without this the window would hold one entry for every address ever seen.
 * Call it on an interval; {@link consume} already prunes the key it touches.
 *
 * @param window - the window to sweep
 * @param now - the current clock reading, in milliseconds
 * @param policy - the policy whose window width decides what has expired
 * @returns the swept window
 * @throws {Error} when the policy spans no time
 * @example
 * ```ts
 * window = pruneWindow(window, Date.now(), policy);
 * ```
 */
export const pruneWindow = (
  window: SlidingWindow,
  now: number,
  policy: RateLimitPolicy,
): SlidingWindow => {
  requireUsablePolicy(policy);
  const cutoff = now - policy.windowMs;
  const swept = new Map<string, readonly number[]>();
  for (const [key, hits] of window) {
    const live = hits.filter((hit) => hit > cutoff);
    if (live.length > 0) {
      swept.set(key, live);
    }
  }
  return swept;
};

/**
 * Copies a window with one key's hits replaced, or removed when empty.
 *
 * @param window - the window to copy
 * @param key - the key to replace
 * @param hits - the hits to hold against the key
 * @returns the new window
 */
const replaceKey = (
  window: SlidingWindow,
  key: string,
  hits: readonly number[],
): SlidingWindow => {
  const next = new Map(window);
  if (hits.length === 0) {
    next.delete(key);
  } else {
    next.set(key, hits);
  }
  return next;
};
