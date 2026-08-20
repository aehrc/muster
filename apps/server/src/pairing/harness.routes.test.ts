/*
 * Copyright © 2026 Commonwealth Scientific and Industrial Research Organisation
 * (CSIRO) ABN 41 687 119 230. Licensed under the Apache License, Version 2.0.
 */

import {
  errorEnvelopeSchema,
  eventSystemsSchema,
  harnessRunResponseSchema,
  harnessRunsResponseSchema,
  jwksSchema,
} from "@muster/contracts";
import { updateAccountStatus } from "@muster/db";
import { describeDatabase, uniqueName } from "@muster/db/test/harness";
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { compactVerify, decodeProtectedHeader, importJWK } from "jose";

import {
  readJson,
  request,
  signUpAndSignIn,
  startTestServer,
} from "../test/support.ts";

import type { SignedIn, TestServer } from "../test/support.ts";
import type { HarnessCheckName, HarnessRun } from "@muster/contracts";

/**
 * The conformance harness run: five requests at a registration endpoint, the
 * report they produce, and the badge that follows it.
 *
 * The registration endpoint in this suite is a stub reached through the injected
 * fetch, because the guard is the only path to the network and a test suite must
 * not be one of the things it lets through. The stub is the profile implemented
 * properly, with the same switchable broken behaviours as
 * `deploy/stubs/registerServer.ts` - it verifies the ES256 signature against the
 * application's own published JWKS, spends each `jti` once and answers RFC 7591's
 * error vocabulary - so a check that passes here passes against a real
 * implementation of the document rather than against a mock that agreed with it.
 *
 * Three things carry the specification directly. Each broken mode fails exactly
 * the check that names it and no others, which is what makes the report
 * actionable. The badge is the latest run's verdict and nothing else, so a server
 * that regresses loses it. And the throwaway clients the run registers are
 * deleted where RFC 7592 allows and reported as left behind where it does not,
 * asserted against the stub's own list of what it is still holding.
 *
 * The no-stored-credentials rule is asserted the way the DCR suite asserts it: by
 * scanning every column of every row of every table for the secret, rather than
 * checking the two columns somebody remembered.
 */

/** How the stub registration endpoint may misbehave. */
type StubMode =
  | "strict"
  | "skipSignature"
  | "ignoreExpiry"
  | "allowReplay"
  | "bareResponse"
  | "trustBody"
  | "vagueErrors"
  | "noCleanup";

describeDatabase("the conformance harness routes", () => {
  let server: TestServer;
  let admin: SignedIn;

  /** How the stub is behaving for the run under way. */
  let mode: StubMode = "strict";

  /** Every request the run made to the participant's server. */
  let calls: { method: string; url: string; init: RequestInit }[] = [];

  /** The statement identifiers the stub has spent. */
  let spent = new Set<string>();

  /** The clients the stub is holding, by identifier. */
  let held = new Map<
    string,
    { accessToken: string; metadata: Record<string, unknown> }
  >();

  /** How many clients the stub has ever issued, for naming the next one. */
  let issued = 0;

  beforeAll(async () => {
    server = await startTestServer("harness", {
      // Every participant address resolves to a documentation address, which the
      // guard permits, so the guard is exercised rather than bypassed.
      resolve: (host) =>
        Promise.resolve(
          host === "guarded.example.org" ? ["127.0.0.1"] : ["203.0.113.10"],
        ),
      fetchImplementation: async (url, init) => {
        const method = String(init.method ?? "GET").toUpperCase();
        calls.push({ method, url, init });
        return method === "DELETE" ? stubDelete(url, init) : stubRegister(init);
      },
    });
    admin = await arrangeMember(true);
  });

  beforeEach(() => {
    calls = [];
    spent = new Set();
    held = new Map();
    issued = 0;
    mode = "strict";
  });

  afterAll(async () => {
    await server.close();
  });

  // The stub -----------------------------------------------------------------

  // Reads the claims of a statement without verifying it. Only `skipSignature`
  // uses this, which is the point of that mode.
  function claimsWithoutVerifying(jws: string): Record<string, unknown> | null {
    const payload = jws.split(".")[1];
    if (payload === undefined) {
      return null;
    }
    try {
      return JSON.parse(
        Buffer.from(payload, "base64url").toString("utf8"),
      ) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  // Verifies an ES256 statement against the key the application publishes for the
  // `kid` in its header, fetched for this request rather than cached.
  async function verifyStatement(
    jws: string,
  ): Promise<Record<string, unknown> | null> {
    const published = await readJson(
      await request(server, "GET", "/.well-known/jwks.json"),
      jwksSchema,
    );
    let kid: string | undefined;
    try {
      kid = decodeProtectedHeader(jws).kid;
    } catch {
      return null;
    }
    const jwk = published.keys.find((candidate) => candidate.kid === kid);
    if (jwk === undefined) {
      return null;
    }
    try {
      const verified = await compactVerify(jws, await importJWK({ ...jwk }));
      return JSON.parse(new TextDecoder().decode(verified.payload)) as Record<
        string,
        unknown
      >;
    } catch {
      return null;
    }
  }

  // A refusal in RFC 7591's shape; `vagueErrors` answers every one the same way.
  function refuse(code: string, description: string): Response {
    return Response.json(
      {
        error: mode === "vagueErrors" ? "invalid_request" : code,
        error_description: description,
      },
      { status: 400 },
    );
  }

  // The client metadata the stub registers, taken from the statement.
  function metadataFrom(
    claims: Record<string, unknown>,
  ): Record<string, unknown> {
    return {
      client_name: claims["client_name"],
      redirect_uris: claims["redirect_uris"],
      grant_types: claims["grant_types"],
      token_endpoint_auth_method: claims["token_endpoint_auth_method"],
      scope: claims["scope"],
      smart_launch_url: claims["smart_launch_url"],
    };
  }

  // The body a request carried, which the harness always renders itself.
  function sentBody(init: RequestInit): Record<string, unknown> {
    return JSON.parse(
      typeof init.body === "string" ? init.body : "{}",
    ) as Record<string, unknown>;
  }

  // Reads a string member of a JSON object.
  function member(body: Record<string, unknown>, name: string): string {
    const value = body[name];
    return typeof value === "string" ? value : "";
  }

  // The registration endpoint, implemented against the profile.
  async function stubRegister(init: RequestInit): Promise<Response> {
    const body = sentBody(init);
    const jws = member(body, "software_statement");
    const outside = Object.entries(body).filter(
      ([name]) => name !== "software_statement",
    );
    if (outside.length > 0 && mode !== "trustBody") {
      return refuse(
        "invalid_request",
        "Metadata must live inside the statement.",
      );
    }

    const claims =
      mode === "skipSignature"
        ? claimsWithoutVerifying(jws)
        : await verifyStatement(jws);
    if (claims === null) {
      return refuse(
        "invalid_software_statement",
        "The signature did not verify against the anchor's published keys.",
      );
    }
    const expiresAt = Number(claims["exp"] ?? 0);
    if (mode !== "ignoreExpiry" && expiresAt * 1000 <= Date.now()) {
      return refuse("invalid_software_statement", "The statement has expired.");
    }
    const jti = member(claims, "jti");
    if (mode !== "allowReplay") {
      if (spent.has(jti)) {
        return refuse(
          "invalid_software_statement",
          "That statement has already registered a client.",
        );
      }
      spent.add(jti);
    }

    issued += 1;
    const clientId = `stub-${String(issued)}`;
    const accessToken = `rat-${String(issued)}`;
    const metadata =
      mode === "trustBody"
        ? { ...metadataFrom(claims), ...Object.fromEntries(outside) }
        : metadataFrom(claims);
    held.set(clientId, { accessToken, metadata });

    if (mode === "bareResponse") {
      return Response.json({ client_id: clientId }, { status: 201 });
    }
    return Response.json(
      {
        client_id: clientId,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        ...metadata,
        ...(mode === "noCleanup"
          ? {}
          : {
              registration_client_uri: `https://stub.example.org/register/${clientId}`,
              registration_access_token: accessToken,
            }),
      },
      { status: 201 },
    );
  }

  // RFC 7592 deletion, which is how the harness cleans up after itself.
  function stubDelete(url: string, init: RequestInit): Response {
    const clientId = url.split("/").at(-1) ?? "";
    const client = held.get(clientId);
    if (client === undefined) {
      return Response.json({ error: "invalid_client_id" }, { status: 404 });
    }
    const headers = new Headers(init.headers);
    if (headers.get("authorization") !== `Bearer ${client.accessToken}`) {
      return Response.json({ error: "invalid_token" }, { status: 401 });
    }
    held.delete(clientId);
    return new Response(null, { status: 204 });
  }

  // Arranging ---------------------------------------------------------------

  // Signs an account up, verifies it, approves it, and signs it in.
  async function arrangeMember(isAdmin = false): Promise<SignedIn> {
    const member = await signUpAndSignIn(
      server,
      `${uniqueName(isAdmin ? "admin" : "member")}@example.org`,
    );
    await updateAccountStatus(server.database.sql, {
      accountId: member.id,
      status: "approved",
      decidedBy: member.id,
      decidedAt: new Date(),
    });
    if (isAdmin) {
      await server.database
        .sql`update account set is_admin = true where id = ${member.id}`;
    }
    return member;
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

  // A server profile with the registration mode and host under test.
  const serverProfile = (
    registrationMode: string,
    host = "stub.example.org",
  ) => ({
    fhirBaseUrl: `https://${host}/fhir`,
    authorizationMode: "smart",
    registrationMode,
    ...(registrationMode === "trustedDcr"
      ? { registrationEndpoint: `https://${host}/register` }
      : {}),
    notes: "",
  });

  /** An enrolled server, and who owns it. */
  type Stage = {
    /** the organisation's member, who runs the harness */
    readonly owner: SignedIn;
    /** the enrolment the run is against */
    readonly enrolmentId: string;
    /** the system enrolled */
    readonly systemId: string;
    /** the event it is enrolled in */
    readonly slug: string;
  };

  // Arranges an organisation, an open event, a server system and its enrolment.
  const arrangeStage = async (
    registrationMode = "trustedDcr",
    host = "stub.example.org",
  ): Promise<Stage> => {
    const owner = await arrangeMember();
    const organisationId = await idOf(
      await request(server, "POST", "/api/organisations", {
        body: { name: uniqueName("Vendor") },
        cookie: owner.cookie,
      }),
      "organisation",
    );
    const slug = uniqueName("event").replaceAll("_", "-");
    const created = await request(server, "POST", "/api/admin/events", {
      body: {
        slug,
        name: "Sparked connectathon",
        startsOn: "2026-09-01",
        endsOn: "2126-09-03",
        status: "open",
        capabilityTags: [],
        graceDays: 7,
      },
      cookie: admin.cookie,
    });
    expect(created.status).toBe(201);

    const systemId = await idOf(
      await request(
        server,
        "POST",
        `/api/organisations/${organisationId}/systems`,
        {
          body: {
            name: "Stub Auth",
            description: "",
            serverProfile: serverProfile(registrationMode, host),
          },
          cookie: owner.cookie,
        },
      ),
      "system",
    );
    const enrolmentId = await idOf(
      await request(server, "POST", `/api/events/${slug}/enrolments`, {
        body: { systemId, tags: [] },
        cookie: owner.cookie,
      }),
      "enrolment",
    );
    return { owner, enrolmentId, systemId, slug };
  };

  // Runs the harness as whoever is given, defaulting to the entry's owner.
  const runHarness = async (
    stage: Stage,
    as: SignedIn | null = stage.owner,
  ): Promise<Response> =>
    request(
      server,
      "POST",
      `/api/enrolments/${stage.enrolmentId}/harness-runs`,
      { body: {}, ...(as === null ? {} : { cookie: as.cookie }) },
    );

  // Runs the harness and reads the report it produced.
  const reportOf = async (stage: Stage): Promise<HarnessRun> => {
    const response = await runHarness(stage);
    expect(response.status).toBe(201);
    return (await readJson(response, harnessRunResponseSchema)).run;
  };

  // Reads one check out of a report.
  const checkOf = (run: HarnessRun, name: HarnessCheckName) => {
    const check = run.checks.find((candidate) => candidate.name === name);
    if (check === undefined) {
      throw new Error(`The run made no ${name} check`);
    }
    return check;
  };

  // The names of the checks that failed, in report order.
  const failuresOf = (run: HarnessRun): readonly HarnessCheckName[] =>
    run.checks
      .filter((check) => check.outcome === "failed")
      .map((check) => check.name);

  // The entry as the public event view shows it.
  const entryOf = async (stage: Stage) => {
    const { systems } = await readJson(
      await request(server, "GET", `/api/events/${stage.slug}/systems`),
      eventSystemsSchema,
    );
    const entry = systems.find((row) => row.system.id === stage.systemId);
    if (entry === undefined) {
      throw new Error("The entry is not in the event view");
    }
    return entry;
  };

  // Looks for a value anywhere in the database: every column of every row of
  // every table in the scratch schema, by casting each row to text.
  const storedAnywhere = async (value: string): Promise<string[]> => {
    const tables: { table_name: string }[] = await server.database
      .sql`select table_name from information_schema.tables
           where table_schema = ${server.database.schema}
             and table_type = 'BASE TABLE'
           order by table_name`;
    const found: string[] = [];
    for (const { table_name: name } of tables) {
      const rows: { hits: number }[] = await server.database.sql.unsafe(
        `select count(*)::int as hits from "${name}" as row where cast(row as text) like $1`,
        [`%${value}%`],
      );
      if ((rows[0]?.hits ?? 0) > 0) {
        found.push(name);
      }
    }
    return found;
  };

  // A conformant server ----------------------------------------------------

  // Acceptance scenario 1, and FR-029's minimum set: every check the profile
  // names is made against the endpoint, and each reports pass or fail.
  test("runs every check the profile names against the endpoint", async () => {
    const stage = await arrangeStage();

    const run = await reportOf(stage);

    expect(run.checks.map((check) => check.name)).toEqual([
      "validStatement",
      "tamperedSignature",
      "expiredStatement",
      "replayedStatement",
      "metadataFidelity",
      "statementOnly",
    ]);
    expect(failuresOf(run)).toEqual([]);
    expect(run.verdict).toBe("passed");
    // Five registration attempts: the valid one, its replay, the tampered one,
    // the expired one, and the one asserting metadata outside the statement.
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(5);
    for (const check of run.checks) {
      expect(check.title.length).toBeGreaterThan(0);
      expect(check.detail.length).toBeGreaterThan(0);
    }
  });

  // Acceptance scenario 1: the run is recorded with its time.
  test("records the run with its time", async () => {
    const stage = await arrangeStage();
    const before = Date.now();

    const run = await reportOf(stage);

    expect(Date.parse(run.ranAt)).toBeGreaterThanOrEqual(before - 1000);
    expect(Date.parse(run.ranAt)).toBeLessThanOrEqual(Date.now() + 1000);
    expect(run.enrolmentId).toBe(stage.enrolmentId);
  });

  // FR-030: the evidence. Each check carries the request that was made and the
  // response that came back, so the report can be argued with.
  test("records the request and the response behind each check", async () => {
    const stage = await arrangeStage();

    const run = await reportOf(stage);

    for (const check of run.checks) {
      expect(check.request.method).toBe("POST");
      expect(check.request.url).toBe("https://stub.example.org/register");
      expect(check.request.body["software_statement"]).toBeDefined();
      expect(check.response.status).toBeGreaterThan(0);
    }
    // The statement-only check is the one that asserts metadata outside the
    // signature, and the evidence shows what it asserted.
    expect(
      checkOf(run, "statementOnly").request.body["client_name"],
    ).toBeDefined();
  });

  // The report is public, so the statement in it is stripped of its signature:
  // the claims stay readable and the artefact registers nothing anywhere.
  test("records statements without their signatures", async () => {
    const stage = await arrangeStage();

    const run = await reportOf(stage);

    const presented = calls
      .filter((call) => call.method === "POST")
      .map((call) => member(sentBody(call.init), "software_statement"));
    for (const check of run.checks) {
      const recorded = String(check.request.body["software_statement"]);
      const [header, payload, signature] = recorded.split(".");
      expect(signature).toBe("[removed]");
      // The claims are the claims that were presented, so a reader can decode
      // exactly what Muster vouched for.
      expect(
        presented.some((jws) => jws.startsWith(`${header}.${payload}.`)),
      ).toBe(true);
    }
    // And no presented statement is recoverable from the record.
    for (const jws of presented) {
      expect(await storedAnywhere(jws.split(".")[2] ?? "")).toEqual([]);
    }
  });

  // The constitution: no credential is written down. The registration access
  // token is a credential, and it is shown as redacted rather than dropped, so
  // the report still says the server issued one.
  test("redacts the registration access token and stores it nowhere", async () => {
    const stage = await arrangeStage();

    const run = await reportOf(stage);

    expect(
      checkOf(run, "validStatement").response.body?.[
        "registration_access_token"
      ],
    ).toBe("[redacted]");
    expect(await storedAnywhere("rat-1")).toEqual([]);
  });

  // Acceptance scenario 2: a fully passing run shows as a verified badge with
  // its date on the entry in the event view.
  test("shows a passing run as a dated badge in the event view", async () => {
    const stage = await arrangeStage();
    const run = await reportOf(stage);

    const entry = await entryOf(stage);

    expect(entry.conformance).toEqual({
      runId: run.id,
      verdict: "passed",
      ranAt: run.ranAt,
    });
  });

  // Acceptance scenario 4: the throwaway client is deleted where the profile
  // allows, and the report says what happened to it.
  test("deletes the throwaway client it registered", async () => {
    const stage = await arrangeStage();

    const run = await reportOf(stage);

    expect(run.cleanup).toContain("Deleted stub-1");
    const deletions = calls.filter((call) => call.method === "DELETE");
    expect(deletions).toHaveLength(1);
    expect(deletions[0]?.url).toBe("https://stub.example.org/register/stub-1");
    // The server is holding nothing afterwards: the check is against the stub's
    // own list rather than against the harness's account of itself.
    expect([...held.keys()]).toEqual([]);
  });

  // The broken modes -------------------------------------------------------

  // The independent test for this story: a stub that skips signature validation
  // fails the tampered-statement check, and only that check.
  test("fails the tampered-signature check against a server that skips verification", async () => {
    const stage = await arrangeStage();
    mode = "skipSignature";

    const run = await reportOf(stage);

    expect(failuresOf(run)).toEqual(["tamperedSignature"]);
    expect(run.verdict).toBe("failed");
    // Acceptance scenario 3: the report names the failing behaviour.
    const failed = checkOf(run, "tamperedSignature");
    expect(failed.title).toContain("tampered signature");
    expect(failed.detail).toContain("accepted");
    expect(failed.detail).toContain("stub-2");
    expect(failed.response.status).toBe(201);
  });

  // Acceptance scenario 3: no badge is shown for a failing run.
  test("shows no badge for a failing run", async () => {
    const stage = await arrangeStage();
    mode = "skipSignature";
    const run = await reportOf(stage);

    const entry = await entryOf(stage);

    expect(entry.conformance?.verdict).toBe("failed");
    expect(entry.conformance?.runId).toBe(run.id);
  });

  // FR-030: the badge follows the latest run, so a server that passed and then
  // regressed loses it.
  test("replaces a passing badge when a later run fails", async () => {
    const stage = await arrangeStage();
    const passed = await reportOf(stage);
    expect((await entryOf(stage)).conformance?.verdict).toBe("passed");

    mode = "ignoreExpiry";
    const failed = await reportOf(stage);

    expect(failed.verdict).toBe("failed");
    const entry = await entryOf(stage);
    expect(entry.conformance?.verdict).toBe("failed");
    expect(entry.conformance?.runId).toBe(failed.id);
    expect(entry.conformance?.runId).not.toBe(passed.id);
    // The passing run is still there to be read: the history is what makes the
    // badge worth anything.
    const { runs } = await readJson(
      await request(
        server,
        "GET",
        `/api/enrolments/${stage.enrolmentId}/harness-runs`,
      ),
      harnessRunsResponseSchema,
    );
    expect(runs.map((run) => run.id)).toEqual([failed.id, passed.id]);
  });

  test("fails the expiry check against a server that ignores exp", async () => {
    const stage = await arrangeStage();
    mode = "ignoreExpiry";

    const run = await reportOf(stage);

    expect(failuresOf(run)).toEqual(["expiredStatement"]);
    expect(checkOf(run, "expiredStatement").detail).toContain("accepted");
  });

  test("fails the replay check against a server that spends a jti twice", async () => {
    const stage = await arrangeStage();
    mode = "allowReplay";

    const run = await reportOf(stage);

    expect(failuresOf(run)).toEqual(["replayedStatement"]);
    // The replayed statement is the same artefact as the valid one, which is
    // what makes it a replay rather than a second statement.
    expect(
      checkOf(run, "replayedStatement").request.body["software_statement"],
    ).toBe(checkOf(run, "validStatement").request.body["software_statement"]);
  });

  // RFC 7591 section 3.2.1: without the registered metadata in the response
  // there is no way to show the client created is the client vouched for.
  test("fails fidelity against a server that returns no metadata", async () => {
    const stage = await arrangeStage();
    mode = "bareResponse";

    const run = await reportOf(stage);

    expect(failuresOf(run)).toEqual(["metadataFidelity"]);
    expect(checkOf(run, "validStatement").outcome).toBe("passed");
    expect(checkOf(run, "metadataFidelity").detail).toContain("client_name");
    // The same response named no management address, so the client it created is
    // reported as left behind rather than silently abandoned.
    expect(run.cleanup).toContain("Left behind stub-1");
    expect(run.cleanup).toContain("registration_client_uri");
    expect(run.cleanup).toContain("by hand");
    expect([...held.keys()]).toEqual(["stub-1"]);
  });

  // The anchor vouches for the metadata, so nothing arriving unsigned may
  // override it.
  test("fails statement-only against a server that trusts the body", async () => {
    const stage = await arrangeStage();
    mode = "trustBody";

    const run = await reportOf(stage);

    expect(failuresOf(run)).toEqual(["statementOnly"]);
    expect(checkOf(run, "statementOnly").detail).toContain("client_name");
  });

  // The error vocabulary is a SHOULD. A server that refuses everything as
  // `invalid_request` is reported and keeps its badge.
  test("reports a vague error vocabulary as an advisory and still passes", async () => {
    const stage = await arrangeStage();
    mode = "vagueErrors";

    const run = await reportOf(stage);

    expect(failuresOf(run)).toEqual([]);
    expect(run.verdict).toBe("passed");
    expect(
      run.checks
        .filter((check) => check.outcome === "advisory")
        .map((check) => check.name),
    ).toEqual(["tamperedSignature", "expiredStatement", "replayedStatement"]);
    expect(checkOf(run, "tamperedSignature").detail).toContain("SHOULD");
    expect((await entryOf(stage)).conformance?.verdict).toBe("passed");
  });

  // A server that returns no RFC 7592 credentials is within the profile: the
  // client is reported as left behind, and the run still passes.
  test("reports a client left behind by a server with no deletion support", async () => {
    const stage = await arrangeStage();
    mode = "noCleanup";

    const run = await reportOf(stage);

    expect(run.verdict).toBe("passed");
    expect(run.cleanup).toContain("Left behind stub-1");
    expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(0);
    expect([...held.keys()]).toEqual(["stub-1"]);
  });

  // Reading the report -----------------------------------------------------

  // SC-005: a shareable report that needs a sign-in is not evidence.
  test("serves a report to an anonymous reader", async () => {
    const stage = await arrangeStage();
    const run = await reportOf(stage);

    const response = await request(
      server,
      "GET",
      `/api/harness-runs/${run.id}`,
    );

    expect(response.status).toBe(200);
    const report = await readJson(response, harnessRunResponseSchema);
    expect(report.run).toEqual(run);
    // The report names what it was a verdict about.
    expect(report.system.system.id).toBe(stage.systemId);
    expect(report.event.slug).toBe(stage.slug);
    // And it carries no contact detail, like every anonymous read (FR-007).
    expect(report.system.contacts).toBeUndefined();
  });

  test("answers a report that does not exist as not found", async () => {
    const response = await request(
      server,
      "GET",
      "/api/harness-runs/11111111-1111-4111-8111-111111111111",
    );

    expect(response.status).toBe(404);
  });

  // The runs list says whether the reader may add one, so the console can offer
  // the button to the people it would work for and explain itself to the rest.
  test("tells the entry's owner they may run one, and a stranger they may not", async () => {
    const stage = await arrangeStage();
    const stranger = await arrangeMember();

    const owner = await readJson(
      await request(
        server,
        "GET",
        `/api/enrolments/${stage.enrolmentId}/harness-runs`,
        { cookie: stage.owner.cookie },
      ),
      harnessRunsResponseSchema,
    );
    const anonymous = await readJson(
      await request(
        server,
        "GET",
        `/api/enrolments/${stage.enrolmentId}/harness-runs`,
      ),
      harnessRunsResponseSchema,
    );
    const other = await readJson(
      await request(
        server,
        "GET",
        `/api/enrolments/${stage.enrolmentId}/harness-runs`,
        { cookie: stranger.cookie },
      ),
      harnessRunsResponseSchema,
    );

    expect(owner.mayRun).toBe(true);
    expect(owner.runs).toEqual([]);
    expect(anonymous.mayRun).toBe(false);
    expect(other.mayRun).toBe(false);
  });

  test("answers an enrolment that does not exist as not found", async () => {
    const response = await request(
      server,
      "GET",
      "/api/enrolments/11111111-1111-4111-8111-111111111111/harness-runs",
    );

    expect(response.status).toBe(404);
  });

  // Who may run one --------------------------------------------------------

  test("refuses a run without a session", async () => {
    const stage = await arrangeStage();

    const response = await runHarness(stage, null);

    expect(response.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  // Nobody else may have Muster fire signed statements at somebody's endpoint.
  test("refuses a run by a member of another organisation", async () => {
    const stage = await arrangeStage();
    const stranger = await arrangeMember();

    const response = await runHarness(stage, stranger);

    expect(response.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  test("refuses a run by a revoked member", async () => {
    const stage = await arrangeStage();
    await updateAccountStatus(server.database.sql, {
      accountId: stage.owner.id,
      status: "revoked",
      decidedBy: admin.id,
      decidedAt: new Date(),
    });

    const response = await runHarness(stage);

    expect(response.status).toBe(403);
    const envelope = await readJson(response, errorEnvelopeSchema);
    expect(envelope.detail).toContain("revoked");
    expect(calls).toHaveLength(0);
  });

  // A server that registers clients by hand has no profile to prove.
  test("refuses a run against a manual-registration server", async () => {
    const stage = await arrangeStage("manual");

    const response = await runHarness(stage);

    expect(response.status).toBe(422);
    const envelope = await readJson(response, errorEnvelopeSchema);
    expect(envelope.detail).toContain("by hand");
    expect(calls).toHaveLength(0);
  });

  test("refuses a run once the event has closed", async () => {
    const stage = await arrangeStage();
    const closed = await request(
      server,
      "PATCH",
      `/api/admin/events/${stage.slug}`,
      { body: { status: "closed" }, cookie: admin.cookie },
    );
    expect(closed.status).toBe(200);

    const response = await runHarness(stage);

    expect(response.status).toBe(409);
    expect(calls).toHaveLength(0);
  });

  // FR-020: the guard is the only path to the network, and a target it refuses
  // is reported with its reason. Muster's own refusal is not the vendor's
  // failure, so no run is recorded and no badge is taken away.
  test("refuses a registration endpoint the address guard rejects", async () => {
    const stage = await arrangeStage("trustedDcr", "guarded.example.org");

    const response = await runHarness(stage);

    expect(response.status).toBe(422);
    const envelope = await readJson(response, errorEnvelopeSchema);
    expect(envelope.error).toBe("guarded");
    expect(envelope.detail).toContain("loopback");
    expect(calls).toHaveLength(0);
    const { runs } = await readJson(
      await request(
        server,
        "GET",
        `/api/enrolments/${stage.enrolmentId}/harness-runs`,
      ),
      harnessRunsResponseSchema,
    );
    expect(runs).toEqual([]);
    expect((await entryOf(stage)).conformance).toBeNull();
  });
});
