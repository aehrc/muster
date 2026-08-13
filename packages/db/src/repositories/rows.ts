/**
 * Taking the row a statement was supposed to produce.
 *
 * `noUncheckedIndexedAccess` types `rows[0]` as possibly undefined, which is correct and
 * which every insert in this package would otherwise have to placate with a non-null
 * assertion. These two functions make the distinction explicit instead: an insert that
 * returned nothing is a broken invariant, and a lookup that returned nothing is an
 * ordinary outcome.
 *
 * Author: John Grimes
 */

/**
 * Thrown when a statement that must produce exactly one row produced none.
 *
 * A broken invariant rather than a user-facing condition - an unconditional
 * `insert ... returning` that yields nothing means the schema and this code disagree - so
 * it is deliberately not part of any repository's return type. Callers should not be
 * tempted to handle it.
 */
export class RepositoryInvariantError extends Error {
  /** @param message - What was expected, and of which statement. */
  public constructor(message: string) {
    super(message);
    this.name = "RepositoryInvariantError";
  }
}

/**
 * Takes the single row a statement was required to produce.
 *
 * @param rows - The `returning` result.
 * @param description - Named in the error, for example `insert into account`.
 * @returns The row.
 * @throws {RepositoryInvariantError} When no row was returned.
 * @example
 * ```ts
 * return requireRow(rows, "insert into organisation");
 * ```
 */
export function requireRow<T>(rows: readonly T[], description: string): T {
  const row = rows[0];
  if (row === undefined) {
    throw new RepositoryInvariantError(
      `${description} returned no row, which the schema should make impossible`,
    );
  }
  return row;
}

/**
 * Takes the first row, if the statement produced one.
 *
 * Used where an empty result is a real outcome: a lookup that found nothing, or a
 * conditional update whose predicate did not hold.
 *
 * @param rows - The result.
 * @returns The first row, or `undefined`.
 */
export function firstRow<T>(rows: readonly T[]): T | undefined {
  return rows[0];
}
