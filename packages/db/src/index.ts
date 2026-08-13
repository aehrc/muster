/**
 * Author: John Grimes
 */

export {
  createDatabase,
  type Database,
  type DatabaseHandle,
  type DatabaseOptions,
} from "./client.js";
export * from "./crypto/index.js";
export type { Executor } from "./executor.js";
export { pingDatabase } from "./health.js";
export * from "./migrations.js";
export * from "./repositories/index.js";
export * from "./roles.js";
export * from "./schema/index.js";

// The integration-test harness. Exported because suites in `apps/server` need it and
// cannot reach into this package's internals: only this package depends on Drizzle.
// See `./test/harness.ts`.
export {
  approve,
  clientProfileFixture,
  makeAccount,
  makeEnrolment,
  makeEvent,
  makeOrganisation,
  makeSystem,
  serverProfileFixture,
  uniqueSuffix,
  type AccountFixture,
  type EnrolmentFixture,
} from "./test/factories.js";
export { findStoredValue, type SecretOccurrence } from "./test/secrets.js";
export {
  databaseUrlWith,
  hasTestDatabase,
  openTestDatabase,
  prepareTestDatabase,
  servingRoleUrl,
  testDatabaseUrl,
  SERVING_TEST_ROLE,
  TEST_DATABASE_URL_VARIABLE,
  type ConnectionUrlChanges,
} from "./test/harness.js";
