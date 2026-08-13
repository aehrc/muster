/**
 * The check scheduler: what it decides to check, and what it records.
 *
 * The constitution forbids queues, workers and background services, so this is an interval
 * inside the one server instance. That makes four things worth asserting, and none of them
 * needs real time or a real network - the clock, the transport and the target list are all
 * injected.
 *
 * **Cadence.** SC-004 requires an unreachable server to be flagged within one check
 * interval, and puts that interval at fifteen minutes or less during an event. A draft
 * event nobody has opened, and a closed one whose participants have gone home, do not
 * deserve the same attention.
 *
 * **Jitter.** Every target of an event that opened at once would otherwise become due at
 * once, for ever, and a directory that fired twenty simultaneous requests every quarter of
 * an hour would be indistinguishable from something worth blocking.
 *
 * **Single flight.** A pass that takes longer than the interval overlaps the next one. Two
 * checks against one server at once would double the load Muster puts on somebody else's
 * test server and race to write two rows for one observation.
 *
 * **Persistence, including the refusals.** The transport is injected as the *low-level*
 * fetch that `outboundFetch` calls, not as a replacement for it - so every case here runs
 * through the real guard (constitution principle III). That is what lets the guarded case
 * assert the thing scenario 5 actually asks for: no request left the process.
 *
 * The target list is injected too, narrowed to the enrolments each case created. The test
 * database is shared with every other suite in the run, and a pass over all of it would
 * write check rows against their fixtures.
 *
 * Skipped unless `MUSTER_TEST_DATABASE_URL` names a throwaway database, because a pass
 * records what it found. CI provides one, so a skip there is a workflow failure.
 *
 * Author: John Grimes
 */

import {
  findCheckStatus,
  hasTestDatabase,
  listCheckHistory,
  listServerCheckTargets,
  makeAccount,
  makeEnrolment,
  makeEvent,
  makeOrganisation,
  makeSystem,
  openTestDatabase,
  serverProfileFixture,
  uniqueSuffix,
} from "@muster/db";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import {
  CHECK_JITTER_FRACTION,
  checkCadence,
  checkIntervalMs,
  createCheckRunner,
  DEFAULT_OPEN_CHECK_INTERVAL_MS,
  isCheckDue,
  startCheckScheduler,
} from "./scheduler.js";

import type { CheckRunnerOptions } from "./scheduler.js";
import type { OutboundFetchImpl } from "../outbound/outboundFetch.js";
import type { Database, DatabaseHandle, EnrolmentRow } from "@muster/db";

/** The cadence every case here reasons about. */
const CADENCE = checkCadence(DEFAULT_OPEN_CHECK_INTERVAL_MS);

/** A minute, in milliseconds. */
const MINUTE = 60_000;

/** The smart-configuration the fixture transport serves. */
const SMART_CONFIGURATION = {
  issuer: "https://fhir.muster.test",
  authorization_endpoint: "https://fhir.muster.test/auth/authorize",
  token_endpoint: "https://fhir.muster.test/auth/token",
  scopes_supported: ["launch", "openid", "fhirUser"],
  capabilities: ["launch-standalone"],
  grant_types_supported: ["authorization_code"],
  smart_permission_ticket_types_supported: ["patient-self-access"],
  code_challenge_methods_supported: ["S256"],
};

/** The CapabilityStatement the fixture transport serves. */
const CAPABILITY_STATEMENT = {
  resourceType: "CapabilityStatement",
  status: "active",
  kind: "instance",
  fhirVersion: "4.0.1",
  software: { name: "Fixture FHIR", version: "1.0.0" },
  rest: [{ mode: "server", resource: [{ type: "Patient" }] }],
};

/** A publicly routable address, so the guard admits the fixture host. */
const PUBLIC_ADDRESS = "93.184.216.34";

describe("checkIntervalMs", () => {
  it("checks an open event's servers at least every fifteen minutes (SC-004)", () => {
    // The success criterion is the number: an unreachable server is visibly flagged
    // within one check interval, fifteen minutes or less during an event.
    expect(checkIntervalMs("open", CADENCE)).toBeLessThanOrEqual(15 * MINUTE);
  });

  it("follows the configured interval for an open event", () => {
    expect(checkIntervalMs("open", checkCadence(5 * MINUTE))).toBe(5 * MINUTE);
  });

  it("checks a draft event's servers much less often", () => {
    // A draft is an event an admin is still assembling. Its entries are worth verifying
    // before it opens, and not every quarter of an hour.
    expect(checkIntervalMs("draft", CADENCE)).toBeGreaterThan(
      checkIntervalMs("open", CADENCE),
    );
  });

  it("checks a closed event's servers least often of all", () => {
    // Closed takes nothing new and its records stay readable, so re-checking changes
    // little - but FR-017 says every enrolled server, so it is not abandoned either.
    expect(checkIntervalMs("closed", CADENCE)).toBeGreaterThan(
      checkIntervalMs("draft", CADENCE),
    );
  });
});

describe("isCheckDue", () => {
  const now = new Date("2026-09-15T12:00:00.000Z");

  /** A target of an open event, last checked this many milliseconds before `now`. */
  function target(agoMs: number | null) {
    return {
      eventStatus: "open" as const,
      lastCheckedAt: agoMs === null ? null : new Date(now.getTime() - agoMs),
    };
  }

  it("checks a server nobody has ever checked immediately", () => {
    // Whatever the jitter says. A newly enrolled server showing "not checked yet" for
    // a quarter of an hour is the staleness this story exists to remove.
    expect(isCheckDue(target(null), now, CADENCE, () => 0.99)).toBe(true);
  });

  it("waits at least one interval", () => {
    expect(isCheckDue(target(14 * MINUTE), now, CADENCE, () => 0)).toBe(false);
    expect(isCheckDue(target(15 * MINUTE), now, CADENCE, () => 0)).toBe(true);
  });

  it("spreads the due times with jitter drawn from the injected source", () => {
    // The same target is due at one interval with no jitter and not yet with jitter, so
    // twenty targets enrolled in the same minute stop being due in the same minute.
    const justOverdue = target(15 * MINUTE);

    expect(isCheckDue(justOverdue, now, CADENCE, () => 0)).toBe(true);
    expect(isCheckDue(justOverdue, now, CADENCE, () => 0.9)).toBe(false);
  });

  it("never delays a check by more than the jitter fraction", () => {
    // Otherwise the jitter could push a target past SC-004's fifteen minutes, which is
    // why the configured interval is the floor and the fraction is small.
    const atCeiling = target(
      DEFAULT_OPEN_CHECK_INTERVAL_MS * (1 + CHECK_JITTER_FRACTION),
    );

    for (const draw of [0, 0.25, 0.5, 0.75, 0.999]) {
      expect(isCheckDue(atCeiling, now, CADENCE, () => draw)).toBe(true);
    }
  });

  it("holds a draft event's server back for its own interval", () => {
    const draft = {
      eventStatus: "draft" as const,
      lastCheckedAt: new Date(now.getTime() - 30 * MINUTE),
    };

    expect(isCheckDue(draft, now, CADENCE, () => 0)).toBe(false);
  });
});

describe.skipIf(!hasTestDatabase())("a check pass", () => {
  let handle: DatabaseHandle;
  let db: Database;

  beforeAll(async () => {
    handle = (await openTestDatabase())!;
    db = handle.db;
  });

  afterAll(async () => {
    await handle.close();
  });

  /** A server enrolled in an open event, on a host of its own. */
  async function enrolServer(
    overrides: {
      readonly fhirBaseUrl?: string;
      readonly tokenEndpoint?: string | null;
    } = {},
  ): Promise<{ readonly enrolment: EnrolmentRow; readonly host: string }> {
    const host = `fhir-${uniqueSuffix()}.muster.test`;
    const owner = await makeAccount(db);
    const organisation = await makeOrganisation(db, owner.id);
    const event = await makeEvent(db, { status: "open" });
    const system = await makeSystem(db, organisation.id, {
      serverProfile: serverProfileFixture({
        fhirBaseUrl: overrides.fhirBaseUrl ?? `https://${host}/r4`,
        ...(overrides.tokenEndpoint === undefined
          ? {}
          : { tokenEndpoint: overrides.tokenEndpoint }),
      }),
    });
    const enrolment = await makeEnrolment(db, {
      event,
      systemId: system.id,
      accountId: owner.id,
    });
    return { enrolment, host };
  }

  /** A transport, and every URL it was asked for. */
  interface Transport {
    readonly fetchImpl: OutboundFetchImpl;
    readonly requested: string[];
  }

  /** A transport that answers both well-known documents. */
  function serving(): Transport {
    const requested: string[] = [];
    return {
      requested,
      fetchImpl: async (input) => {
        requested.push(input.href);
        await Promise.resolve();
        if (input.href.endsWith("/.well-known/smart-configuration")) {
          return Response.json(SMART_CONFIGURATION);
        }
        if (input.href.endsWith("/metadata")) {
          return Response.json(CAPABILITY_STATEMENT);
        }
        return new Response("not found", { status: 404 });
      },
    };
  }

  /** A transport that never answers, in the way `fetch` reports each failure. */
  function failing(kind: "timeout" | "refused"): Transport {
    const requested: string[] = [];
    return {
      requested,
      fetchImpl: async (input) => {
        requested.push(input.href);
        await Promise.resolve();
        if (kind === "timeout") {
          const error = new Error("The operation timed out.");
          error.name = "TimeoutError";
          throw error;
        }
        throw new TypeError("fetch failed");
      },
    };
  }

  /** A target list narrowed to the enrolments a case created. */
  function only(...enrolmentIds: readonly string[]) {
    const wanted = new Set(enrolmentIds);
    return async (executor: Database) =>
      (await listServerCheckTargets(executor)).filter((target) =>
        wanted.has(target.enrolmentId),
      );
  }

  /** A runner over one transport, with everything else pinned. */
  function runnerFor(
    transport: Transport,
    enrolmentIds: readonly string[],
    overrides: Partial<CheckRunnerOptions> = {},
  ) {
    return createCheckRunner({
      db,
      clock: () => new Date("2026-09-15T12:04:00.000Z"),
      fetchImpl: transport.fetchImpl,
      // Injected so no case here touches DNS. The fixture host resolves to a publicly
      // routable address, which is what lets the guard admit it.
      resolve: async () => {
        await Promise.resolve();
        return [PUBLIC_ADDRESS];
      },
      random: () => 0,
      listTargets: only(...enrolmentIds),
      ...overrides,
    });
  }

  it("fetches both well-known documents and records what it found (FR-017)", async () => {
    const { enrolment, host } = await enrolServer();
    const transport = serving();

    await runnerFor(transport, [enrolment.id]).runPass();

    // Both documents, per FR-017: the SMART configuration and the CapabilityStatement.
    expect(transport.requested).toEqual([
      `https://${host}/r4/.well-known/smart-configuration`,
      `https://${host}/r4/metadata`,
    ]);

    const status = await findCheckStatus(db, enrolment.id);
    expect(status?.latest.reachable).toBe(true);
    expect(status?.latest.failureMode).toBeNull();
    expect(status?.latest.checkedAt.toISOString()).toBe(
      "2026-09-15T12:04:00.000Z",
    );
    expect(status?.latest.discovery?.tokenEndpoint).toBe(
      "https://fhir.muster.test/auth/token",
    );
    expect(status?.latest.capability?.softwareName).toBe("Fixture FHIR");
  });

  it("records the ticket types a server advertises, for the playground to read", async () => {
    // FR-034, fed by these checks. Captured now so User Story 8 reads a recorded fact
    // rather than re-fetching every server when somebody opens the playground.
    const { enrolment } = await enrolServer();

    await runnerFor(serving(), [enrolment.id]).runPass();

    expect(
      (await findCheckStatus(db, enrolment.id))?.latest.discovery
        ?.permissionTicketTypesSupported,
    ).toEqual(["patient-self-access"]);
  });

  it("flags drift between a declared endpoint and the advertised one (FR-018)", async () => {
    const { enrolment } = await enrolServer({
      tokenEndpoint: "https://fhir.muster.test/oauth/token",
    });

    await runnerFor(serving(), [enrolment.id]).runPass();

    const status = await findCheckStatus(db, enrolment.id);
    expect(status?.latest.reachable).toBe(true);
    expect(status?.latest.driftFlags).toEqual([
      {
        field: "tokenEndpoint",
        declared: "https://fhir.muster.test/oauth/token",
        advertised: "https://fhir.muster.test/auth/token",
      },
    ]);
  });

  it("refuses a private address without making a request (scenario 5, FR-020)", async () => {
    // The whole of scenario 5's third step. `requested` is the proof: the guard is the
    // only path to the network, and it decided before the transport was called.
    const { enrolment } = await enrolServer({
      fhirBaseUrl: "https://10.4.1.9/fhir",
    });
    const transport = serving();

    await runnerFor(transport, [enrolment.id]).runPass();

    expect(transport.requested).toEqual([]);
    const status = await findCheckStatus(db, enrolment.id);
    expect(status?.latest.reachable).toBe(false);
    expect(status?.latest.failureMode).toBe("guarded");
    expect(status?.latest.detail).toContain("publicly routable");
  });

  it("records a slow server as a timeout, and a dead one as refused", async () => {
    // The spec's own edge case. Two enrolments, because the two answers must be
    // distinguishable on the page rather than collapsed into "unreachable".
    const slow = await enrolServer();
    await runnerFor(failing("timeout"), [slow.enrolment.id]).runPass();

    const dead = await enrolServer();
    await runnerFor(failing("refused"), [dead.enrolment.id]).runPass();

    expect(
      (await findCheckStatus(db, slow.enrolment.id))?.latest.failureMode,
    ).toBe("timeout");
    expect(
      (await findCheckStatus(db, dead.enrolment.id))?.latest.failureMode,
    ).toBe("refused");
  });

  it("adds a row rather than replacing the last one", async () => {
    // The history is retained (`data-model.md`), which is what lets an unreachable entry
    // show the time of the last successful check (scenario 2).
    const { enrolment } = await enrolServer();
    await runnerFor(serving(), [enrolment.id], {
      clock: () => new Date("2026-09-15T09:31:00.000Z"),
    }).runPass();
    await runnerFor(failing("refused"), [enrolment.id], {
      clock: () => new Date("2026-09-15T09:46:00.000Z"),
    }).runPass();

    const status = await findCheckStatus(db, enrolment.id);
    expect(await listCheckHistory(db, enrolment.id)).toHaveLength(2);
    expect(status?.latest.reachable).toBe(false);
    expect(status?.lastSuccessAt?.toISOString()).toBe(
      "2026-09-15T09:31:00.000Z",
    );
  });

  it("does not check a target that is not due", async () => {
    const { enrolment } = await enrolServer();
    await runnerFor(serving(), [enrolment.id], {
      clock: () => new Date("2026-09-15T12:04:00.000Z"),
    }).runPass();

    // A second pass a minute later, which is well inside the interval.
    const transport = serving();
    const summary = await runnerFor(transport, [enrolment.id], {
      clock: () => new Date("2026-09-15T12:05:00.000Z"),
    }).runPass();

    expect(transport.requested).toEqual([]);
    expect(summary.notDue).toBe(1);
    expect(summary.checked).toBe(0);
    expect(await listCheckHistory(db, enrolment.id)).toHaveLength(1);
  });

  it("runs one check per target however many passes overlap", async () => {
    // A pass that outlasts the interval overlaps the next. Without single flight, one
    // server gets two simultaneous checks and two rows for one observation.
    const { enrolment, host } = await enrolServer();
    const requested: string[] = [];
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const runner = createCheckRunner({
      db,
      clock: () => new Date("2026-09-15T12:04:00.000Z"),
      fetchImpl: async (input) => {
        requested.push(input.href);
        await held;
        return Response.json(SMART_CONFIGURATION);
      },
      resolve: async () => {
        await Promise.resolve();
        return [PUBLIC_ADDRESS];
      },
      random: () => 0,
      listTargets: only(enrolment.id),
    });

    const first = runner.runPass();
    const second = runner.runPass();
    release();
    const [firstSummary, secondSummary] = await Promise.all([first, second]);

    // Two documents for the one target, not four.
    expect(requested.filter((url) => url.includes(host))).toHaveLength(2);
    expect(firstSummary.checked + secondSummary.checked).toBe(1);
    expect(firstSummary.inFlight + secondSummary.inFlight).toBe(1);
    expect(await listCheckHistory(db, enrolment.id)).toHaveLength(1);
  });

  it("checks the rest of the targets when one of them is refused", async () => {
    // A pass is a loop over other people's servers. One target the guard refuses must
    // not cost the other nineteen their check.
    const guarded = await enrolServer({ fhirBaseUrl: "https://10.4.1.9/fhir" });
    const healthy = await enrolServer();

    const summary = await runnerFor(serving(), [
      guarded.enrolment.id,
      healthy.enrolment.id,
    ]).runPass();

    expect(summary.checked).toBe(2);
    expect(summary.reachable).toBe(1);
    expect(
      (await findCheckStatus(db, healthy.enrolment.id))?.latest.reachable,
    ).toBe(true);
  });

  it("counts what it did, so a startup log says something", async () => {
    // FR-037 read at the scale of a background pass: silence is not an acceptable
    // response to having run.
    const { enrolment } = await enrolServer();

    const summary = await runnerFor(serving(), [enrolment.id]).runPass();

    expect(summary).toEqual({
      targets: 1,
      checked: 1,
      notDue: 0,
      inFlight: 0,
      reachable: 1,
      errors: 0,
    });
  });
});

describe.skipIf(!hasTestDatabase())("startCheckScheduler", () => {
  let handle: DatabaseHandle;

  beforeAll(async () => {
    handle = (await openTestDatabase())!;
  });

  afterAll(async () => {
    await handle.close();
  });

  it("runs a pass immediately and exposes it, then stops cleanly", async () => {
    // Immediately, because a restart mid-event must not leave every entry stale for a
    // quarter of an hour; exposed, because the entry point logs what the first pass did.
    const scheduler = startCheckScheduler({
      db: handle.db,
      clock: () => new Date("2026-09-15T12:04:00.000Z"),
      // Nothing to check: this case is about the interval, and a pass over the shared
      // test database would write rows against every other suite's fixtures.
      listTargets: async () => {
        await Promise.resolve();
        return [];
      },
      passIntervalMs: 60_000,
    });

    const summary = await scheduler.firstPass;
    scheduler.stop();
    // Twice, because shutdown paths get called twice and a second clear must be a no-op.
    scheduler.stop();

    expect(summary.targets).toBe(0);
  });
});
