/**
 * The `migrate` command, against a real database.
 *
 * What matters here is not that the migrator works - `packages/db` tests that - but
 * that the command reports honestly. A pre-install hook that exits zero having
 * granted nothing produces a server that reads empty results from tables it cannot
 * see, and the failure surfaces days later as missing data rather than as a failed
 * Job.
 *
 * Skipped unless `MUSTER_TEST_DATABASE_URL` names a throwaway database owned by the
 * identity that migrates it. CI provides one, so a skip there is a failure of the
 * workflow rather than an accepted state.
 *
 * Author: John Grimes
 */

import {
  hasTestDatabase,
  SERVING_TEST_ROLE,
  testDatabaseUrl,
} from "@muster/db";
import { describe, expect, it } from "bun:test";

import { runMigrateCommand } from "./migrate.js";

describe.skipIf(!hasTestDatabase())("runMigrateCommand", () => {
  const ownerUrl = testDatabaseUrl()!;

  it("applies the migrations and grants the serving role, reporting both", async () => {
    const log: string[] = [];

    await runMigrateCommand(ownerUrl, SERVING_TEST_ROLE, (message) => {
      log.push(message);
    });

    // An operator reads the Job's logs to find out what ran. Both halves are named,
    // and the grant names the role, because "privileges granted" without a role is
    // the message that hides a grant made to the wrong one.
    expect(log.join("\n")).toContain("migrations");
    expect(log.join("\n")).toContain(SERVING_TEST_ROLE);
  });

  it("is a no-op the second time", async () => {
    // The hook runs on every install and upgrade; a second run must not fail.
    await runMigrateCommand(ownerUrl, SERVING_TEST_ROLE, () => {});
    await runMigrateCommand(ownerUrl, SERVING_TEST_ROLE, () => {});
  });

  it("fails when the serving role does not exist", async () => {
    // The failure this exists to prevent: a typo in `MUSTER_DATABASE_URL`'s username
    // means the grants name a role nothing connects as. Postgres refuses the
    // statement, and the command must refuse with it rather than swallowing it.
    await expect(
      runMigrateCommand(ownerUrl, "muster_role_that_does_not_exist", () => {}),
    ).rejects.toThrow();
  });
});
