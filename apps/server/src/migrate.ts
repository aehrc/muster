/**
 * The `migrate` command.
 *
 * Run as `node dist/index.js migrate`, which is what the Helm chart's
 * pre-install/pre-upgrade hook Job invokes and what `bun run migrate` does from a
 * checkout. It is a command rather than something the server does at startup: a
 * hook Job runs once, to completion, before any new pod is admitted, whereas a
 * server that migrated on boot would race with itself on a restart.
 *
 * It is also the only command needing the owning identity. Migrations are DDL and
 * the grants are issued by the role that owns the objects, so the owner credential
 * exists at one point in a deployment's life rather than sitting in the running pod.
 *
 * The migrator and the grants both come from `@muster/db`, which is the only package
 * that depends on Drizzle - see its `migrations.ts` for why that matters.
 *
 * Author: John Grimes
 */

import {
  applyMigrations,
  applyServingRolePrivileges,
  createDatabase,
  resolveMigrationsFolder,
  withMigrationLock,
} from "@muster/db";

/**
 * Applies every outstanding migration, grants the serving role, and closes the
 * connection.
 *
 * The two steps are one operation under one advisory lock. A process observing the
 * schema between them would find tables the serving role cannot reach, which is
 * indistinguishable from a migration that shipped a table ungranted - and the grants
 * are what stop that from being possible at all.
 *
 * @param ownerUrl - The owning identity's connection string.
 * @param servingRole - The role the server connects as, parsed from
 *   `MUSTER_DATABASE_URL`. Named rather than connected as, so this command holds no
 *   credential it has no use for.
 * @param log - Where progress goes. Injected so the command is testable, and so a
 *   deployment can read in the Job's logs what actually ran.
 * @throws {Error} When a migration or a grant fails. Reporting success against a
 *   database whose serving role cannot reach its tables is the worst outcome
 *   available to a pre-upgrade hook: it surfaces later as an empty result rather
 *   than as a failed Job.
 * @example
 * ```ts
 * const { ownerUrl, servingRole } = resolveMigrationIdentities(process.env);
 * await runMigrateCommand(ownerUrl, servingRole);
 * ```
 */
export async function runMigrateCommand(
  ownerUrl: string,
  servingRole: string,
  log: (message: string) => void = console.log,
): Promise<void> {
  log(`Applying migrations from ${resolveMigrationsFolder()}`);

  // A single connection: migrations are serial by nature, a pool would leave idle
  // connections open while the Job waits to exit, and a session-level advisory lock
  // belongs to the session that took it - a pooled unlock issued on another
  // connection releases nothing.
  const handle = createDatabase({ url: ownerUrl, maxConnections: 1 });
  try {
    await withMigrationLock(handle.db, async () => {
      await applyMigrations(handle.db);
      log("Migrations applied");
      await applyServingRolePrivileges(handle.db, servingRole);
    });
    log(`Privileges granted to the serving role ${servingRole}`);
  } finally {
    await handle.close();
  }
}
