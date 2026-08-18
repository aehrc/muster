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
  isCheckViolation,
  isUniqueViolation,
  postgresErrorCode,
} from "./errors.ts";
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
export {
  deleteOrganisationMember,
  deleteSession,
  findAccountByEmail,
  findAccountById,
  findAccountBySessionToken,
  findAccountTokenByHash,
  findEnrolledSystem,
  findEnrolment,
  findEventBySlug,
  findOrganisationById,
  findSystemById,
  insertAccount,
  insertAccountToken,
  insertEnrolment,
  insertEvent,
  insertOrganisation,
  insertOrganisationMember,
  insertSession,
  insertSystem,
  listAccountsByStatus,
  listEnrolledSystems,
  listEvents,
  listMembershipsForAccount,
  listNotifiableAdmins,
  listOrganisationContacts,
  listSystemsByOrganisation,
  markAccountTokenUsed,
  markAccountVerified,
  reconfirmEnrolment,
  updateAccountStatus,
  updateEvent,
  updateSystem,
  type AccountRow,
  type AccountTokenPurpose,
  type AccountTokenRow,
  type EnrolledSystemRow,
  type EnrolmentRow,
  type EventPatch,
  type EventRow,
  type Membership,
  type NewAccount,
  type NewAccountToken,
  type NewEnrolment,
  type NewEvent,
  type NewSession,
  type NewSystem,
  type OrganisationContact,
  type OrganisationRow,
  type Reconfirmation,
  type StatusDecision,
  type SystemPatch,
  type SystemRow,
} from "./repositories/directory.ts";
export { bootstrapServerRole, type ServerRoleOptions } from "./roles.ts";
