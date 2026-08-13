/**
 * Migrates the test database once, before any test file is loaded.
 *
 * See `./harness.ts` for why this is not done lazily. Skipped entirely when no test
 * database is configured, which is the case for a developer running only the unit
 * suites: the integration files check the same variable and skip themselves.
 *
 * Registered as `preload` under `[test]` in the repository's `bunfig.toml`, so it
 * runs once per `bun test` invocation, before the first test file is imported. Bun
 * resolves `bunfig.toml` from the working directory and does not search upwards, so
 * `bun test` run from inside a package gets no preload - which is why the harness
 * still prepares the database for itself when the ready flag is unset rather than
 * depending on this having run.
 *
 * Author: John Grimes
 */

import { prepareTestDatabase, testDatabaseUrl } from "./harness.js";

const url = testDatabaseUrl();

if (url !== undefined) {
  await prepareTestDatabase(url);
}
