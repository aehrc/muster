/**
 * Database access for Muster.
 *
 * Drizzle schema definitions live in `schema/`, all data access in
 * `repositories/`. The migration runner and the two-role bootstrap are the
 * operational entry points used at start-up.
 *
 * @author John Grimes
 */

export {
  appliedMigrationNames,
  ensureMigrationLedger,
  migrationLedgerTable,
  pendingMigrations,
  readMigrations,
  runMigrations,
  type Migration,
  type MigrationRunResult,
  type RunMigrationsOptions,
} from "./migrations.ts";
export { quoteIdentifier, quoteLiteral } from "./quoting.ts";
export { bootstrapServerRole, type ServerRoleOptions } from "./roles.ts";
