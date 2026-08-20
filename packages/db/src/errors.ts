/*
 * Copyright © 2026 Commonwealth Scientific and Industrial Research Organisation
 * (CSIRO) ABN 41 687 119 230. Licensed under the Apache License, Version 2.0.
 */

/**
 * Classification of the database failures callers act on.
 *
 * A route answers a duplicate differently from a violated rule - 409 against
 * 422 - so the two are told apart by their SQLSTATE rather than by matching the
 * driver's message text, which is not ours and can change under us.
 *
 * @author John Grimes
 */

/** SQLSTATE for a violated unique constraint. */
const uniqueViolation = "23505";

/**
 * SQLSTATE for a violated check constraint. The enrolment tag trigger raises
 * it deliberately, so a rule expressed as a trigger classifies like a rule
 * expressed as a constraint.
 */
const checkViolation = "23514";

/**
 * Reads the SQLSTATE from a database failure.
 *
 * @param error - the value a query rejected with
 * @returns the five-character SQLSTATE, or undefined when it is not a
 *   PostgreSQL server error
 * @example
 * ```ts
 * postgresErrorCode(error); // "23505"
 * ```
 */
export const postgresErrorCode = (error: unknown): string | undefined => {
  if (typeof error !== "object" || error === null || !("errno" in error)) {
    return undefined;
  }
  const code = error.errno;
  return typeof code === "string" ? code : undefined;
};

/**
 * Reports whether a failure is a duplicate row.
 *
 * @param error - the value a query rejected with
 * @returns true when a unique constraint refused the write
 * @example
 * ```ts
 * if (isUniqueViolation(error)) {
 *   throw new HTTPException(409, { message: "That system is already enrolled" });
 * }
 * ```
 */
export const isUniqueViolation = (error: unknown): boolean =>
  postgresErrorCode(error) === uniqueViolation;

/**
 * Reports whether a failure is a violated rule in the schema.
 *
 * @param error - the value a query rejected with
 * @returns true when a check constraint or a rule trigger refused the write
 * @example
 * ```ts
 * if (isCheckViolation(error)) {
 *   throw new HTTPException(422, { message: "Those tags are not defined by the event" });
 * }
 * ```
 */
export const isCheckViolation = (error: unknown): boolean =>
  postgresErrorCode(error) === checkViolation;
