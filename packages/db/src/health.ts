/**
 * Asking the database whether it is there.
 *
 * Its own module rather than part of the client, because it is the one query that is
 * not about data: the readiness probe. A pod that cannot reach Postgres can serve no
 * request and should leave the load balancer rather than answering every request with
 * a 500 - which only works if the probe makes a real round trip.
 *
 * Author: John Grimes
 */

import { sql } from "drizzle-orm";

import type { Executor } from "./executor.js";

/**
 * Executes the cheapest statement that proves the connection works.
 *
 * @param db - An open connection.
 * @throws {Error} When the database cannot be reached or refuses the statement, which
 *   is what the caller reports as unready.
 * @example
 * ```ts
 * try {
 *   await pingDatabase(context.db);
 * } catch {
 *   return context.json({ status: "unavailable" }, 503);
 * }
 * ```
 */
export async function pingDatabase(db: Executor): Promise<void> {
  await db.execute(sql`select 1`);
}
