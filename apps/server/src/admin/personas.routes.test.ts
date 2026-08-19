import {
  errorEnvelopeSchema,
  personaResponseSchema,
  personaSearchResponseSchema,
  personasResponseSchema,
} from "@muster/contracts";
import {
  findPersonaByIhi,
  listPersonaCoverage,
  listPersonas,
  updateAccountStatus,
} from "@muster/db";
import { describeDatabase, uniqueName } from "@muster/db/test/harness";
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";

import { createScheduler } from "../scheduler/scheduler.ts";
import {
  readJson,
  request,
  signUpAndSignIn,
  startTestServer,
} from "../test/support.ts";

import type { PersonaRunSummary, Scheduler } from "../scheduler/scheduler.ts";
import type { SignedIn, TestServer } from "../test/support.ts";
import type { PersonasResponse } from "@muster/contracts";
import type { PersonaRow } from "@muster/db";

/**
 * Persona curation, the coverage pass, and the public grid.
 *
 * The source server and every enrolled server in this suite are stand-ins reached
 * through the injected fetch, so the SSRF guard runs for real against addresses
 * the suite chooses: `internal.*` resolves into a private range and is refused
 * before any request leaves, exactly as a participant's private-range entry would
 * be. The stand-ins answer as FHIR servers do - searchsets, `_summary=count`
 * totals, an authorization challenge, a `404` for a patient the source has
 * deleted - so what is asserted here is what the routes would make of real
 * answers.
 *
 * Five things carry the specification.
 *
 * The search is proxied through the guard and offers IHI-bearing patients only,
 * reporting the others with the reason, because an admin who can see a patient on
 * the source needs to know why it is not on the list (acceptance scenarios 1 and
 * 2).
 *
 * A persona's IHI comes from the source, never from the request: adding one names
 * a patient and Muster reads it. A patient without an IHI is refused with the
 * identifier system named.
 *
 * Coverage is three-valued and each value is earned (FR-032). A server that holds
 * the patient is `found`, one that answers an empty searchset is `missing`, one
 * that demands authorization is `unverifiable`, and an address the guard refuses is
 * `unverifiable` with the guard's own reason and no request made.
 *
 * A persona the source has deleted is flagged `missing` at source, and a source
 * that could not be read flags nothing - the stored flag stays where it was.
 *
 * The grid is anonymous (SC-006) and carries no contact details (FR-007).
 */

describeDatabase("the persona routes", () => {
  let server: TestServer;
  let admin: SignedIn;
  let member: SignedIn;

  /** Every request the routes and the scheduler made, in order. */
  let calls: string[] = [];

  /** The IHI system the suite's configuration fixes. */
  const ihiSystem = "http://ns.electronichealth.net.au/id/hi/ihi/1.0";

  /** Where the events in this suite curate their personas from. */
  const sourceUrl = "https://source.example.org/fhir";

  /** A patient on the source carrying an IHI. */
  const withIhi = {
    resourceType: "Patient",
    id: "baratz-toni",
    identifier: [
      { system: ihiSystem, value: "8003608000311662" },
      {
        system: "http://ns.electronichealth.net.au/id/medicare-number",
        value: "69518252411",
      },
    ],
    name: [{ use: "official", family: "BARATZ", given: ["Toni"] }],
    gender: "female",
    birthDate: "1978-06-16",
  };

  /** A patient on the source carrying no IHI. */
  const withoutIhi = {
    resourceType: "Patient",
    id: "italia-sofia",
    identifier: [
      { system: "http://hl7.org/fhir/sid/passport-ITA", value: "IT1111111" },
    ],
    name: [{ family: "Italia", given: ["Sofia"] }],
    gender: "female",
    birthDate: "1989-05-07",
  };

  /** The IHI the suite's persona is identified by. */
  const ihi = "8003608000311662";

  beforeAll(async () => {
    server = await startTestServer("personas", {
      // Every participant address resolves to a documentation address, which the
      // guard permits, so the guard is exercised rather than bypassed. Anything
      // named internal resolves into a private range for it to refuse.
      resolve: (host) =>
        Promise.resolve(
          host.startsWith("internal.") ? ["10.1.2.3"] : ["203.0.113.10"],
        ),
      fetchImplementation: (url) => {
        calls.push(url);
        return Promise.resolve(answerFor(url));
      },
    });
    admin = await arrangeMember(true);
    member = await arrangeMember();
  });

  beforeEach(() => {
    calls = [];
  });

  afterAll(async () => {
    await server.close();
  });

  // The stand-in servers -----------------------------------------------------

  // A FHIR searchset, as a conformant server serves one.
  function searchset(resources: readonly unknown[]): Response {
    return Response.json({
      resourceType: "Bundle",
      type: "searchset",
      total: resources.length,
      entry: resources.map((resource) => ({ resource })),
    });
  }

  // A count-only searchset, which is what `_summary=count` asks for.
  function countOnly(total: number): Response {
    return Response.json({ resourceType: "Bundle", type: "searchset", total });
  }

  // The source server, and the four enrolled stand-ins the grid is drawn over.
  function answerFor(url: string): Response {
    const address = new URL(url);
    const path = `${address.origin}${address.pathname}`;
    const identifier = address.searchParams.get("identifier");

    if (path === `${sourceUrl}/Patient`) {
      // The source's search: by IHI when asked for one, by name otherwise.
      return identifier === null
        ? searchset([withIhi, withoutIhi])
        : searchset(identifier.endsWith(ihi) ? [withIhi] : []);
    }
    if (path === `${sourceUrl}/Patient/baratz-toni`) {
      return Response.json(withIhi);
    }
    if (path === `${sourceUrl}/Patient/italia-sofia`) {
      return Response.json(withoutIhi);
    }
    if (path === `${sourceUrl}/Patient/deleted-at-source`) {
      return Response.json(
        { resourceType: "OperationOutcome" },
        { status: 404 },
      );
    }
    if (path === "https://holder.example.org/fhir/Patient") {
      // A participant who seeded the persona.
      return countOnly(identifier?.endsWith(ihi) === true ? 1 : 0);
    }
    if (path === "https://empty.example.org/fhir/Patient") {
      // A participant who has not.
      return countOnly(0);
    }
    if (path === "https://secure.example.org/fhir/Patient") {
      // A participant whose server will not be searched anonymously.
      return Response.json(
        { resourceType: "OperationOutcome" },
        { status: 401 },
      );
    }
    return new Response("not found", { status: 404 });
  }

  // Arranging ---------------------------------------------------------------

  // Signs an account up, verifies it, approves it, and signs it in.
  async function arrangeMember(isAdmin = false): Promise<SignedIn> {
    const account = await signUpAndSignIn(
      server,
      `${uniqueName(isAdmin ? "admin" : "member")}@example.org`,
    );
    await updateAccountStatus(server.database.sql, {
      accountId: account.id,
      status: "approved",
      decidedBy: account.id,
      decidedAt: new Date(),
    });
    if (isAdmin) {
      await server.database
        .sql`update account set is_admin = true where id = ${account.id}`;
    }
    return account;
  }

  // Reads the identifier out of a created resource.
  const idOf = async (response: Response, key: string): Promise<string> => {
    const body: unknown = await response.json();
    const resource: unknown =
      typeof body === "object" && body !== null && key in body
        ? body[key as keyof typeof body]
        : undefined;
    if (typeof resource === "object" && resource !== null && "id" in resource) {
      return String(resource.id);
    }
    throw new Error(`No ${key}.id in ${JSON.stringify(body)}`);
  };

  /** An event with a persona source, and what is enrolled in it. */
  type Stage = {
    /** the event's slug */
    readonly slug: string;
    /** the organisation owning the enrolled systems */
    readonly organisationId: string;
    /** the enrolments, by the name they were created with */
    readonly enrolments: Record<string, string>;
  };

  // Creates an event, as the admin.
  const arrangeEvent = async (
    personaSourceUrl: string | null,
    status = "open",
  ): Promise<string> => {
    const slug = uniqueName("event").replaceAll("_", "-");
    const created = await request(server, "POST", "/api/admin/events", {
      body: {
        slug,
        name: "Sparked connectathon",
        startsOn: "2026-09-01",
        endsOn: "2126-09-03",
        status,
        capabilityTags: [],
        graceDays: 7,
        personaSourceUrl,
      },
      cookie: admin.cookie,
    });
    expect(created.status).toBe(201);
    return slug;
  };

  // Enrols one system, of the kind the caller asks for.
  const arrangeEnrolment = async (
    slug: string,
    organisationId: string,
    owner: SignedIn,
    name: string,
    profiles: Record<string, unknown>,
  ): Promise<string> => {
    const systemId = await idOf(
      await request(
        server,
        "POST",
        `/api/organisations/${organisationId}/systems`,
        { body: { name, description: "", ...profiles }, cookie: owner.cookie },
      ),
      "system",
    );
    return idOf(
      await request(server, "POST", `/api/events/${slug}/enrolments`, {
        body: { systemId, tags: [] },
        cookie: owner.cookie,
      }),
      "enrolment",
    );
  };

  // A server profile at one host.
  const serverProfile = (host: string): Record<string, unknown> => ({
    serverProfile: {
      fhirBaseUrl: `https://${host}/fhir`,
      authorizationMode: "smart",
      registrationMode: "manual",
      notes: "",
    },
  });

  // An event with a source, an organisation, and the four stand-in servers plus
  // a client-only entry, which is what the grid is drawn over.
  const arrangeStage = async (): Promise<Stage> => {
    const slug = await arrangeEvent(sourceUrl);
    const organisationId = await idOf(
      await request(server, "POST", "/api/organisations", {
        body: { name: uniqueName("Vendor") },
        cookie: member.cookie,
      }),
      "organisation",
    );
    const enrolments: Record<string, string> = {};
    for (const [name, host] of [
      ["holder", "holder.example.org"],
      ["empty", "empty.example.org"],
      ["secure", "secure.example.org"],
      ["internal", "internal.example.org"],
    ] as const) {
      enrolments[name] = await arrangeEnrolment(
        slug,
        organisationId,
        member,
        name,
        serverProfile(host),
      );
    }
    enrolments["app"] = await arrangeEnrolment(
      slug,
      organisationId,
      member,
      "app",
      {
        clientProfile: {
          launchUrl: "https://app.example.org/launch",
          redirectUris: ["https://app.example.org/callback"],
          scopes: ["launch"],
          confidentiality: "public",
          launchContext: "",
          needsIntrospection: false,
        },
      },
    );
    return { slug, organisationId, enrolments };
  };

  // Searches the source as whoever is given.
  const search = async (
    slug: string,
    query: string,
    as: SignedIn | null = admin,
  ): Promise<Response> =>
    request(
      server,
      "GET",
      `/api/admin/events/${slug}/persona-search?q=${encodeURIComponent(query)}`,
      as === null ? {} : { cookie: as.cookie },
    );

  // Adds a persona as whoever is given.
  const addPersona = async (
    slug: string,
    patientId: string,
    as: SignedIn | null = admin,
  ): Promise<Response> =>
    request(server, "POST", `/api/admin/events/${slug}/personas`, {
      body: { patientId },
      ...(as === null ? {} : { cookie: as.cookie }),
    });

  // Reads the public grid, anonymously unless the caller says otherwise.
  const grid = async (
    slug: string,
    as: SignedIn | null = null,
  ): Promise<PersonasResponse> => {
    const response = await request(
      server,
      "GET",
      `/api/events/${slug}/personas`,
      as === null ? {} : { cookie: as.cookie },
    );
    expect(response.status).toBe(200);
    return readJson(response, personasResponseSchema);
  };

  // A scheduler over the suite's database, with a fixed clock.
  const schedulerAt = (at: Date): Scheduler =>
    createScheduler({
      sql: server.database.sql,
      config: server.config,
      now: () => at,
      resolve: (host) =>
        Promise.resolve(
          host.startsWith("internal.") ? ["10.1.2.3"] : ["203.0.113.10"],
        ),
      fetchImplementation: (url) => {
        calls.push(url);
        return Promise.resolve(answerFor(url));
      },
      log: () => undefined,
    });

  /** An arbitrary instant the coverage passes measure from. */
  const startedAt = new Date("2026-08-19T02:00:00.000Z");

  /** Fifteen minutes, in milliseconds. */
  const fifteenMinutes = 15 * 60 * 1000;

  // Runs one persona pass at an instant.
  const passAt = async (at: Date): Promise<PersonaRunSummary> =>
    schedulerAt(at).runDuePersonaChecks();

  // Reads the one persona of an event, failing the test when there is none.
  const personaOf = async (slug: string): Promise<PersonaRow> => {
    const event = await server.database
      .sql`select id from event where slug = ${slug}`;
    const eventId = String((event as { id: string }[])[0]?.id);
    const personas = await listPersonas(server.database.sql, eventId);
    const persona = personas[0];
    if (persona === undefined) {
      throw new Error(`${slug} has no persona`);
    }
    return persona;
  };

  // Reads one cell of the grid.
  const cellOf = (
    response: PersonasResponse,
    personaId: string,
    enrolmentId: string,
  ) =>
    response.coverage.find(
      (cell) =>
        cell.personaId === personaId && cell.enrolmentId === enrolmentId,
    );

  // The search -------------------------------------------------------------

  // Acceptance scenarios 1 and 2: the source is searched through the guard, and
  // only IHI-bearing patients are offered.
  test("proxies the source search and offers only IHI-bearing patients", async () => {
    const slug = await arrangeEvent(sourceUrl);

    const response = await search(slug, "baratz");

    expect(response.status).toBe(200);
    const body = await readJson(response, personaSearchResponseSchema);
    expect(body.candidates).toEqual([
      {
        patientId: "baratz-toni",
        ihi,
        display: {
          name: "Toni BARATZ",
          birthDate: "1978-06-16",
          gender: "female",
        },
      },
    ]);
    expect(body.ineligible).toHaveLength(1);
    expect(body.ineligible[0]?.patientId).toBe("italia-sofia");
    expect(body.ineligible[0]?.detail).toContain(ihiSystem);
    // The request went to the source, through the guard, with the name asked for.
    expect(calls).toEqual([`${sourceUrl}/Patient?name=baratz&_count=20`]);
  });

  test("searches the source by identifier when the query is an IHI", async () => {
    const slug = await arrangeEvent(sourceUrl);

    const response = await search(slug, ihi);

    expect(response.status).toBe(200);
    const body = await readJson(response, personaSearchResponseSchema);
    expect(body.candidates).toHaveLength(1);
    expect(calls[0]).toContain(`identifier=${encodeURIComponent(ihiSystem)}`);
    expect(calls[0]).toContain(ihi);
  });

  // FR-004: curation is a track admin's, and a refusal makes no request.
  test("refuses the search to an ordinary member without asking the source", async () => {
    const slug = await arrangeEvent(sourceUrl);

    const response = await search(slug, "baratz", member);

    expect(response.status).toBe(403);
    expect(calls).toEqual([]);
  });

  test("refuses the search to an anonymous caller", async () => {
    const slug = await arrangeEvent(sourceUrl);

    const response = await search(slug, "baratz", null);

    expect(response.status).toBe(401);
    expect(calls).toEqual([]);
  });

  // Deny by default: an event with no source cannot be searched, and the answer
  // says so rather than searching something else.
  test("refuses the search when the event has no persona source", async () => {
    const slug = await arrangeEvent(null);

    const response = await search(slug, "baratz");

    expect(response.status).toBe(422);
    const body = await readJson(response, errorEnvelopeSchema);
    expect(body.detail).toContain("persona source");
    expect(calls).toEqual([]);
  });

  // FR-020: a guarded source is reported as a refusal with its reason.
  test("refuses a guarded persona source, naming the reason", async () => {
    const slug = await arrangeEvent("https://internal.example.org/fhir");

    const response = await search(slug, "baratz");

    expect(response.status).toBe(422);
    const body = await readJson(response, errorEnvelopeSchema);
    expect(body.error).toBe("guarded");
    expect(body.detail).toMatch(/private/i);
  });

  // Adding a persona -------------------------------------------------------

  // Acceptance scenario 1: demographics, IHI and canonical link are recorded.
  test("adds a persona carrying an IHI, with its canonical link", async () => {
    const slug = await arrangeEvent(sourceUrl);

    const response = await addPersona(slug, "baratz-toni");

    expect(response.status).toBe(201);
    const body = await readJson(response, personaResponseSchema);
    expect(body.persona.ihi).toBe(ihi);
    expect(body.persona.patientId).toBe("baratz-toni");
    expect(body.persona.display.name).toBe("Toni BARATZ");
    expect(body.persona.sourceUrl).toBe(`${sourceUrl}/Patient/baratz-toni`);
    expect(body.persona.sourceStatus).toBe("present");
    expect(body.persona.sourceCheckedAt).toBeNull();
    // The IHI came from the source, not from the request.
    expect(calls).toEqual([`${sourceUrl}/Patient/baratz-toni`]);
    const stored = await personaOf(slug);
    expect(stored.ihi).toBe(ihi);
  });

  // Acceptance scenario 2: the reason is stated.
  test("refuses a patient with no IHI, naming the identifier system", async () => {
    const slug = await arrangeEvent(sourceUrl);

    const response = await addPersona(slug, "italia-sofia");

    expect(response.status).toBe(422);
    const body = await readJson(response, errorEnvelopeSchema);
    expect(body.error).toBe("unprocessable");
    expect(body.detail).toContain(ihiSystem);
    const event = await server.database
      .sql`select id from event where slug = ${slug}`;
    expect(
      await listPersonas(
        server.database.sql,
        String((event as { id: string }[])[0]?.id),
      ),
    ).toEqual([]);
  });

  test("refuses a patient the source does not hold", async () => {
    const slug = await arrangeEvent(sourceUrl);

    const response = await addPersona(slug, "deleted-at-source");

    expect(response.status).toBe(422);
    const body = await readJson(response, errorEnvelopeSchema);
    expect(body.detail).toContain("404");
  });

  test("refuses a second persona for the same IHI", async () => {
    const slug = await arrangeEvent(sourceUrl);
    expect((await addPersona(slug, "baratz-toni")).status).toBe(201);

    const response = await addPersona(slug, "baratz-toni");

    expect(response.status).toBe(409);
    const body = await readJson(response, errorEnvelopeSchema);
    expect(body.detail).toContain(ihi);
  });

  test("refuses curation of a closed event", async () => {
    const slug = await arrangeEvent(sourceUrl, "closed");

    const response = await addPersona(slug, "baratz-toni");

    expect(response.status).toBe(409);
    expect(calls).toEqual([]);
  });

  // The coverage pass ------------------------------------------------------

  // Acceptance scenarios 3 and 4: the grid, three-valued, with check times.
  test("records coverage per persona and server, three-valued", async () => {
    const stage = await arrangeStage();
    expect((await addPersona(stage.slug, "baratz-toni")).status).toBe(201);
    calls = [];

    const summary = await passAt(startedAt);
    const persona = await personaOf(stage.slug);

    // One cell per server enrolment, and none for the client entry.
    expect(summary.coverage).toHaveLength(4);
    const response = await grid(stage.slug);
    expect(response.coverage).toHaveLength(4);
    expect(
      cellOf(response, persona.id, stage.enrolments["holder"] ?? ""),
    ).toEqual({
      personaId: persona.id,
      enrolmentId: stage.enrolments["holder"] ?? "",
      outcome: "found",
      detail: expect.stringContaining(ihi) as unknown as string,
      checkedAt: startedAt.toISOString(),
    });
    expect(
      cellOf(response, persona.id, stage.enrolments["empty"] ?? "")?.outcome,
    ).toBe("missing");
    const secure = cellOf(
      response,
      persona.id,
      stage.enrolments["secure"] ?? "",
    );
    expect(secure?.outcome).toBe("unverifiable");
    expect(secure?.detail).toContain("authorization");
    expect(
      cellOf(response, persona.id, stage.enrolments["app"] ?? ""),
    ).toBeUndefined();

    // The guarded entry is recorded as a refusal with the guard's reason, and no
    // request was made to it (FR-020).
    const guarded = cellOf(
      response,
      persona.id,
      stage.enrolments["internal"] ?? "",
    );
    expect(guarded?.outcome).toBe("unverifiable");
    expect(guarded?.detail).toMatch(/private/i);
    expect(calls.some((url) => url.includes("internal.example.org"))).toBe(
      false,
    );
    // Each searchable server was asked for the persona's IHI, once.
    expect(
      calls.filter((url) => url.startsWith("https://holder.example.org")),
    ).toHaveLength(1);
  });

  // The cadence is the same rule the liveness checks follow: one pass per
  // interval per pair, and a pass that finds nothing due does nothing.
  test("leaves a pair alone until its interval has passed", async () => {
    const stage = await arrangeStage();
    expect((await addPersona(stage.slug, "baratz-toni")).status).toBe(201);
    await passAt(startedAt);
    calls = [];

    const persona = await personaOf(stage.slug);
    const pairs = ["holder", "empty", "secure", "internal"].map(
      (name) => `${persona.id}:${stage.enrolments[name] ?? ""}`,
    );

    const soon = await passAt(new Date(startedAt.getTime() + 60_000));
    expect(soon.coverage).toEqual([]);
    for (const pair of pairs) {
      expect(soon.coverageSkipped).toContain(pair);
    }
    expect(calls).toEqual([]);

    const later = await passAt(new Date(startedAt.getTime() + fifteenMinutes));
    for (const pair of pairs) {
      expect(later.coverage).toContain(pair);
    }
    // History is kept: two observations of the same pair, newest first.
    expect(
      await listPersonaCoverage(
        server.database.sql,
        persona.id,
        stage.enrolments["holder"] ?? "",
      ),
    ).toHaveLength(2);
  });

  // The edge case: the source deleted the curated patient.
  test("flags a persona missing when the source no longer holds it", async () => {
    const slug = await arrangeEvent(sourceUrl);
    expect((await addPersona(slug, "baratz-toni")).status).toBe(201);
    // The source loses the patient: the row keeps naming it, and the pass reads
    // the source rather than the row.
    await server.database
      .sql`update persona set patient_id = 'deleted-at-source'`;

    const summary = await passAt(startedAt);

    expect(summary.sources).toHaveLength(1);
    const persona = await personaOf(slug);
    expect(persona.sourceStatus).toBe("missing");
    expect(persona.sourceCheckedAt).toEqual(startedAt);
    const response = await grid(slug);
    expect(response.personas[0]?.sourceStatus).toBe("missing");
  });

  test("keeps the source flag when the patient is still there", async () => {
    const slug = await arrangeEvent(sourceUrl);
    expect((await addPersona(slug, "baratz-toni")).status).toBe(201);

    await passAt(startedAt);

    const persona = await personaOf(slug);
    expect(persona.sourceStatus).toBe("present");
    expect(persona.sourceCheckedAt).toEqual(startedAt);
  });

  // A source Muster could not read says nothing about the patient.
  test("claims nothing about a persona whose source is guarded", async () => {
    const slug = await arrangeEvent(sourceUrl);
    expect((await addPersona(slug, "baratz-toni")).status).toBe(201);
    // The event's source moves to an address the guard refuses.
    await request(server, "PATCH", `/api/admin/events/${slug}`, {
      body: { personaSourceUrl: "https://internal.example.org/fhir" },
      cookie: admin.cookie,
    });
    calls = [];

    await passAt(startedAt);

    const persona = await personaOf(slug);
    expect(persona.sourceStatus).toBe("present");
    expect(persona.sourceCheckedAt).toEqual(startedAt);
    expect(calls.some((url) => url.includes("internal.example.org"))).toBe(
      false,
    );
  });

  // The public grid --------------------------------------------------------

  // SC-006: personas and the grid are readable without an account, and FR-007
  // still holds - no contact details anywhere in the response.
  test("serves the grid anonymously, with no contact details", async () => {
    const stage = await arrangeStage();
    expect((await addPersona(stage.slug, "baratz-toni")).status).toBe(201);
    await passAt(startedAt);

    const response = await grid(stage.slug);

    expect(response.event.slug).toBe(stage.slug);
    expect(response.personas).toHaveLength(1);
    expect(response.personas[0]?.ihi).toBe(ihi);
    // The columns are the event's server entries, and only those.
    expect(response.servers.map((entry) => entry.system.name).sort()).toEqual([
      "empty",
      "holder",
      "internal",
      "secure",
    ]);
    for (const entry of response.servers) {
      expect(entry.contacts).toBeUndefined();
    }
  });

  test("serves an empty grid for an event with no personas", async () => {
    const slug = await arrangeEvent(sourceUrl);

    const response = await grid(slug);

    expect(response.personas).toEqual([]);
    expect(response.coverage).toEqual([]);
  });

  test("answers a grid for an event nobody curated with 404", async () => {
    const response = await request(
      server,
      "GET",
      "/api/events/no-such-event/personas",
    );

    expect(response.status).toBe(404);
  });

  // A signed-in admin reads the same grid: the personas are public either way,
  // and the source flag is what an admin comes here for.
  test("shows the source flag to an admin reading the grid", async () => {
    const slug = await arrangeEvent(sourceUrl);
    expect((await addPersona(slug, "baratz-toni")).status).toBe(201);

    const response = await grid(slug, admin);

    expect(response.personas[0]?.sourceStatus).toBe("present");
  });

  // The persona set the source no longer supports must be findable by an admin,
  // which is what makes "flagged to admins" true rather than aspirational.
  test("keeps a persona readable by its IHI after it is curated", async () => {
    const slug = await arrangeEvent(sourceUrl);
    expect((await addPersona(slug, "baratz-toni")).status).toBe(201);
    const event = await server.database
      .sql`select id from event where slug = ${slug}`;

    const found = await findPersonaByIhi(server.database.sql, {
      eventId: String((event as { id: string }[])[0]?.id),
      ihi,
    });

    expect(found?.patientId).toBe("baratz-toni");
  });
});
