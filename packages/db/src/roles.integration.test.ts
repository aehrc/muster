/**
 * That the two-role split actually holds, which only Postgres can confirm.
 *
 * The unit tests assert what the generated statements say. What they cannot assert
 * is the consequence: that a connection on the serving role can do the server's
 * work and cannot migrate. Both halves matter. A serving role that could create a
 * table would make "the migrations ran as the owner" a convention rather than a
 * constraint, and a serving role that could not read would present as an empty
 * result rather than as a permission error.
 *
 * Skipped unless `MUSTER_TEST_DATABASE_URL` names a throwaway database owned by the
 * identity that migrates it. CI provides one, so a skip there is a failure of the
 * workflow rather than an accepted state.
 *
 * Author: John Grimes
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { sql } from "drizzle-orm";

import { createDatabase } from "./client.js";
import { applyMigrationsWithLock } from "./migrations.js";
import { roleNameFromDatabaseUrl } from "./roles.js";
import {
  hasTestDatabase,
  prepareTestDatabase,
  servingRoleUrl,
  SERVING_TEST_ROLE,
  testDatabaseUrl,
} from "./test/harness.js";

import type { DatabaseHandle } from "./client.js";

describe.skipIf(!hasTestDatabase())("the two-role bootstrap", () => {
  const ownerUrl = testDatabaseUrl()!;
  let owner: DatabaseHandle;
  let serving: DatabaseHandle;

  beforeAll(async () => {
    owner = createDatabase({ url: ownerUrl, maxConnections: 1 });
    // Idempotent, and the preload has almost certainly done it already. Repeating
    // it here is what lets this file be run on its own, from inside the package,
    // where Bun finds no `bunfig.toml` and so runs no preload.
    await prepareTestDatabase(ownerUrl);
    serving = createDatabase({
      url: servingRoleUrl(ownerUrl),
      maxConnections: 1,
      applicationName: "muster-roles-test",
    });
  });

  afterAll(async () => {
    await serving?.close();
    await owner?.close();
  });

  it("leaves the serving role able to query", async () => {
    // The cheapest statement that proves the connection authenticated and the
    // session is usable.
    const rows = await serving.db.execute(sql`select 1 as ok`);

    expect(rows).toHaveLength(1);
  });

  it("connects as the serving role rather than the owner", async () => {
    // Guards the guard: if the derivation silently fell back to the owning
    // credential, every assertion below would pass for the wrong reason.
    const rows = await serving.db.execute<{ role: string }>(
      sql`select current_user as role`,
    );

    expect(rows[0]?.role).toBe(SERVING_TEST_ROLE);
    expect(rows[0]?.role).not.toBe(roleNameFromDatabaseUrl(ownerUrl));
  });

  it("refuses to let the serving role create a table", async () => {
    // A role that can create a table can also migrate.
    //
    // Awaited inside a function rather than handed to `.rejects` directly: Drizzle's
    // `execute` returns a lazy builder that is thenable but is not a promise, and
    // `.rejects` given one reports the builder itself as the received value rather
    // than running the statement - so the assertion would fail without the statement
    // ever having been refused.
    const attempt = async (): Promise<void> => {
      await serving.db.execute(sql`create table muster_role_probe (id text)`);
    };
    const refusal = await attempt().then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(refusal).toBeInstanceOf(Error);
    // Drizzle's own message names only the statement it could not run; the reason
    // Postgres gave is on the cause, and asserting on it is what distinguishes a
    // refusal from a syntax error or a dropped connection.
    expect(String((refusal as Error).cause)).toMatch(/permission denied/i);
  });

  it("applies migrations idempotently", async () => {
    // The migrator is run by a deployment hook that can be retried, and by the
    // test preload on every run. A second application must be a no-op rather than
    // an error.
    await applyMigrationsWithLock(owner.db);
    await applyMigrationsWithLock(owner.db);

    const rows = await owner.db.execute<{ present: boolean }>(
      sql`select to_regclass('drizzle.__drizzle_migrations') is not null as present`,
    );

    expect(rows[0]?.present).toBe(true);
  });

  it("serialises concurrent migration attempts", async () => {
    // Two processes running the migrator at once race on the journal table. The
    // advisory lock is what makes the second wait; without it this is where a
    // half-migrated schema comes from.
    const second = createDatabase({ url: ownerUrl, maxConnections: 1 });
    try {
      await Promise.all([
        applyMigrationsWithLock(owner.db),
        applyMigrationsWithLock(second.db),
      ]);
    } finally {
      await second.close();
    }

    const rows = await owner.db.execute<{ present: boolean }>(
      sql`select to_regclass('drizzle.__drizzle_migrations') is not null as present`,
    );

    expect(rows[0]?.present).toBe(true);
  });
});
