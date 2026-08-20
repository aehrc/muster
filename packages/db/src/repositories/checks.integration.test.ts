/*
 * Copyright © 2026 Commonwealth Scientific and Industrial Research Organisation
 * (CSIRO) ABN 41 687 119 230. Licensed under the Apache License, Version 2.0.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";

import {
  findCheckStatus,
  insertCheckResult,
  listCheckResults,
  listCheckStatuses,
  listCheckTargets,
} from "./checks.ts";
import {
  insertAccount,
  insertEnrolment,
  insertEvent,
  insertOrganisation,
  insertSystem,
} from "./directory.ts";
import { createMigratedSchema, uniqueName } from "../test/harness.ts";
import { describeDatabase } from "../test/harness.ts";

import type { NewCheckResult } from "./checks.ts";
import type { MigratedSchema } from "../test/harness.ts";

/**
 * The check table and its repositories against a real PostgreSQL.
 *
 * Two properties matter here and both are the reason the table exists. The
 * latest row per enrolment is what a badge is drawn from, and it must be the
 * latest by check time rather than by insertion order, because a check that was
 * recorded late must not overwrite the truth. And the history is kept: an entry
 * that has stopped answering can still say when it last did (acceptance
 * scenario 2), which a table that overwrote one row per server could not.
 */

describeDatabase("the check schema and repositories", () => {
  let database: MigratedSchema;
  let eventId: string;
  let accountId: string;
  let organisationId: string;

  beforeAll(async () => {
    database = await createMigratedSchema("checks");
    const account = await insertAccount(database.sql, {
      email: `${uniqueName("member")}@example.org`,
      displayName: "A member",
      passwordHash: "argon2id$stub",
    });
    accountId = account.id;
    const organisation = await insertOrganisation(database.sql, {
      name: "MediRecords",
    });
    organisationId = organisation.id;
    const event = await insertEvent(database.sql, {
      slug: uniqueName("event").replaceAll("_", "-"),
      name: "Sparked connectathon",
      startsOn: "2026-09-01",
      endsOn: "2026-09-03",
      status: "open",
      capabilityTags: [],
      graceDays: 7,
    });
    eventId = event.id;
  });

  afterAll(async () => {
    await database.close();
  });

  /** A server profile with both endpoints declared. */
  const serverProfile = {
    fhirBaseUrl: "https://fhir.example.org",
    authorizationMode: "smart",
    registrationMode: "manual",
    tokenEndpoint: "https://auth.example.org/token",
    notes: "",
  };

  // Arranges an enrolled server, returning its enrolment identifier.
  const arrangeServerEnrolment = async (name: string): Promise<string> => {
    const system = await insertSystem(database.sql, {
      organisationId,
      name,
      description: "A FHIR server.",
      serverProfile,
      clientProfile: null,
    });
    const enrolment = await insertEnrolment(database.sql, {
      eventId,
      systemId: system.id,
      tags: [],
      confirmedBy: accountId,
    });
    return enrolment.id;
  };

  // A reachable check of one enrolment.
  const reachableCheck = (
    enrolmentId: string,
    checkedAt: Date,
  ): NewCheckResult => ({
    enrolmentId,
    checkedAt,
    reachable: true,
    failureMode: null,
    detail: null,
    discovery: {
      issuer: "https://auth.example.org",
      authorizationEndpoint: "https://auth.example.org/authorize",
      tokenEndpoint: "https://auth.example.org/token",
      registrationEndpoint: null,
      scopesSupported: ["launch", "patient/Patient.rs"],
      capabilities: ["launch-standalone"],
    },
    capability: {
      fhirVersion: "4.0.1",
      software: "Example FHIR 3.2.1",
      implementationUrl: "https://fhir.example.org",
      securityServices: ["SMART-on-FHIR"],
      resourceTypes: ["Patient"],
    },
    driftFlags: [],
  });

  // Records the highlights and the disagreements as given, and reads them back
  // as they were written: the jsonb columns are the record, not a summary.
  test("records a reachable check with its highlights and reads it back", async () => {
    const enrolmentId = await arrangeServerEnrolment("Reachable Server");
    const checkedAt = new Date("2026-08-19T01:00:00.000Z");

    const recorded = await insertCheckResult(
      database.sql,
      reachableCheck(enrolmentId, checkedAt),
    );

    expect(recorded.enrolmentId).toBe(enrolmentId);
    expect(recorded.checkedAt).toEqual(checkedAt);
    expect(recorded.reachable).toBe(true);
    expect(recorded.failureMode).toBeNull();
    expect(recorded.discovery).toMatchObject({
      tokenEndpoint: "https://auth.example.org/token",
      scopesSupported: ["launch", "patient/Patient.rs"],
    });
    expect(recorded.capability).toMatchObject({ fhirVersion: "4.0.1" });
    expect(recorded.driftFlags).toEqual([]);
  });

  // FR-020: a guarded target is a recorded refusal naming its reason, not a gap.
  test("records a guarded refusal with the reason it names", async () => {
    const enrolmentId = await arrangeServerEnrolment("Internal Server");

    const recorded = await insertCheckResult(database.sql, {
      enrolmentId,
      checkedAt: new Date("2026-08-19T01:00:00.000Z"),
      reachable: false,
      failureMode: "guarded",
      detail:
        "fhir.internal.example.org resolves to 10.1.2.3, which is a private address",
      discovery: null,
      capability: null,
      driftFlags: [],
    });

    expect(recorded.reachable).toBe(false);
    expect(recorded.failureMode).toBe("guarded");
    expect(recorded.detail).toContain("which is a private address");
    expect(recorded.discovery).toBeNull();
    expect(recorded.capability).toBeNull();
  });

  // The badge is drawn from the latest check by check time, and the last
  // successful one is kept alongside it (acceptance scenario 2).
  test("answers the latest check and when the server was last reached", async () => {
    const enrolmentId = await arrangeServerEnrolment("Faltering Server");
    await insertCheckResult(
      database.sql,
      reachableCheck(enrolmentId, new Date("2026-08-19T01:00:00.000Z")),
    );
    await insertCheckResult(database.sql, {
      enrolmentId,
      checkedAt: new Date("2026-08-19T01:15:00.000Z"),
      reachable: false,
      failureMode: "timeout",
      detail: "fhir.example.org did not answer within 10000ms",
      discovery: null,
      capability: null,
      driftFlags: [],
    });

    const status = await findCheckStatus(database.sql, enrolmentId);

    expect(status?.latest.failureMode).toBe("timeout");
    expect(status?.latest.checkedAt).toEqual(
      new Date("2026-08-19T01:15:00.000Z"),
    );
    expect(status?.lastSuccessAt).toEqual(new Date("2026-08-19T01:00:00.000Z"));
  });

  // A check recorded out of order does not become the latest: the column that
  // matters is the check time, not the insertion order.
  test("prefers the newest check time over the insertion order", async () => {
    const enrolmentId = await arrangeServerEnrolment("Late Reporter");
    await insertCheckResult(
      database.sql,
      reachableCheck(enrolmentId, new Date("2026-08-19T02:00:00.000Z")),
    );
    await insertCheckResult(
      database.sql,
      reachableCheck(enrolmentId, new Date("2026-08-19T01:00:00.000Z")),
    );

    const status = await findCheckStatus(database.sql, enrolmentId);

    expect(status?.latest.checkedAt).toEqual(
      new Date("2026-08-19T02:00:00.000Z"),
    );
  });

  // Nothing has checked it: stated as an absence rather than as a false badge.
  test("answers nothing for an enrolment nothing has checked", async () => {
    const enrolmentId = await arrangeServerEnrolment("Unchecked Server");

    expect(await findCheckStatus(database.sql, enrolmentId)).toBeUndefined();
  });

  // History is retained, newest first, and capped by the caller rather than by
  // the query: the system detail shows a page of it, not everything ever.
  test("answers the history newest first, up to the limit asked for", async () => {
    const enrolmentId = await arrangeServerEnrolment("Long-lived Server");
    for (const minute of [0, 15, 30]) {
      await insertCheckResult(
        database.sql,
        reachableCheck(
          enrolmentId,
          new Date(`2026-08-19T03:${String(minute).padStart(2, "0")}:00.000Z`),
        ),
      );
    }

    const history = await listCheckResults(database.sql, {
      enrolmentId,
      limit: 2,
    });

    expect(history.map((check) => check.checkedAt)).toEqual([
      new Date("2026-08-19T03:30:00.000Z"),
      new Date("2026-08-19T03:15:00.000Z"),
    ]);
  });

  // The event view reads every entry's status in one query, and gets one row per
  // enrolment however many checks each has.
  test("answers one status per checked enrolment in an event", async () => {
    const first = await arrangeServerEnrolment("First Server");
    const second = await arrangeServerEnrolment("Second Server");
    await arrangeServerEnrolment("Never Checked Server");
    await insertCheckResult(
      database.sql,
      reachableCheck(first, new Date("2026-08-19T04:00:00.000Z")),
    );
    await insertCheckResult(
      database.sql,
      reachableCheck(first, new Date("2026-08-19T04:15:00.000Z")),
    );
    await insertCheckResult(
      database.sql,
      reachableCheck(second, new Date("2026-08-19T04:05:00.000Z")),
    );

    const statuses = await listCheckStatuses(database.sql, eventId);
    const forEnrolment = new Map(
      statuses.map((status) => [status.latest.enrolmentId, status]),
    );

    expect(forEnrolment.get(first)?.latest.checkedAt).toEqual(
      new Date("2026-08-19T04:15:00.000Z"),
    );
    expect(forEnrolment.get(second)?.latest.checkedAt).toEqual(
      new Date("2026-08-19T04:05:00.000Z"),
    );
    // One row per enrolment, not one per check.
    expect(
      statuses.filter((status) => status.latest.enrolmentId === first),
    ).toHaveLength(1);
  });

  // What the scheduler asks for: the server enrolments of events in the given
  // statuses, each with the declared profile and when it was last checked.
  test("lists the server enrolments of events in the given statuses", async () => {
    const enrolmentId = await arrangeServerEnrolment("Scheduled Server");
    const client = await insertSystem(database.sql, {
      organisationId,
      name: "Smart Forms",
      description: "A client.",
      serverProfile: null,
      clientProfile: {
        launchUrl: "https://smartforms.example.org/launch",
        redirectUris: ["https://smartforms.example.org/callback"],
        scopes: [],
        confidentiality: "public",
        launchContext: "",
        needsIntrospection: false,
      },
    });
    await insertEnrolment(database.sql, {
      eventId,
      systemId: client.id,
      tags: [],
      confirmedBy: accountId,
    });
    await insertCheckResult(
      database.sql,
      reachableCheck(enrolmentId, new Date("2026-08-19T05:00:00.000Z")),
    );

    const targets = await listCheckTargets(database.sql, ["open"]);
    const target = targets.find((one) => one.enrolmentId === enrolmentId);

    expect(target).toMatchObject({
      eventId,
      eventStatus: "open",
      systemName: "Scheduled Server",
    });
    expect(target?.serverProfile).toMatchObject({
      fhirBaseUrl: "https://fhir.example.org",
    });
    expect(target?.lastCheckedAt).toEqual(new Date("2026-08-19T05:00:00.000Z"));
    // A client has no address to check, so it is not a target.
    expect(targets.map((one) => one.systemId)).not.toContain(client.id);
  });

  // A closed event's entries are not checked on an open event's cadence, so the
  // status filter has to be the query's and not the caller's afterthought.
  test("excludes the enrolments of events in other statuses", async () => {
    const closed = await insertEvent(database.sql, {
      slug: uniqueName("closed").replaceAll("_", "-"),
      name: "Last year's connectathon",
      startsOn: "2025-12-01",
      endsOn: "2025-12-03",
      status: "closed",
      capabilityTags: [],
      graceDays: 7,
    });
    const system = await insertSystem(database.sql, {
      organisationId,
      name: "Retired Server",
      description: "A FHIR server.",
      serverProfile,
      clientProfile: null,
    });
    const enrolment = await insertEnrolment(database.sql, {
      eventId: closed.id,
      systemId: system.id,
      tags: [],
      confirmedBy: accountId,
    });

    expect(
      (await listCheckTargets(database.sql, ["open"])).map(
        (one) => one.enrolmentId,
      ),
    ).not.toContain(enrolment.id);
    expect(
      (await listCheckTargets(database.sql, ["closed"])).map(
        (one) => one.enrolmentId,
      ),
    ).toContain(enrolment.id);
  });
});
