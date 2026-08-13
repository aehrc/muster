/**
 * Asking the database whether it is holding something it should not be.
 *
 * Constitution principle IV says a client secret is never persisted. That is a claim about
 * the whole database rather than about the columns somebody thought to check, and the way it
 * gets broken is never the obvious column - it is a timeline `detail` document, a claims
 * blob, an error message recorded verbatim from a server's response. So this looks
 * everywhere: every base table in the public schema, cast whole to text.
 *
 * Casting a row to text is not something to do in a hot path, and nothing but a test calls
 * it. What it buys is a check that cannot go stale: a table added next year is searched
 * without anybody remembering to add it here.
 *
 * Author: John Grimes
 */

import { sql } from "drizzle-orm";

import type { Executor } from "../executor.js";

/** Where one occurrence was found. */
export interface SecretOccurrence {
  readonly table: string;
  readonly rows: number;
}

/**
 * Every base table in the public schema.
 *
 * Read from the catalogue rather than listed, which is the point: the search covers tables
 * this module has never heard of.
 */
async function publicTables(db: Executor): Promise<readonly string[]> {
  const rows = await db.execute<{ table_name: string }>(
    sql`
      select table_name from information_schema.tables
              where table_schema = 'public' and table_type = 'BASE TABLE'
              order by table_name
    `,
  );
  return [...rows].map((row) => row.table_name);
}

/**
 * Where a literal value appears in the database, if anywhere.
 *
 * @param db - The executor.
 * @param needle - The value that must not be stored. Matched literally.
 * @returns One entry per table holding it, with how many rows do. Empty when the value is
 *   absent, which is what a suite asserting principle IV is looking for.
 * @example
 * ```ts
 * expect(await findStoredValue(stack.db, clientSecret)).toEqual([]);
 * ```
 */
export async function findStoredValue(
  db: Executor,
  needle: string,
): Promise<readonly SecretOccurrence[]> {
  const found: SecretOccurrence[] = [];
  for (const table of await publicTables(db)) {
    // The identifier is quoted by Drizzle and the needle is a bound parameter, so a value
    // containing a quote is searched for rather than executed.
    const rows = await db.execute<{ hits: number }>(
      sql`
        select count(*)::int as hits from ${sql.identifier(table)}
                  where cast(${sql.identifier(table)} as text) like ${`%${needle}%`}
      `,
    );
    const hits = [...rows][0]?.hits ?? 0;
    if (hits > 0) {
      found.push({ table, rows: hits });
    }
  }
  return found;
}
