import type { ApiFailure } from "../api/client.ts";

/**
 * What the console is doing, and how it says so.
 *
 * Every user-visible operation reports its own state - pending, failed with its
 * cause, or succeeded (FR-037) - and every screen renders that state from one of
 * these values rather than from a scattering of booleans. A failure always
 * carries words fit to show the person who caused it: "it failed" with the cause
 * left in the network tab is the thing this module exists to prevent.
 *
 * @author John Grimes
 */

/** How an operation's message should be coloured. */
export type OperationTone = "info" | "error" | "success";

/** The state of one user-visible operation. */
export type Operation =
  | { readonly state: "idle" }
  | { readonly state: "pending"; readonly what: string }
  | { readonly state: "failed"; readonly what: string; readonly cause: string }
  | {
      readonly state: "succeeded";
      readonly what: string;
      readonly detail?: string;
    };

/** Nothing has been attempted yet. */
export const idle: Operation = { state: "idle" };

/** Words for a refusal that arrived without any of its own. */
const wordsForError: Record<string, string> = {
  network_error: "Muster could not be reached. Check the connection and retry.",
  unauthorised: "Sign in to do that.",
  forbidden: "That is not permitted for this account.",
  not_found: "That is not here.",
  method_not_allowed: "Muster does not accept that request.",
  conflict: "That has already happened, or already exists.",
  unprocessable: "Muster would not accept that input.",
  invalid_request: "That request was not valid.",
  rate_limited: "Too many attempts. Wait a moment and try again.",
  internal_error:
    "Muster failed to handle that. The cause is in the server's log.",
  unexpected_response: "Muster's answer was not the one expected.",
};

/**
 * Puts words to a failure.
 *
 * @param failure - the failure the API client produced
 * @returns a sentence fit to show the person who caused it
 * @example
 * ```ts
 * setMessage(describeFailure(result.failure));
 * ```
 */
export const describeFailure = (failure: ApiFailure): string =>
  failure.detail ??
  wordsForError[failure.error] ??
  `Muster answered ${failure.error} (HTTP ${String(failure.status)}).`;

/**
 * An operation that has been started and has not finished.
 *
 * @param what - the operation, as a present-participle phrase such as "Creating
 *   the organisation"
 * @returns the pending state
 * @example
 * ```ts
 * setOperation(pending("Enrolling Smart Forms"));
 * ```
 */
export const pending = (what: string): Operation => ({
  state: "pending",
  what,
});

/**
 * An operation that was refused, with the cause.
 *
 * @param what - the operation, as a present-participle phrase
 * @param failure - what the API client reported
 * @returns the failed state
 * @example
 * ```ts
 * if (!result.ok) {
 *   setOperation(failed("Signing in", result.failure));
 * }
 * ```
 */
export const failed = (what: string, failure: ApiFailure): Operation => ({
  state: "failed",
  what,
  cause: describeFailure(failure),
});

/**
 * An operation that finished.
 *
 * @param what - the operation, as a present-participle phrase
 * @param detail - what to say instead of the generic sentence, when there is
 *   something more useful to report
 * @returns the succeeded state
 * @example
 * ```ts
 * setOperation(succeeded("Enrolling Smart Forms", "Enrolled, details confirmed just now."));
 * ```
 */
export const succeeded = (what: string, detail?: string): Operation => ({
  state: "succeeded",
  what,
  ...(detail === undefined ? {} : { detail }),
});

/**
 * The sentence to show for an operation.
 *
 * @param operation - the operation's state
 * @returns the sentence, or undefined when there is nothing to report
 * @example
 * ```ts
 * const message = operationMessage(operation);
 * ```
 */
export const operationMessage = (operation: Operation): string | undefined => {
  switch (operation.state) {
    case "idle": {
      return undefined;
    }
    case "pending": {
      return `${operation.what}…`;
    }
    case "failed": {
      return `${operation.what} failed. ${operation.cause}`;
    }
    case "succeeded": {
      return operation.detail ?? `${operation.what} succeeded.`;
    }
  }
};

/**
 * How to colour an operation's message.
 *
 * @param operation - the operation's state
 * @returns the tone
 */
export const operationTone = (operation: Operation): OperationTone => {
  if (operation.state === "failed") {
    return "error";
  }
  return operation.state === "succeeded" ? "success" : "info";
};

/**
 * Whether an operation is in flight.
 *
 * @param operation - the operation's state
 * @returns true while it has been started and has not finished
 * @example
 * ```ts
 * <button className="btn" disabled={busy(operation)}>Sign in</button>
 * ```
 */
export const busy = (operation: Operation): boolean =>
  operation.state === "pending";
