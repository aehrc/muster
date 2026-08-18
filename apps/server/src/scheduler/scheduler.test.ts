import {
  findCheckStatus,
  insertEnrolment,
  insertEvent,
  insertOrganisation,
  insertSystem,
} from "@muster/db";
import { describeDatabase, uniqueName } from "@muster/db/test/harness";
import { afterAll, beforeAll, expect, test } from "bun:test";

import { createScheduler } from "./scheduler.ts";
import { signUpAndSignIn, startTestServer } from "../test/support.ts";

import type { Scheduler, SchedulerDependencies } from "./scheduler.ts";
import type { TestServer } from "../test/support.ts";
import type { EventStatus, ServerProfile } from "@muster/contracts";
import type { CheckStatusRow } from "@muster/db";

/**
 * The check scheduler, with an injected clock and an injected fetch.
 *
 * The scheduler is the one part of Muster that acts without anybody asking, so
 * what it does and does not do is worth pinning down precisely. Four properties
 * are load-bearing. The cadence follows the event's status, so an open event's
 * entries are checked within the fifteen minutes SC-004 promises and last year's
 * are not re-checked every quarter of an hour. Results are persisted, so a
 * restart loses nothing - a second scheduler over the same rows makes the same
 * decisions. One target is checked once at a time, so a slow server cannot
 * accumulate overlapping probes. And a guarded address is recorded as a refusal
 * with its reason, with no request made (FR-020).
 *
 * The fetch is injected and so is the resolver, so the SSRF guard runs for real
 * against addresses the test chooses rather than being stubbed out.
 */

describeDatabase("the check scheduler", () => {
  let server: TestServer;
  let accountId: string;
  let organisationId: string;

  beforeAll(async () => {
    server = await startTestServer("scheduler");
    const member = await signUpAndSignIn(
      server,
      `${uniqueName("member")}@example.org`,
    );
    accountId = member.id;
    const organisation = await insertOrganisation(server.database.sql, {
      name: "MediRecords",
    });
    organisationId = organisation.id;
  });

  afterAll(async () => {
    await server.close();
  });

  /** The SMART configuration the stand-in server answers with. */
  const configurationDocument = {
    issuer: "https://auth.example.org",
    authorization_endpoint: "https://auth.example.org/authorize",
    token_endpoint: "https://auth.example.org/token",
    scopes_supported: ["launch", "patient/Patient.rs"],
    capabilities: ["launch-standalone"],
  };

  /** The capability statement the stand-in server answers with. */
  const capabilityStatement = {
    resourceType: "CapabilityStatement",
    status: "active",
    fhirVersion: "4.0.1",
    software: { name: "Example FHIR", version: "3.2.1" },
    rest: [{ mode: "server", resource: [{ type: "Patient" }] }],
  };

  /** What a stand-in server does with one request. */
  type Handler = () => Promise<Response>;

  /** A recording fetch, and the calls it has seen. */
  type RecordedFetch = {
    /** the fetch to inject */
    readonly fetchImplementation: (
      url: string,
      init: RequestInit,
    ) => Promise<Response>;
    /** every URL asked for, in order */
    readonly calls: string[];
  };

  // Answers a JSON document, as a conformant server would.
  const jsonResponse = (body: unknown): Promise<Response> =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        headers: { "content-type": "application/json" },
      }),
    );

  // Builds a fetch that answers from a routing table and records what it saw.
  const recordFetch = (routes: Record<string, Handler>): RecordedFetch => {
    const calls: string[] = [];
    return {
      calls,
      fetchImplementation: async (url) => {
        calls.push(url);
        const handler = routes[url];
        if (handler === undefined) {
          return new Response("not found", { status: 404 });
        }
        return handler();
      },
    };
  };

  // Resolves every host to a public address, except the ones named internal,
  // which resolve into a private range so the guard has something to refuse.
  const resolve = (host: string): Promise<readonly string[]> =>
    Promise.resolve(
      host.startsWith("internal.") ? ["10.1.2.3"] : ["203.0.113.10"],
    );

  // The two probes for one base URL.
  const probesFor = (
    fhirBaseUrl: string,
  ): { readonly discovery: string; readonly capability: string } => ({
    discovery: `${fhirBaseUrl}/.well-known/smart-configuration`,
    capability: `${fhirBaseUrl}/metadata`,
  });

  // A conformant stand-in server at one base URL.
  const conformantRoutes = (fhirBaseUrl: string): Record<string, Handler> => {
    const probes = probesFor(fhirBaseUrl);
    return {
      [probes.discovery]: () => jsonResponse(configurationDocument),
      [probes.capability]: () => jsonResponse(capabilityStatement),
    };
  };

  // A scheduler built over the suite's database, with a fixed clock.
  const schedulerAt = (
    at: Date,
    overrides: Partial<SchedulerDependencies> = {},
  ): Scheduler =>
    createScheduler({
      sql: server.database.sql,
      config: server.config,
      now: () => at,
      resolve,
      log: () => undefined,
      ...overrides,
    });

  // Arranges an enrolled server in an event of the given status.
  const arrangeTarget = async (
    name: string,
    serverProfile: unknown,
    status: EventStatus = "open",
  ): Promise<string> => {
    const event = await insertEvent(server.database.sql, {
      slug: uniqueName("event").replaceAll("_", "-"),
      name: "Sparked connectathon",
      startsOn: "2026-09-01",
      endsOn: "2026-09-03",
      status,
      capabilityTags: [],
      graceDays: 7,
    });
    const system = await insertSystem(server.database.sql, {
      organisationId,
      name,
      description: "A FHIR server.",
      serverProfile,
      clientProfile: null,
    });
    const enrolment = await insertEnrolment(server.database.sql, {
      eventId: event.id,
      systemId: system.id,
      tags: [],
      confirmedBy: accountId,
    });
    return enrolment.id;
  };

  // A declared profile, with whatever the caller wants to differ.
  const profile = (
    fhirBaseUrl: string,
    overrides: Partial<ServerProfile> = {},
  ): unknown => ({
    fhirBaseUrl,
    authorizationMode: "smart",
    registrationMode: "manual",
    notes: "",
    ...overrides,
  });

  // Reads one enrolment's status, failing the test when there is none.
  const statusOf = async (enrolmentId: string): Promise<CheckStatusRow> => {
    const status = await findCheckStatus(server.database.sql, enrolmentId);
    if (status === undefined) {
      throw new Error(`Nothing checked ${enrolmentId}`);
    }
    return status;
  };

  /** An arbitrary instant every test measures from. */
  const startedAt = new Date("2026-08-19T02:00:00.000Z");

  /** Fifteen minutes, in milliseconds. */
  const fifteenMinutes = 15 * 60 * 1000;

  // Acceptance scenario 1: the check records the time, the highlights and a
  // reachable status, and it does so by fetching the two documents.
  test("records a reachable check with what the server advertises", async () => {
    const fhirBaseUrl = "https://reachable.example.org/fhir";
    const enrolmentId = await arrangeTarget("Reachable", profile(fhirBaseUrl));
    const recorded = recordFetch(conformantRoutes(fhirBaseUrl));

    const summary = await schedulerAt(startedAt, {
      fetchImplementation: recorded.fetchImplementation,
    }).runDueChecks();

    expect(summary.checked).toContain(enrolmentId);
    const probes = probesFor(fhirBaseUrl);
    expect(recorded.calls).toContain(probes.discovery);
    expect(recorded.calls).toContain(probes.capability);

    const status = await statusOf(enrolmentId);
    expect(status.latest.reachable).toBe(true);
    expect(status.latest.checkedAt).toEqual(startedAt);
    expect(status.latest.failureMode).toBeNull();
    expect(status.latest.discovery).toMatchObject({
      tokenEndpoint: "https://auth.example.org/token",
      scopesSupported: ["launch", "patient/Patient.rs"],
    });
    expect(status.latest.capability).toMatchObject({
      fhirVersion: "4.0.1",
      software: "Example FHIR 3.2.1",
    });
    expect(status.lastSuccessAt).toEqual(startedAt);
  });

  // Acceptance scenario 3: the drift is recorded, naming both values.
  test("records the drift between a declared and an advertised endpoint", async () => {
    const fhirBaseUrl = "https://drifted.example.org/fhir";
    const enrolmentId = await arrangeTarget(
      "Drifted",
      profile(fhirBaseUrl, {
        tokenEndpoint: "https://auth.example.org/oauth/token",
      }),
    );
    const recorded = recordFetch(conformantRoutes(fhirBaseUrl));

    await schedulerAt(startedAt, {
      fetchImplementation: recorded.fetchImplementation,
    }).runDueChecks();

    expect((await statusOf(enrolmentId)).latest.driftFlags).toEqual([
      {
        field: "tokenEndpoint",
        declared: "https://auth.example.org/oauth/token",
        advertised: "https://auth.example.org/token",
      },
    ]);
  });

  // Acceptance scenario 5 and FR-020: the guard refuses the target, the entry is
  // flagged with the reason, and no request is made.
  test("records a guarded address as a refusal without making a request", async () => {
    const fhirBaseUrl = "https://internal.example.org/fhir";
    const enrolmentId = await arrangeTarget("Internal", profile(fhirBaseUrl));
    const recorded = recordFetch(conformantRoutes(fhirBaseUrl));

    await schedulerAt(startedAt, {
      fetchImplementation: recorded.fetchImplementation,
    }).runDueChecks();

    const status = await statusOf(enrolmentId);
    expect(status.latest.reachable).toBe(false);
    expect(status.latest.failureMode).toBe("guarded");
    expect(status.latest.detail).toContain("10.1.2.3");
    expect(status.latest.detail).toContain("private address");
    expect(status.lastSuccessAt).toBeNull();
    // Nothing left Muster: the refusal happened before any request.
    expect(recorded.calls).toEqual([]);
  });

  // The distinction the specification insists on: a slow server is a timeout,
  // and a closed connection is a refusal, and they are not the same row.
  test("records a slow server as a timeout and a closed one as refused", async () => {
    const slowUrl = "https://slow.example.org/fhir";
    const closedUrl = "https://closed.example.org/fhir";
    const slow = await arrangeTarget("Slow", profile(slowUrl));
    const closed = await arrangeTarget("Closed", profile(closedUrl));
    const timeout = (): Promise<Response> => {
      const cause = new Error("The operation timed out");
      cause.name = "TimeoutError";
      return Promise.reject(cause);
    };
    const recorded = recordFetch({
      ...Object.fromEntries(
        Object.values(probesFor(slowUrl)).map((url) => [url, timeout]),
      ),
      ...Object.fromEntries(
        Object.values(probesFor(closedUrl)).map((url) => [
          url,
          () => Promise.reject(new Error("Unable to connect")),
        ]),
      ),
    });

    await schedulerAt(startedAt, {
      fetchImplementation: recorded.fetchImplementation,
    }).runDueChecks();

    expect((await statusOf(slow)).latest.failureMode).toBe("timeout");
    expect((await statusOf(closed)).latest.failureMode).toBe("refused");
  });

  // A server that answers, but not with the documents: reached, and not usable.
  test("records an unreadable answer as invalid", async () => {
    const fhirBaseUrl = "https://chatty.example.org/fhir";
    const enrolmentId = await arrangeTarget("Chatty", profile(fhirBaseUrl));
    const probes = probesFor(fhirBaseUrl);
    const recorded = recordFetch({
      [probes.discovery]: () => jsonResponse({ hello: "world" }),
      [probes.capability]: () =>
        Promise.resolve(new Response("<html>hello</html>")),
    });

    await schedulerAt(startedAt, {
      fetchImplementation: recorded.fetchImplementation,
    }).runDueChecks();

    const status = await statusOf(enrolmentId);
    expect(status.latest.reachable).toBe(false);
    expect(status.latest.failureMode).toBe("invalid");
    expect(status.latest.detail).not.toBeNull();
  });

  // A stored profile that does not satisfy the contract is a flagged entry, not
  // a silently skipped one: the reader is told the entry cannot be checked.
  test("flags an entry whose declared profile cannot be read", async () => {
    const enrolmentId = await arrangeTarget("Malformed", {
      fhirBaseUrl: "not a URL at all",
    });
    const recorded = recordFetch({});

    await schedulerAt(startedAt, {
      fetchImplementation: recorded.fetchImplementation,
    }).runDueChecks();

    const status = await statusOf(enrolmentId);
    expect(status.latest.reachable).toBe(false);
    expect(status.latest.failureMode).toBe("invalid");
    expect(recorded.calls).toEqual([]);
  });

  // SC-004 as a cadence: not again a minute later, and again within fifteen
  // minutes, for a target in an open event.
  test("checks an open event's target again within fifteen minutes", async () => {
    const fhirBaseUrl = "https://cadenced.example.org/fhir";
    const enrolmentId = await arrangeTarget("Cadenced", profile(fhirBaseUrl));
    const recorded = recordFetch(conformantRoutes(fhirBaseUrl));
    const runAt = async (at: Date): Promise<readonly string[]> =>
      (
        await schedulerAt(at, {
          fetchImplementation: recorded.fetchImplementation,
        }).runDueChecks()
      ).checked;

    expect(await runAt(startedAt)).toContain(enrolmentId);
    expect(await runAt(new Date(startedAt.getTime() + 60_000))).not.toContain(
      enrolmentId,
    );
    expect(
      await runAt(new Date(startedAt.getTime() + fifteenMinutes)),
    ).toContain(enrolmentId);
  });

  // And the other cadence: a closed event's entry waits a day.
  test("leaves a closed event's target alone for a day", async () => {
    const fhirBaseUrl = "https://retired.example.org/fhir";
    const enrolmentId = await arrangeTarget(
      "Retired",
      profile(fhirBaseUrl),
      "closed",
    );
    const recorded = recordFetch(conformantRoutes(fhirBaseUrl));
    const runAt = async (at: Date): Promise<readonly string[]> =>
      (
        await schedulerAt(at, {
          fetchImplementation: recorded.fetchImplementation,
        }).runDueChecks()
      ).checked;

    expect(await runAt(startedAt)).toContain(enrolmentId);
    expect(
      await runAt(new Date(startedAt.getTime() + fifteenMinutes)),
    ).not.toContain(enrolmentId);
    expect(
      await runAt(new Date(startedAt.getTime() + 24 * 60 * 60 * 1000)),
    ).toContain(enrolmentId);
  });

  // Persistence rather than memory: a second scheduler, as a restart would build
  // it, reads the same rows and reaches the same decision.
  test("loses nothing across a restart", async () => {
    const fhirBaseUrl = "https://restarted.example.org/fhir";
    const enrolmentId = await arrangeTarget("Restarted", profile(fhirBaseUrl));
    const recorded = recordFetch(conformantRoutes(fhirBaseUrl));

    await schedulerAt(startedAt, {
      fetchImplementation: recorded.fetchImplementation,
    }).runDueChecks();
    const afterRestart = await schedulerAt(
      new Date(startedAt.getTime() + 60_000),
      { fetchImplementation: recorded.fetchImplementation },
    ).runDueChecks();

    expect(afterRestart.skipped).toContain(enrolmentId);
    expect(afterRestart.checked).not.toContain(enrolmentId);
  });

  // Single-flight: a target already being checked is skipped rather than probed
  // a second time, so a slow server cannot accumulate overlapping requests.
  test("checks one target once when two passes overlap", async () => {
    const fhirBaseUrl = "https://blocking.example.org/fhir";
    const enrolmentId = await arrangeTarget("Blocking", profile(fhirBaseUrl));
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const probes = probesFor(fhirBaseUrl);
    const recorded = recordFetch({
      [probes.discovery]: async () => {
        await gate;
        return jsonResponse(configurationDocument);
      },
      [probes.capability]: () => jsonResponse(capabilityStatement),
    });
    const scheduler = schedulerAt(startedAt, {
      fetchImplementation: recorded.fetchImplementation,
    });

    const firstPass = scheduler.runDueChecks();
    await Bun.sleep(20);
    const secondPass = await scheduler.runDueChecks();
    release();
    const firstSummary = await firstPass;

    expect(secondPass.skipped).toContain(enrolmentId);
    expect(secondPass.checked).not.toContain(enrolmentId);
    expect(firstSummary.checked).toContain(enrolmentId);
    expect(
      recorded.calls.filter((url) => url === probes.discovery),
    ).toHaveLength(1);
  });

  // The interval is what makes it a scheduler rather than a route: it runs
  // without anybody asking, and it stops when it is told to. The clock advances
  // a cadence per pass, so each tick finds the target due and probes it again -
  // which is what makes the count evidence of ticking rather than of one pass.
  test("runs passes on an interval until it is stopped", async () => {
    const fhirBaseUrl = "https://ticking.example.org/fhir";
    await arrangeTarget("Ticking", profile(fhirBaseUrl));
    const recorded = recordFetch(conformantRoutes(fhirBaseUrl));
    let passes = 0;
    const scheduler = schedulerAt(startedAt, {
      fetchImplementation: recorded.fetchImplementation,
      now: () => {
        passes += 1;
        return new Date(startedAt.getTime() + passes * fifteenMinutes);
      },
      tickIntervalMs: 5,
    });

    scheduler.start();
    await Bun.sleep(80);
    const whileTicking = recorded.calls.length;
    // Stopping clears the interval; it does not abort the pass already running,
    // so the count is read again once that pass has had time to finish.
    scheduler.stop();
    await Bun.sleep(80);
    const afterStopping = recorded.calls.length;
    await Bun.sleep(80);

    // Two probes per pass, and more than one pass ran.
    expect(whileTicking).toBeGreaterThan(2);
    expect(recorded.calls).toHaveLength(afterStopping);
  });
});
