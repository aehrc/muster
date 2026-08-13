/**
 * The check table and its repository, against a real Postgres.
 *
 * What no unit test can assert lives here. The history is retained and the latest row per
 * enrolment drives the badges (`data-model.md`), which is a property of the query rather
 * than of any function: a repository that returned the oldest row, or one row per
 * enrolment per event, would still typecheck. And `reachable` and `failure_mode` are one
 * fact stated twice, held by a check constraint, so a future route cannot record a
 * reachable server with a timeout.
 *
 * The other subject is scenario 2. An unreachable server is shown with the time of the
 * last *successful* check, which is a different row from the latest one - so the status
 * read has to find both, and a test that only wrote failures would not notice it finding
 * neither.
 *
 * Every call is made as the non-owning serving role, which is what a deployment serves
 * with.
 *
 * Skipped unless `MUSTER_TEST_DATABASE_URL` names a throwaway database. CI provides one,
 * so a skip there is a failure of the workflow rather than an accepted state.
 *
 * Author: John Grimes
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import {
  findCheckStatus,
  insertCheckResult,
  listCheckHistory,
  listCheckStatuses,
  listServerCheckTargets,
} from "./checks.js";
import { isCheckViolation } from "./errors.js";
import {
  clientProfileFixture,
  makeAccount,
  makeEnrolment,
  makeEvent,
  makeOrganisation,
  makeSystem,
  serverProfileFixture,
  uniqueSuffix,
} from "../test/factories.js";
import { hasTestDatabase, openTestDatabase } from "../test/harness.js";

import type { NewCheckResult } from "./checks.js";
import type { DatabaseHandle } from "../client.js";
import type { Executor } from "../executor.js";
import type { DiscoveryHighlights } from "@muster/contracts";

/** The highlights a fixture check records. */
const DISCOVERY: DiscoveryHighlights = {
  issuer: "https://fhir.muster.test",
  authorizationEndpoint: "https://fhir.muster.test/auth/authorize",
  tokenEndpoint: "https://fhir.muster.test/auth/token",
  registrationEndpoint: null,
  introspectionEndpoint: null,
  jwksUri: null,
  scopesSupported: ["launch", "openid", "fhirUser"],
  capabilities: ["launch-standalone"],
  grantTypesSupported: ["authorization_code"],
  permissionTicketTypesSupported: ["patient-self-access"],
};

/** A check that succeeded. */
function success(enrolmentId: string, checkedAt: Date): NewCheckResult {
  return {
    enrolmentId,
    checkedAt,
    reachable: true,
    failureMode: null,
    detail: null,
    discovery: DISCOVERY,
    capability: null,
    driftFlags: [],
  };
}

/** A check that did not. */
function failure(
  enrolmentId: string,
  checkedAt: Date,
  overrides: Partial<NewCheckResult> = {},
): NewCheckResult {
  return {
    enrolmentId,
    checkedAt,
    reachable: false,
    failureMode: "timeout",
    detail: "https://fhir.muster.test/r4 did not answer in time",
    discovery: null,
    capability: null,
    driftFlags: [],
    ...overrides,
  };
}

describe.skipIf(!hasTestDatabase())("the check repository", () => {
  let handle: DatabaseHandle;
  let db: Executor;

  beforeAll(async () => {
    handle = (await openTestDatabase())!;
    db = handle.db;
  });

  afterAll(async () => {
    await handle.close();
  });

  /** An organisation with one server enrolled in one open event. */
  async function scene(status: "open" | "draft" = "open") {
    const owner = await makeAccount(db);
    const organisation = await makeOrganisation(db, owner.id);
    const event = await makeEvent(db, { status: "open" });
    const system = await makeSystem(db, organisation.id);
    const enrolment = await makeEnrolment(db, {
      event,
      systemId: system.id,
      accountId: owner.id,
    });
    // The event is opened to enrol, because `upsertEnrolment` refuses anything else, and
    // only then moved to the status the case is about.
    return { owner, organisation, event, system, enrolment, status };
  }

  it("records what a check found, and reads it back", async () => {
    const { enrolment } = await scene();
    const at = new Date("2026-09-15T12:04:00.000Z");

    const written = await insertCheckResult(db, success(enrolment.id, at));

    expect(written.enrolmentId).toBe(enrolment.id);
    expect(written.checkedAt.toISOString()).toBe(at.toISOString());
    expect(written.reachable).toBe(true);
    expect(written.failureMode).toBeNull();
    expect(written.discovery?.tokenEndpoint).toBe(
      "https://fhir.muster.test/auth/token",
    );
    expect(written.discovery?.permissionTicketTypesSupported).toEqual([
      "patient-self-access",
    ]);
  });

  it("keeps the drift flags a check found, with both values", async () => {
    const { enrolment } = await scene();

    const written = await insertCheckResult(db, {
      ...success(enrolment.id, new Date("2026-09-15T12:04:00.000Z")),
      driftFlags: [
        {
          field: "tokenEndpoint",
          declared: "https://fhir.muster.test/oauth/token",
          advertised: "https://fhir.muster.test/auth/token",
        },
      ],
    });

    expect(written.driftFlags).toEqual([
      {
        field: "tokenEndpoint",
        declared: "https://fhir.muster.test/oauth/token",
        advertised: "https://fhir.muster.test/auth/token",
      },
    ]);
  });

  it("retains the history and reports the latest row as the status", async () => {
    // `data-model.md`: history retained, latest row per enrolment drives the badges.
    const { enrolment } = await scene();
    await insertCheckResult(
      db,
      success(enrolment.id, new Date("2026-09-15T09:31:00.000Z")),
    );
    await insertCheckResult(
      db,
      failure(enrolment.id, new Date("2026-09-15T09:46:00.000Z")),
    );

    const status = await findCheckStatus(db, enrolment.id);
    const history = await listCheckHistory(db, enrolment.id);

    expect(status?.latest.checkedAt.toISOString()).toBe(
      "2026-09-15T09:46:00.000Z",
    );
    expect(status?.latest.reachable).toBe(false);
    expect(history).toHaveLength(2);
    // Newest first, which is the order the system page's history list shows.
    expect(history.map((row) => row.checkedAt.toISOString())).toEqual([
      "2026-09-15T09:46:00.000Z",
      "2026-09-15T09:31:00.000Z",
    ]);
  });

  it("reports the last successful check beside a failing latest one (scenario 2)", async () => {
    const { enrolment } = await scene();
    await insertCheckResult(
      db,
      success(enrolment.id, new Date("2026-09-15T09:31:00.000Z")),
    );
    await insertCheckResult(
      db,
      failure(enrolment.id, new Date("2026-09-15T09:46:00.000Z")),
    );
    await insertCheckResult(
      db,
      failure(enrolment.id, new Date("2026-09-15T10:01:00.000Z")),
    );

    const status = await findCheckStatus(db, enrolment.id);

    // The event view says "Unreachable since 09:31", so the time it shows is the last
    // success rather than the first failure or the latest attempt.
    expect(status?.latest.checkedAt.toISOString()).toBe(
      "2026-09-15T10:01:00.000Z",
    );
    expect(status?.lastSuccessAt?.toISOString()).toBe(
      "2026-09-15T09:31:00.000Z",
    );
  });

  it("reports no last success for a server that has never answered", async () => {
    const { enrolment } = await scene();
    await insertCheckResult(
      db,
      failure(enrolment.id, new Date("2026-09-15T09:46:00.000Z")),
    );

    const status = await findCheckStatus(db, enrolment.id);

    expect(status?.lastSuccessAt).toBeNull();
  });

  it("reports nothing for an enrolment nobody has checked", async () => {
    // Absence rather than a manufactured "unreachable": a server nobody has looked at has
    // not failed.
    const { enrolment } = await scene();

    expect(await findCheckStatus(db, enrolment.id)).toBeUndefined();
    expect(await listCheckHistory(db, enrolment.id)).toEqual([]);
  });

  it("reads a status per enrolment in one query, and omits the unchecked", async () => {
    const first = await scene();
    const second = await scene();
    await insertCheckResult(
      db,
      success(first.enrolment.id, new Date("2026-09-15T12:04:00.000Z")),
    );

    const statuses = await listCheckStatuses(db, [
      first.enrolment.id,
      second.enrolment.id,
    ]);

    expect(statuses.get(first.enrolment.id)?.latest.reachable).toBe(true);
    expect(statuses.has(second.enrolment.id)).toBe(false);
  });

  it("does not mix two enrolments' checks", async () => {
    const first = await scene();
    const second = await scene();
    await insertCheckResult(
      db,
      success(first.enrolment.id, new Date("2026-09-15T12:04:00.000Z")),
    );
    await insertCheckResult(
      db,
      failure(second.enrolment.id, new Date("2026-09-15T12:05:00.000Z")),
    );

    const statuses = await listCheckStatuses(db, [
      first.enrolment.id,
      second.enrolment.id,
    ]);

    expect(statuses.get(first.enrolment.id)?.latest.reachable).toBe(true);
    expect(statuses.get(second.enrolment.id)?.latest.reachable).toBe(false);
    expect(statuses.get(second.enrolment.id)?.latest.failureMode).toBe(
      "timeout",
    );
  });

  it("answers an empty request without asking the database anything", async () => {
    expect((await listCheckStatuses(db, [])).size).toBe(0);
  });

  it("refuses a reachable check that carries a failure mode", async () => {
    // The badge and the sentence beside it read these two columns, so a row where they
    // disagree would put "Reachable" and "timed out" on the same line.
    const { enrolment } = await scene();

    let caught: unknown;
    try {
      await insertCheckResult(db, {
        ...success(enrolment.id, new Date("2026-09-15T12:04:00.000Z")),
        failureMode: "timeout",
      });
    } catch (error) {
      caught = error;
    }

    expect(
      isCheckViolation(caught, "check_result_reachable_has_no_failure_mode"),
    ).toBe(true);
  });

  it("refuses an unreachable check that carries no failure mode", async () => {
    const { enrolment } = await scene();

    let caught: unknown;
    try {
      await insertCheckResult(db, {
        ...failure(enrolment.id, new Date("2026-09-15T12:04:00.000Z")),
        failureMode: null,
      });
    } catch (error) {
      caught = error;
    }

    expect(
      isCheckViolation(caught, "check_result_reachable_has_no_failure_mode"),
    ).toBe(true);
  });

  describe("listServerCheckTargets", () => {
    it("names every enrolled server, with its event and its last check", async () => {
      const { enrolment, system, event } = await scene();
      await insertCheckResult(
        db,
        success(enrolment.id, new Date("2026-09-15T12:04:00.000Z")),
      );

      const targets = await listServerCheckTargets(db);
      const target = targets.find((row) => row.enrolmentId === enrolment.id);

      expect(target).toBeDefined();
      expect(target?.systemId).toBe(system.id);
      expect(target?.systemName).toBe(system.name);
      expect(target?.eventSlug).toBe(event.slug);
      expect(target?.eventStatus).toBe("open");
      expect(target?.serverProfile.fhirBaseUrl).toBe(
        "https://fhir.muster.test/r4",
      );
      expect(target?.lastCheckedAt?.toISOString()).toBe(
        "2026-09-15T12:04:00.000Z",
      );
    });

    it("reports no last check for a server nobody has checked", async () => {
      const { enrolment } = await scene();

      const targets = await listServerCheckTargets(db);

      expect(
        targets.find((row) => row.enrolmentId === enrolment.id)?.lastCheckedAt,
      ).toBeNull();
    });

    it("omits an enrolment whose system is only a client", async () => {
      // `data-model.md`: checks are for server enrolments. A client has no base URL to
      // fetch, and a target list that included one would produce a permanent failure row
      // against an entry that is perfectly correct.
      const owner = await makeAccount(db);
      const organisation = await makeOrganisation(db, owner.id);
      const event = await makeEvent(db, { status: "open" });
      const clientOnly = await makeSystem(db, organisation.id, {
        name: `Client ${uniqueSuffix()}`,
        serverProfile: null,
        clientProfile: clientProfileFixture(),
      });
      const enrolment = await makeEnrolment(db, {
        event,
        systemId: clientOnly.id,
        accountId: owner.id,
      });

      const targets = await listServerCheckTargets(db);

      expect(targets.some((row) => row.enrolmentId === enrolment.id)).toBe(
        false,
      );
    });

    it("names a system that is both a server and a client", async () => {
      const owner = await makeAccount(db);
      const organisation = await makeOrganisation(db, owner.id);
      const event = await makeEvent(db, { status: "open" });
      const both = await makeSystem(db, organisation.id, {
        serverProfile: serverProfileFixture(),
        clientProfile: clientProfileFixture(),
      });
      const enrolment = await makeEnrolment(db, {
        event,
        systemId: both.id,
        accountId: owner.id,
      });

      const targets = await listServerCheckTargets(db);

      expect(targets.some((row) => row.enrolmentId === enrolment.id)).toBe(
        true,
      );
    });
  });
});
