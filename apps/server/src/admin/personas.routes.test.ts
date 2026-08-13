/**
 * Curating personas from the source server, and verifying who holds them.
 *
 * The counterparties here are four FHIR servers implemented inside this suite and reached
 * through an injected transport - which is the *low-level* fetch that `outboundFetch`
 * calls, not a replacement for it, so every case runs through the real SSRF guard
 * (constitution principle III). That is what lets the guarded case assert the thing
 * FR-020 actually asks for: no request left the process.
 *
 * The four are the coverage grid's whole vocabulary. A source server that holds the
 * curated patients and one patient without an IHI; a server that holds a persona; one that
 * answers an empty searchset; and one that demands authorization. FR-032 turns on the
 * difference between the last two, and a grid that could not tell them apart would send a
 * vendor looking for data they had already loaded.
 *
 * Four properties are asserted that no unit test can reach.
 *
 * **The source is fetched, not trusted.** Adding a persona sends only an identifier, and
 * the route reads the patient from the event's configured source itself - so a request body
 * asserting an IHI cannot put a persona in the set that the source does not support.
 *
 * **A pair is one row per observation.** Coverage is appended per (persona, enrolment) with
 * the time, and enrolled *servers* only: a client holds no patients, and a permanent
 * `missing` against one would be a failure recorded against an entry that is correct.
 *
 * **The grid is readable by anybody.** Scenario 5 and principle V: the persona page carries
 * test data by design. What it must not carry is a contact detail, which is asserted
 * against the response text rather than by inspecting the fields a projection happened to
 * include.
 *
 * **The scheduler runs it.** The constitution forbids a second background service, so
 * coverage is a pass of the one in-process scheduler.
 *
 * Skipped unless `MUSTER_TEST_DATABASE_URL` names a throwaway database. CI provides one, so
 * a skip there is a workflow failure.
 *
 * Author: John Grimes
 */

import {
  hasTestDatabase,
  listPersonaCoverageTargets,
  listPersonaSourceTargets,
  makeEnrolment,
  makeEvent,
  makeOrganisation,
  makeSystem,
  clientProfileFixture,
  serverProfileFixture,
  uniqueSuffix,
} from "@muster/db";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";

import { createCoverageRunner } from "../scheduler/coverage.js";
import { startCheckScheduler } from "../scheduler/scheduler.js";
import { apiJson, apiRequest } from "../test/api.js";
import { createTestStack, TEST_IHI_SYSTEM } from "../test/harness.js";

import type { OutboundFetchImpl } from "../outbound/outboundFetch.js";
import type { CoveragePassSummary } from "../scheduler/coverage.js";
import type { TestStack } from "../test/harness.js";
import type { EventPersonas, PersonaSearchResult } from "@muster/contracts";
import type { EnrolmentRow, EventRow } from "@muster/db";

/** Where the event's configured persona source lives. */
const SOURCE_URL = "https://source.example.org/fhir";

/** The quickstart's persona, and the one the coverage cases are about. */
const CHARLOTTE = {
  patientId: "charlotte-morris",
  name: "Charlotte Morris",
  birthDate: "1985-03-12",
  ihi: "8003608500314687",
} as const;

/** A patient on the source server that carries no IHI at all (scenario 2). */
const NOEL = { patientId: "noel-nobody", name: "Noel Nobody" } as const;

/** A patient resource carrying an IHI. */
function withIhi(
  patientId: string,
  name: string,
  birthDate: string,
  ihi: string,
) {
  const [given = "", family = ""] = name.split(" ", 2);
  return {
    resourceType: "Patient",
    id: patientId,
    identifier: [{ system: TEST_IHI_SYSTEM, value: ihi }],
    name: [{ family, given: [given] }],
    birthDate,
  };
}

/** A patient resource carrying a Medicare number and no IHI. */
function withoutIhi(patientId: string, name: string) {
  const [given = "", family = ""] = name.split(" ", 2);
  return {
    resourceType: "Patient",
    id: patientId,
    identifier: [
      {
        system: "http://ns.electronichealth.net.au/id/medicare-number",
        value: "32788511952",
      },
    ],
    name: [{ family, given: [given] }],
    birthDate: "1970-01-01",
  };
}

/** A searchset holding these resources. */
function searchset(resources: readonly unknown[]): unknown {
  return {
    resourceType: "Bundle",
    type: "searchset",
    total: resources.length,
    entry: resources.map((resource) => ({ resource })),
  };
}

/** How the fixture servers should behave for one case. */
interface FixtureBehaviour {
  /** Whether the source server still holds Charlotte (the FR-032 edge case). */
  readonly sourceHoldsCharlotte?: boolean;
  /** Whether the source server answers at all. */
  readonly sourceBroken?: boolean;
}

/** The fixture servers, and what they were asked. */
interface Fixtures {
  readonly requests: string[];
  behaviour: FixtureBehaviour;
  readonly fetchImpl: OutboundFetchImpl;
  readonly reset: (behaviour?: FixtureBehaviour) => void;
}

/**
 * Four FHIR servers: the source, a holder, an empty one, and one that demands a token.
 *
 * @returns The fixtures, and the record of every address they were asked for.
 */
function createFixtures(): Fixtures {
  const fixtures: Fixtures = {
    requests: [],
    behaviour: {},
    reset: (behaviour = {}) => {
      fixtures.behaviour = behaviour;
      fixtures.requests.length = 0;
    },
    fetchImpl: async (input) => await Promise.resolve(answer(input)),
  };

  /** The source server's answer to one address. */
  function fromSource(url: URL): Response {
    if (fixtures.behaviour.sourceBroken === true) {
      return Response.json(
        { resourceType: "OperationOutcome" },
        { status: 500 },
      );
    }
    if (url.pathname === "/fhir/Patient") {
      const identifier = url.searchParams.get("identifier");
      if (identifier !== null) {
        // The source being asked whether it still holds a curated persona.
        const holds =
          fixtures.behaviour.sourceHoldsCharlotte !== false &&
          identifier === `${TEST_IHI_SYSTEM}|${CHARLOTTE.ihi}`;
        return Response.json(
          searchset(
            holds
              ? [
                  withIhi(
                    CHARLOTTE.patientId,
                    CHARLOTTE.name,
                    CHARLOTTE.birthDate,
                    CHARLOTTE.ihi,
                  ),
                ]
              : [],
          ),
        );
      }
      // A name search: two eligible patients and one that carries no IHI.
      return Response.json(
        searchset([
          withIhi(
            CHARLOTTE.patientId,
            CHARLOTTE.name,
            CHARLOTTE.birthDate,
            CHARLOTTE.ihi,
          ),
          withoutIhi(NOEL.patientId, NOEL.name),
        ]),
      );
    }
    if (url.pathname === `/fhir/Patient/${CHARLOTTE.patientId}`) {
      return Response.json(
        withIhi(
          CHARLOTTE.patientId,
          CHARLOTTE.name,
          CHARLOTTE.birthDate,
          CHARLOTTE.ihi,
        ),
      );
    }
    if (url.pathname === `/fhir/Patient/${NOEL.patientId}`) {
      return Response.json(withoutIhi(NOEL.patientId, NOEL.name));
    }
    return Response.json({ resourceType: "OperationOutcome" }, { status: 404 });
  }

  /** Which server answered, and what it said. */
  function answer(input: URL): Response {
    const url = new URL(input);
    fixtures.requests.push(url.href);
    switch (url.hostname) {
      case "source.example.org": {
        return fromSource(url);
      }
      case "holder.example.org": {
        return Response.json(
          searchset([
            withIhi(
              "local-charlotte",
              CHARLOTTE.name,
              CHARLOTTE.birthDate,
              CHARLOTTE.ihi,
            ),
          ]),
        );
      }
      case "empty.example.org": {
        return Response.json(searchset([]));
      }
      case "locked.example.org": {
        // The case FR-032 singles out: a search that needs a token is not evidence of
        // absence.
        return Response.json(
          { resourceType: "OperationOutcome" },
          { status: 401 },
        );
      }
      default: {
        return Response.json(
          { resourceType: "OperationOutcome" },
          { status: 404 },
        );
      }
    }
  }

  return fixtures;
}

describe.skipIf(!hasTestDatabase())("the persona routes", () => {
  let stack: TestStack;
  const fixtures = createFixtures();

  /** The event every case curates personas for. */
  let event: EventRow;
  /** An ordinary approved member, for the authority cases. */
  let memberCookie: string;
  /** The admin's session, established after the clock is pinned so it is not already old. */
  let adminCookie: string;
  /** The enrolments the coverage pass is narrowed to. */
  let holder: EnrolmentRow;
  let empty: EnrolmentRow;
  let locked: EnrolmentRow;
  let clientEnrolment: EnrolmentRow;

  /** The time the whole suite reasons from. */
  const START = new Date("2026-09-15T02:04:00.000Z");

  beforeAll(async () => {
    stack = await createTestStack({
      outbound: {
        fetchImpl: async (input, init) => await fixtures.fetchImpl(input, init),
        // Every host resolves to a routable address, so what is under test is the guard's
        // own decisions rather than DNS.
        resolve: async () => await Promise.resolve(["93.184.216.34"]),
      },
    });
    stack.setNow(START);
    // After pinning the clock: the harness signs its admin in at its own start time, and a
    // session minted a fortnight before the moment this suite reasons from is one the
    // application would rightly refuse.
    adminCookie = await stack.signIn(stack.admin.email);

    event = await makeEvent(stack.db, {
      slug: `personas-${uniqueSuffix()}`,
      status: "open",
      personaSourceUrl: SOURCE_URL,
    });
    const member = await stack.makeMember();
    memberCookie = await stack.signIn(member.email);
    const organisation = await makeOrganisation(stack.db, member.id);

    /** Enrols a server whose FHIR base URL is one of the fixture hosts. */
    const enrolServer = async (
      name: string,
      fhirBaseUrl: string,
    ): Promise<EnrolmentRow> => {
      const system = await makeSystem(stack.db, organisation.id, {
        name,
        serverProfile: serverProfileFixture({ fhirBaseUrl }),
      });
      return await makeEnrolment(stack.db, {
        event,
        systemId: system.id,
        accountId: member.id,
      });
    };

    holder = await enrolServer("Holder FHIR", "https://holder.example.org/r4");
    empty = await enrolServer("Empty FHIR", "https://empty.example.org/r4");
    locked = await enrolServer("Locked FHIR", "https://locked.example.org/r4");

    const clientSystem = await makeSystem(stack.db, organisation.id, {
      name: "Smart Forms",
      serverProfile: null,
      clientProfile: clientProfileFixture(),
    });
    clientEnrolment = await makeEnrolment(stack.db, {
      event,
      systemId: clientSystem.id,
      accountId: member.id,
    });
  });

  afterAll(async () => {
    await stack.close();
  });

  beforeEach(() => {
    fixtures.reset();
    stack.setNow(START);
  });

  /** One event's personas, as anybody may read them. */
  async function readGrid(slug: string = event.slug): Promise<EventPersonas> {
    return await apiJson<EventPersonas>(
      stack,
      "GET",
      `/api/events/${slug}/personas`,
    );
  }

  /** Curates one patient from the source, as an admin. */
  async function addPersona(
    patientId: string,
    body: Readonly<Record<string, unknown>> = {},
    slug: string = event.slug,
  ): Promise<Response> {
    return await apiRequest(
      stack,
      "POST",
      `/api/admin/events/${slug}/personas`,
      {
        cookie: adminCookie,
        body: { patientId, ...body },
      },
    );
  }

  /**
   * A coverage runner narrowed to this suite's fixtures.
   *
   * Narrowed because the test database is shared with every other suite in the run, and a
   * pass over all of it would write coverage against their fixtures.
   */
  function runner(slug: string = event.slug): {
    readonly runPass: () => Promise<CoveragePassSummary>;
  } {
    const mine = new Set([holder.id, empty.id, locked.id, clientEnrolment.id]);
    return createCoverageRunner({
      db: stack.db,
      clock: () => stack.now(),
      ihiSystem: TEST_IHI_SYSTEM,
      outbound: {
        fetchImpl: async (input, init) => await fixtures.fetchImpl(input, init),
        resolve: async () => await Promise.resolve(["93.184.216.34"]),
      },
      listCoverageTargets: async (db) =>
        (await listPersonaCoverageTargets(db)).filter((target) =>
          mine.has(target.enrolmentId),
        ),
      listSourceTargets: async (db) =>
        (await listPersonaSourceTargets(db)).filter(
          (target) => target.eventSlug === slug,
        ),
    });
  }

  /** How many passes have run, so that each one happens at a time everything is due at. */
  let passes = 0;

  /**
   * Runs a pass at a time far enough ahead that every target is due again.
   *
   * A pair checked a moment ago is deliberately not re-checked - that is the cadence - so a
   * case about what a pass *records* has to move the clock past it first.
   */
  async function runPassNow(
    slug: string = event.slug,
  ): Promise<CoveragePassSummary> {
    passes += 1;
    // An hour per pass: comfortably past the check interval and its jitter, and nowhere
    // near the life of the session the admin cases hold.
    stack.setNow(new Date(START.getTime() + passes * 3_600_000));
    return await runner(slug).runPass();
  }

  /**
   * A fresh event with one curated persona and no enrolments.
   *
   * The source-standing cases each change a persona's flag, so each takes its own rather
   * than depending on the order the others ran in.
   */
  async function freshPersonaEvent(): Promise<string> {
    const created = await makeEvent(stack.db, {
      slug: `source-${uniqueSuffix()}`,
      status: "open",
      personaSourceUrl: SOURCE_URL,
    });
    await addPersona(CHARLOTTE.patientId, {}, created.slug);
    return created.slug;
  }

  describe("searching the source server", () => {
    it("proxies the search through the guard and returns the eligible patients", async () => {
      const result = await apiJson<PersonaSearchResult>(
        stack,
        "GET",
        `/api/admin/events/${event.slug}/persona-search?q=Morris`,
        { cookie: adminCookie },
      );

      expect(result.candidates.map((candidate) => candidate.ihi)).toEqual([
        CHARLOTTE.ihi,
      ]);
      expect(result.candidates[0]?.display).toEqual({
        name: CHARLOTTE.name,
        birthDate: CHARLOTTE.birthDate,
      });
      // The address asked for derives from the event's configured source, and carries the
      // admin's query.
      const asked = fixtures.requests.at(-1) ?? "";
      expect(asked.startsWith(`${SOURCE_URL}/Patient?`)).toBe(true);
      expect(asked).toContain("name=Morris");
    });

    it("states why a patient without an IHI is not eligible (FR-031, scenario 2)", async () => {
      const result = await apiJson<PersonaSearchResult>(
        stack,
        "GET",
        `/api/admin/events/${event.slug}/persona-search?q=Nobody`,
        { cookie: adminCookie },
      );

      // Not silently dropped: an admin who can see the patient on the source server has to
      // be told what is wrong with it.
      expect(result.ineligible.map((refused) => refused.reason)).toEqual([
        "no-ihi",
      ]);
      expect(result.ineligible[0]?.display.name).toBe(NOEL.name);
      expect(result.ineligible[0]?.detail).toContain(TEST_IHI_SYSTEM);
    });

    it("refuses an anonymous caller", async () => {
      const response = await apiRequest(
        stack,
        "GET",
        `/api/admin/events/${event.slug}/persona-search?q=Morris`,
      );

      expect(response.status).toBe(401);
    });

    it("refuses an approved member who is not an admin", async () => {
      const response = await apiRequest(
        stack,
        "GET",
        `/api/admin/events/${event.slug}/persona-search?q=Morris`,
        { cookie: memberCookie },
      );

      expect(response.status).toBe(403);
    });

    it("says so when the event names no source server", async () => {
      const sourceless = await makeEvent(stack.db, {
        slug: `sourceless-${uniqueSuffix()}`,
        personaSourceUrl: null,
      });

      const response = await apiRequest(
        stack,
        "GET",
        `/api/admin/events/${sourceless.slug}/persona-search?q=Morris`,
        { cookie: adminCookie },
      );

      expect(response.status).toBe(422);
      expect(await response.text()).toContain("source");
    });

    it("refuses a private source address without making a request (FR-020)", async () => {
      const internal = await makeEvent(stack.db, {
        slug: `internal-${uniqueSuffix()}`,
        personaSourceUrl: "https://10.1.2.3/fhir",
      });

      const response = await apiRequest(
        stack,
        "GET",
        `/api/admin/events/${internal.slug}/persona-search?q=Morris`,
        { cookie: adminCookie },
      );

      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ error: "guarded_address" });
      // The point of the guard: nothing was sent.
      expect(fixtures.requests).toEqual([]);
    });

    it("reports a source server that will not answer", async () => {
      fixtures.reset({ sourceBroken: true });

      const response = await apiRequest(
        stack,
        "GET",
        `/api/admin/events/${event.slug}/persona-search?q=Morris`,
        { cookie: adminCookie },
      );

      expect(response.status).toBe(502);
    });
  });

  describe("curating a persona", () => {
    it("adds a patient carrying an IHI, with demographics and a canonical link", async () => {
      const response = await addPersona(CHARLOTTE.patientId);

      expect(response.status).toBe(201);
      const grid = await readGrid();
      const persona = grid.personas.find((row) => row.ihi === CHARLOTTE.ihi);
      expect(persona?.display).toEqual({
        name: CHARLOTTE.name,
        birthDate: CHARLOTTE.birthDate,
      });
      expect(persona?.ihiSystem).toBe(TEST_IHI_SYSTEM);
      // The canonical record on the source server, which is what scenario 1 asks for.
      expect(persona?.canonicalUrl).toBe(
        `${SOURCE_URL}/Patient/${CHARLOTTE.patientId}`,
      );
      expect(persona?.sourceStatus).toBe("present");
      expect(persona?.sourceCheckedAt).toBe(START.toISOString());
      // Read from the source rather than taken from the request body.
      expect(fixtures.requests).toContain(
        `${SOURCE_URL}/Patient/${CHARLOTTE.patientId}`,
      );
    });

    it("refuses a patient without an IHI and states the reason (FR-031, scenario 2)", async () => {
      const response = await addPersona(NOEL.patientId);

      expect(response.status).toBe(422);
      const body = (await response.json()) as {
        error: string;
        detail?: string;
      };
      expect(body.error).toBe("persona_without_ihi");
      expect(body.detail).toContain(TEST_IHI_SYSTEM);
    });

    it("ignores an IHI asserted in the request body", async () => {
      // Deny by default: what a persona claims is what the source says, not what a caller
      // put in a body.
      const response = await addPersona(NOEL.patientId, {
        ihi: CHARLOTTE.ihi,
        display: { name: "Charlotte Morris", birthDate: CHARLOTTE.birthDate },
      });

      expect(response.status).toBe(422);
    });

    it("refuses the same patient twice", async () => {
      const first = await addPersona(CHARLOTTE.patientId);
      const second = await addPersona(CHARLOTTE.patientId);

      // Whichever ran first in this suite, one of them is the duplicate.
      expect([first.status, second.status]).toContain(409);
    });

    it("refuses an identifier that is not a FHIR id", async () => {
      const response = await addPersona("../metadata");

      expect(response.status).toBe(400);
      expect(fixtures.requests).toEqual([]);
    });

    it("refuses an approved member who is not an admin", async () => {
      const response = await apiRequest(
        stack,
        "POST",
        `/api/admin/events/${event.slug}/personas`,
        { cookie: memberCookie, body: { patientId: CHARLOTTE.patientId } },
      );

      expect(response.status).toBe(403);
    });

    it("refuses an anonymous caller", async () => {
      const response = await apiRequest(
        stack,
        "POST",
        `/api/admin/events/${event.slug}/personas`,
        { body: { patientId: CHARLOTTE.patientId } },
      );

      expect(response.status).toBe(401);
    });
  });

  describe("the coverage pass", () => {
    beforeEach(async () => {
      await addPersona(CHARLOTTE.patientId);
    });

    it("records one outcome per persona and enrolled server, with the time (scenario 3)", async () => {
      const summary = await runPassNow();

      expect(summary.checked).toBe(3);
      const grid = await readGrid();
      const persona = grid.personas.find((row) => row.ihi === CHARLOTTE.ihi);
      const cellFor = (enrolmentId: string) =>
        grid.coverage.find(
          (cell) =>
            cell.personaId === persona?.id && cell.enrolmentId === enrolmentId,
        );

      expect(cellFor(holder.id)?.outcome).toBe("found");
      expect(cellFor(empty.id)?.outcome).toBe("missing");
      // The distinction FR-032 exists for.
      expect(cellFor(locked.id)?.outcome).toBe("unverifiable");
      expect(cellFor(locked.id)?.detail).toContain("authorization");
      // Every cell carries when it was checked.
      expect(cellFor(holder.id)?.checkedAt).toBe(stack.now().toISOString());
    });

    it("checks server enrolments only", async () => {
      await runPassNow();

      const grid = await readGrid();
      expect(
        grid.servers.map((server) => server.enrolmentId).toSorted(),
      ).toEqual([holder.id, empty.id, locked.id].toSorted());
      // A client holds no patients, so a `missing` against one would be a failure recorded
      // against an entry that is correct.
      expect(
        grid.coverage.some((cell) => cell.enrolmentId === clientEnrolment.id),
      ).toBe(false);
    });

    it("does not re-check a pair that is not yet due", async () => {
      await runPassNow();
      // The same moment again: the cadence is what stops a pass hammering somebody's server.
      const second = await runner().runPass();

      expect(second.checked).toBe(0);
      expect(second.notDue).toBe(3);
    });

    it("searches each server by the persona's IHI as a system and value", async () => {
      await runPassNow();

      const asked = fixtures.requests.find((url) =>
        url.startsWith("https://holder.example.org/r4/Patient?"),
      );
      expect(
        new URL(asked ?? "https://x.example/").searchParams.get("identifier"),
      ).toBe(`${TEST_IHI_SYSTEM}|${CHARLOTTE.ihi}`);
    });

    it("flags a persona the source no longer holds (FR-032 edge case)", async () => {
      const slug = await freshPersonaEvent();
      fixtures.reset({ sourceHoldsCharlotte: false });

      const summary = await runPassNow(slug);

      expect(summary.flagged).toBeGreaterThan(0);
      const persona = (await readGrid(slug)).personas[0];
      expect(persona?.sourceStatus).toBe("missing");
      expect(persona?.sourceCheckedAt).toBe(stack.now().toISOString());
    });

    it("does not flag a persona because the source server was unreachable", async () => {
      // A source that was down for a minute has not deleted anybody, and flagging every
      // persona over it would teach admins to ignore the flag that matters.
      const slug = await freshPersonaEvent();
      fixtures.reset({ sourceBroken: true });

      await runPassNow(slug);

      const persona = (await readGrid(slug)).personas[0];
      expect(persona?.sourceStatus).toBe("present");
      // The time still moves, so the pass does not re-ask a broken source every sweep.
      expect(persona?.sourceCheckedAt).toBe(stack.now().toISOString());
    });

    it("runs as a pass of the one scheduler, not a service of its own", async () => {
      // The constitution forbids queues, workers and background services: coverage is a
      // pass of the same in-process scheduler the liveness checks run on.
      const passes: number[] = [];
      const scheduler = startCheckScheduler({
        db: stack.db,
        clock: () => stack.now(),
        listTargets: async () => await Promise.resolve([]),
        coverage: {
          runPass: async () => {
            passes.push(1);
            return await Promise.resolve({
              personas: 0,
              sourcesChecked: 0,
              flagged: 0,
              targets: 0,
              checked: 0,
              notDue: 0,
              inFlight: 0,
              found: 0,
              errors: 0,
            });
          },
        },
      });

      await scheduler.firstPass;
      scheduler.stop();

      expect(passes.length).toBe(1);
    });
  });

  describe("the public grid", () => {
    it("is readable without an account (scenario 5, principle V)", async () => {
      await addPersona(CHARLOTTE.patientId);
      await runPassNow();

      const response = await apiRequest(
        stack,
        "GET",
        `/api/events/${event.slug}/personas`,
      );

      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toContain(CHARLOTTE.ihi);
      // Test data is public by design; a contact detail never is.
      expect(text).not.toContain(stack.admin.email);
      expect(text).not.toContain("@muster.test");
    });

    it("answers 404 for an event that does not exist", async () => {
      const response = await apiRequest(
        stack,
        "GET",
        "/api/events/no-such-event-anywhere/personas",
      );

      expect(response.status).toBe(404);
    });
  });
});
