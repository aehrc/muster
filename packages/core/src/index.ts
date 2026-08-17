/**
 * Pure, I/O-free domain logic for Muster.
 *
 * Sub-modules are added by the feature phases that need them: `accounts`,
 * `pairing`, `statements`, `tickets`, `checks`, `personas`, `brands`,
 * `harness` and `limits`. Nothing in this package may perform I/O.
 *
 * @author John Grimes
 */

export {
  consume,
  emptyWindow,
  pruneWindow,
  type ConsumeOptions,
  type RateLimitDecision,
  type RateLimitPolicy,
  type SlidingWindow,
} from "./limits/slidingWindow.ts";
