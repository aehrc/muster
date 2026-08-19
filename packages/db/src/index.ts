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
  ciphertextVersion,
  currentCiphertextVersion,
  decryptUnderMasterKey,
  encryptUnderMasterKey,
} from "./crypto/masterKey.ts";
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
export { describeConnection } from "./describing.ts";
export { quoteIdentifier, quoteLiteral } from "./quoting.ts";
export {
  findCheckStatus,
  insertCheckResult,
  listCheckResults,
  listCheckStatuses,
  listCheckTargets,
  type CheckHistoryQuery,
  type CheckResultRow,
  type CheckStatusRow,
  type CheckTargetRow,
  type NewCheckResult,
} from "./repositories/checks.ts";
export {
  deleteOrganisationMember,
  deleteSession,
  findAccountByEmail,
  findAccountById,
  findAccountBySessionToken,
  findAccountTokenByHash,
  findEnrolledSystem,
  findEnrolment,
  findEnrolmentById,
  findEventById,
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
export {
  findHarnessRun,
  findLatestHarnessRun,
  insertHarnessRun,
  listHarnessRuns,
  listLatestHarnessRuns,
  type HarnessRunQuery,
  type HarnessRunRow,
  type NewHarnessRun,
} from "./repositories/harness.ts";
export {
  findActiveSigningKey,
  findSigningKeyByKid,
  insertSigningKey,
  listPublishableSigningKeys,
  supersedeSigningKey,
  type NewSigningKey,
  type SigningKeyRow,
} from "./repositories/keys.ts";
export {
  findPairingByKey,
  findPairingRecord,
  insertPairing,
  insertPairingEvent,
  listPairingEvents,
  listPairingRecordsForOrganisations,
  listPairingsInState,
  updatePairingState,
  type NewPairing,
  type NewPairingEvent,
  type PairingEventRow,
  type PairingKey,
  type PairingListQuery,
  type PairingPartyRow,
  type PairingRecordRow,
  type PairingRow,
  type PairingStateChange,
  type PairingStateQuery,
} from "./repositories/pairings.ts";
export {
  findPersonaById,
  findPersonaByIhi,
  insertPersona,
  insertPersonaCoverage,
  listCoverageTargets,
  listLatestPersonaCoverage,
  listPersonaCoverage,
  listPersonas,
  listPersonaSourceTargets,
  updatePersonaSourceStatus,
  type CoverageTargetRow,
  type NewPersona,
  type NewPersonaCoverage,
  type PersonaCoverageRow,
  type PersonaKey,
  type PersonaRow,
  type SourceStatusChange,
  type SourceTargetRow,
} from "./repositories/personas.ts";
export {
  findLatestStatementForPairing,
  insertSoftwareStatement,
  type NewSoftwareStatement,
  type SoftwareStatementRow,
} from "./repositories/statements.ts";
export {
  insertTicket,
  type NewTicket,
  type TicketRow,
} from "./repositories/tickets.ts";
export { bootstrapServerRole, type ServerRoleOptions } from "./roles.ts";
