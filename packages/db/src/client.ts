/**
 * Opening a connection to Muster's database.
 *
 * Author: John Grimes
 */

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import type { Executor } from "./executor.js";

/** Options for opening a Muster database connection. */
export interface DatabaseOptions {
  /** Postgres connection string. */
  readonly url: string;
  /** Maximum pooled connections. */
  readonly maxConnections?: number;
  /**
   * What this connection calls itself in `pg_stat_activity`.
   *
   * Ordinary operational hygiene - an operator looking at a busy database should be
   * able to tell Muster's backends from a reporting job's - and it is also what lets
   * a test observe one connection while others are open against the same database.
   */
  readonly applicationName?: string;
}

/**
 * A Drizzle handle, of exactly the type every repository accepts.
 *
 * Drizzle is deliberately constructed WITHOUT its `schema` option. Passing the
 * schema produces a differently parameterised type that is not assignable to
 * {@link Executor}, which would force a cast at every repository call site - the
 * kind of friction that eventually gets solved with `as any`. The relational query
 * builder it unlocks (`db.query.*`) is unused: the repositories write their joins
 * explicitly. If that changes, widen `Executor` rather than casting here.
 */
export type Database = Executor;

/** An open connection and the means to close it. */
export interface DatabaseHandle {
  readonly db: Database;
  readonly close: () => Promise<void>;
}

/**
 * Opens a pooled Postgres connection and wraps it with Drizzle.
 *
 * The caller owns the returned `close` function; the server shares a single
 * instance for the process lifetime.
 *
 * @param options - Connection settings.
 * @returns The handle, and the means to close it.
 * @example
 * ```ts
 * const handle = createDatabase({ url: config.databaseUrl });
 * try {
 *   await handle.db.execute(sql`select 1`);
 * } finally {
 *   await handle.close();
 * }
 * ```
 */
export function createDatabase(options: DatabaseOptions): DatabaseHandle {
  const connection = postgres(options.url, {
    max: options.maxConnections ?? 10,
    // Connection and notice output must never surface the credentials embedded in
    // the connection URL.
    onnotice: () => {},
    ...(options.applicationName === undefined
      ? {}
      : { connection: { application_name: options.applicationName } }),
  });

  return {
    db: drizzle(connection),
    close: async () => {
      await connection.end();
    },
  };
}
