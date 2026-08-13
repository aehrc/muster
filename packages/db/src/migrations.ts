/**
 * Applying the generated migrations.
 *
 * This lives in the data layer rather than in the server for a reason that is more
 * than tidiness: it is the only place that knows where the migration folder is, and
 * it keeps `drizzle-orm` a dependency of exactly one workspace package. A second
 * package depending on Drizzle directly means two resolved copies, and two copies of
 * a library whose types carry private fields are mutually unassignable - so the
 * server would need a cast to hand its own connection to its own migrator.
 *
 * Migrations are never applied at server startup. The deployment runs this as a hook
 * that completes before the new pod is admitted, as the identity that owns the
 * schema - which is not the identity the server serves with. See `./roles.ts`.
 *
 * Author: John Grimes
 */

import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { Executor } from "./executor.js";

/**
 * Where the generated SQL and its journal might be, relative to this module.
 *
 * Two layouts have to work, and `import.meta.url` means something different in
 * each. Unbundled - the tests, and `drizzle-kit` - this module is
 * `packages/db/src/migrations.ts`, so the folder is one level up. Bundled into the
 * server, it is `/app/dist/index.js`, and the Dockerfile copies the folder to
 * `/app/drizzle`, which is also one level up. The third candidate covers running the
 * built bundle from a workspace checkout, where `apps/server/dist/index.js` has to
 * reach back into `packages/db`.
 *
 * Resolved by existence rather than by a build-time constant, so a developer running
 * the command out of a checkout need configure nothing.
 */
const MIGRATION_FOLDER_CANDIDATES: readonly string[] = [
  fileURLToPath(new URL("../drizzle", import.meta.url)),
  fileURLToPath(new URL("../../drizzle", import.meta.url)),
  fileURLToPath(new URL("../../../packages/db/drizzle", import.meta.url)),
];

/**
 * Locates the migration folder.
 *
 * @param candidates - Where to look, in order. Defaults to the layouts above; named
 *   explicitly by the tests, which have to observe the failure.
 * @returns The first candidate that exists.
 * @throws {Error} When no candidate exists, naming every path tried. A migration
 *   command that silently applied nothing would report success against an
 *   unmigrated database, which is the worst available outcome for a pre-upgrade
 *   hook.
 */
export function resolveMigrationsFolder(
  candidates: readonly string[] = MIGRATION_FOLDER_CANDIDATES,
): string {
  const found = candidates.find((candidate) => existsSync(candidate));
  if (found === undefined) {
    throw new Error(
      `Could not find the migrations folder. Tried: ${candidates.join(", ")}`,
    );
  }
  return found;
}

/**
 * Advisory lock serialising migration across processes.
 *
 * Needed by the test suites: `bun test` migrates once from its preload, but two
 * `bun test` invocations against one database are a thing a developer does, and two
 * processes running the migrator at once race on the journal table. It is also a
 * cheap safeguard for a deployment whose hook is somehow run twice.
 */
const MIGRATION_LOCK_KEY = 6_878_737;

/**
 * Applies every outstanding migration.
 *
 * @param db - An open connection, on the identity that owns the schema.
 * @param migrationsFolder - Where the migrations live. Defaults to whichever
 *   candidate {@link resolveMigrationsFolder} finds.
 */
export async function applyMigrations(
  db: Executor,
  migrationsFolder: string = resolveMigrationsFolder(),
): Promise<void> {
  // Drizzle's migrator is typed against its own database handle rather than the
  // widened `Executor` the repositories accept. It is the same object; only the
  // phantom schema type parameter differs.
  await migrate(db as unknown as Parameters<typeof migrate>[0], {
    migrationsFolder,
  });
}

/**
 * Runs work while holding the session-level migration advisory lock.
 *
 * The lock is released in a `finally`, and a crash releases it with the session, so
 * failed work cannot leave the next migration waiting forever.
 *
 * Exported so that one lock can be held across applying the migrations *and*
 * issuing the serving role's grants. Those are two steps of one operation: a second
 * process that observed the schema between them would see tables the serving role
 * cannot reach, which is indistinguishable from a migration that shipped a table
 * ungranted.
 *
 * @param db - An open connection. Must be a single connection rather than a pool: a
 *   session-level advisory lock belongs to the session that took it, and a pooled
 *   unlock issued on a different connection releases nothing.
 * @param work - What to do under the lock.
 * @returns Whatever `work` returns.
 * @example
 * ```ts
 * await withMigrationLock(handle.db, async () => {
 *   await applyMigrations(handle.db);
 *   await applyServingRolePrivileges(handle.db, role);
 * });
 * ```
 */
export async function withMigrationLock<T>(
  db: Executor,
  work: () => Promise<T>,
): Promise<T> {
  await db.execute(sql`select pg_advisory_lock(${MIGRATION_LOCK_KEY})`);
  try {
    return await work();
  } finally {
    await db.execute(sql`select pg_advisory_unlock(${MIGRATION_LOCK_KEY})`);
  }
}

/**
 * Applies migrations while holding the advisory lock.
 *
 * @param db - An open connection, on the identity that owns the schema.
 * @param migrationsFolder - Where the migrations live.
 */
export async function applyMigrationsWithLock(
  db: Executor,
  migrationsFolder: string = resolveMigrationsFolder(),
): Promise<void> {
  await withMigrationLock(db, async () => {
    await applyMigrations(db, migrationsFolder);
  });
}
