/**
 * The database handle every repository function accepts.
 *
 * Repositories take an {@link Executor} rather than the concrete `Database` from
 * `./client.js`, because a Drizzle transaction and a Drizzle connection expose the
 * same query surface but are different types. Typing against the common supertype
 * means one implementation serves both, so a caller can compose several repository
 * calls into a single transaction without a parallel set of transaction-only
 * functions.
 *
 * Author: John Grimes
 */

import type { PgDatabase } from "drizzle-orm/pg-core";
import type { PostgresJsQueryResultHKT } from "drizzle-orm/postgres-js";

/**
 * A Drizzle connection or transaction against the Muster schema.
 *
 * Relational queries (`db.query.*`) are deliberately not part of this type: they
 * require the schema to have been passed to `drizzle()`, and the repositories build
 * their predicates explicitly instead.
 */
export type Executor = PgDatabase<
  PostgresJsQueryResultHKT,
  Record<string, never>
>;
