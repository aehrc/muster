/**
 * Recognising the database errors that are part of the domain.
 *
 * Two writes in the directory race in a way the application cannot prevent by looking
 * first: two sign-ups for one address, and two enrolments of one system in one event.
 * Checking and then inserting leaves a window; inserting and recognising the constraint
 * violation does not. So a unique violation on a named constraint is a domain outcome
 * here rather than a crash.
 *
 * The predicates are structural rather than `instanceof PostgresError`, so they hold for
 * an error that has crossed a pooling or serialisation boundary, and so they can be unit
 * tested without a driver.
 *
 * Author: John Grimes
 */

/** Postgres `unique_violation`. */
export const UNIQUE_VIOLATION = "23505";

/** Postgres `check_violation`. */
export const CHECK_VIOLATION = "23514";

/**
 * How far down a `cause` chain to look.
 *
 * A driver error wrapped by a pool wrapped by a serialisation boundary is three deep;
 * beyond that the chain is more likely circular than informative.
 */
const MAX_CAUSE_DEPTH = 3;

/** The `code` a Postgres error carries, whatever has wrapped it. */
function sqlStateOf(error: unknown, depth = 0): string | undefined {
  if (typeof error !== "object" || error === null || depth > MAX_CAUSE_DEPTH) {
    return undefined;
  }
  const candidate = error as {
    readonly code?: unknown;
    readonly constraint_name?: unknown;
    readonly cause?: unknown;
  };
  if (typeof candidate.code === "string") {
    return candidate.code;
  }
  return sqlStateOf(candidate.cause, depth + 1);
}

/** The constraint a Postgres error names, whatever has wrapped it. */
function constraintOf(error: unknown, depth = 0): string | undefined {
  if (typeof error !== "object" || error === null || depth > MAX_CAUSE_DEPTH) {
    return undefined;
  }
  const candidate = error as {
    readonly constraint_name?: unknown;
    readonly cause?: unknown;
  };
  if (typeof candidate.constraint_name === "string") {
    return candidate.constraint_name;
  }
  return constraintOf(candidate.cause, depth + 1);
}

/**
 * Whether an error is a unique violation, optionally of one named constraint.
 *
 * Naming the constraint matters: a sign-up that collided on the address is a message for
 * the participant, and a sign-up that collided on anything else is a bug that must not be
 * reported as a taken address.
 *
 * @param error - The thrown value.
 * @param constraint - The constraint name to require, if any.
 * @returns `true` when the error is that violation.
 * @example
 * ```ts
 * catch (error) {
 *   if (isUniqueViolation(error, "account_email_unique")) {
 *     return { ok: false, reason: "email-taken" };
 *   }
 *   throw error;
 * }
 * ```
 */
export function isUniqueViolation(
  error: unknown,
  constraint?: string,
): boolean {
  if (sqlStateOf(error) !== UNIQUE_VIOLATION) {
    return false;
  }
  return constraint === undefined || constraintOf(error) === constraint;
}

/**
 * Whether an error is a check-constraint violation, optionally of one named constraint.
 *
 * @param error - The thrown value.
 * @param constraint - The constraint name to require, if any.
 * @returns `true` when the error is that violation.
 */
export function isCheckViolation(error: unknown, constraint?: string): boolean {
  if (sqlStateOf(error) !== CHECK_VIOLATION) {
    return false;
  }
  return constraint === undefined || constraintOf(error) === constraint;
}
