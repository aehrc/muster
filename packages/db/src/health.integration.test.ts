/**
 * That the readiness ping actually reaches the database.
 *
 * The point of a readiness probe is to take a pod out of the load balancer when it
 * cannot serve, so a ping that succeeded without a round trip would be worse than no
 * probe: the deployment would report itself ready while every request failed.
 *
 * Skipped unless `MUSTER_TEST_DATABASE_URL` names a throwaway database. CI provides
 * one, so a skip there is a failure of the workflow.
 *
 * Author: John Grimes
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import { createDatabase } from "./client.js";
import { pingDatabase } from "./health.js";
import {
  hasTestDatabase,
  servingRoleUrl,
  testDatabaseUrl,
} from "./test/harness.js";

import type { DatabaseHandle } from "./client.js";

describe.skipIf(!hasTestDatabase())("pingDatabase", () => {
  let handle: DatabaseHandle;

  beforeAll(() => {
    handle = createDatabase({
      url: servingRoleUrl(testDatabaseUrl()!),
      maxConnections: 1,
      applicationName: "muster-health-test",
    });
  });

  afterAll(async () => {
    await handle?.close();
  });

  it("succeeds against a reachable database", async () => {
    await pingDatabase(handle.db);
  });

  it("fails against an unreachable one", async () => {
    // A port nothing listens on, so the failure is a connection failure rather than an
    // authentication one - which is the case a probe has to catch.
    const unreachable = createDatabase({
      url: "postgresql://muster:muster@127.0.0.1:1/muster",
      maxConnections: 1,
    });

    try {
      await expect(pingDatabase(unreachable.db)).rejects.toThrow();
    } finally {
      await unreachable.close().catch(() => {});
    }
  });
});
