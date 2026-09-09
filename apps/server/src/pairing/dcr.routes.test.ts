/*
 * Copyright © 2026 Commonwealth Scientific and Industrial Research Organisation
 * (CSIRO) ABN 41 687 119 230. Licensed under the Apache License, Version 2.0.
 */

import {
  dcrRunResponseSchema,
  errorEnvelopeSchema,
  jwksSchema,
  pairingResponseSchema,
} from "@muster/contracts";
import { vouchingExpiresAt } from "@muster/core";
import { updateAccountStatus } from "@muster/db";
import { describeDatabase, uniqueName } from "@muster/db/test/harness";
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { decodeProtectedHeader, importJWK, jwtVerify } from "jose";

import {
  dayFromToday,
  readJson,
  request,
  signUpAndSignIn,
  startTestServer,
} from "../test/support.ts";

import type { SignedIn, TestServer } from "../test/support.ts";
import type { RegistrationFields } from "@muster/contracts";

/**
 * The trusted-DCR run: minting a statement, presenting it, and recording what
 * happened.
 *
 * This is the vouching action, so most of this suite is the deny-by-default
 * boundary and the no-stored-secrets rule. The registration endpoint is a stub
 * reached through the injected fetch, because the guard is the only path to the
 * network and a suite must not be one of the things it lets through.
 *
 * Three assertions carry the constitution directly. The request body is
 * statement-only, so nothing outside the signed artefact can assert client
 * metadata. The returned client secret appears in exactly one response and in no
 * table - asserted by scanning every row of every table in the schema for it,
 * rather than by checking the two columns somebody remembered. And the artefact a
 * member downloads is byte for byte the artefact Muster presented (FR-027).
 */

describeDatabase("the trusted registration routes", () => {
  let server: TestServer;
  let admin: SignedIn;

  /** What the stub registration endpoint answers next. */
  let answer: (url: string, init: RequestInit) => Response;

  /** Every request the run made to a participant's server. */
  let calls: { url: string; init: RequestInit }[] = [];

  beforeAll(async () => {
    server = await startTestServer("dcr", {
      // Every participant address in this suite resolves to a documentation
      // address, which the guard permits, so the guard is exercised rather than
      // bypassed.
      resolve: (host) =>
        Promise.resolve(
          host === "guarded.example.org" ? ["127.0.0.1"] : ["203.0.113.10"],
        ),
      fetchImplementation: (url, init) => {
        calls.push({ url, init });
        return Promise.resolve(answer(url, init));
      },
    });
    admin = await arrangeMember(true);
  });

  beforeEach(() => {
    calls = [];
    answer = () => registrationSuccess();
  });

  afterAll(async () => {
    await server.close();
  });

  // A server that registers the client and returns its metadata, per RFC 7591.
  function registrationSuccess(
    overrides: Record<string, unknown> = {},
  ): Response {
    return Response.json(
      {
        client_id: "stub-client-1",
        client_secret: "s3cret-from-the-server",
        client_name: "Smart Forms",
        redirect_uris: ["https://smartforms.example.org/callback"],
        grant_types: ["authorization_code", "refresh_token"],
        token_endpoint_auth_method: "none",
        registration_client_uri:
          "https://stub.example.org/register/stub-client-1",
        registration_access_token: "rat-1",
        ...overrides,
      },
      { status: 201 },
    );
  }

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

  /** The client the app owner enrols. */
  const clientProfile = {
    launchUrl: "https://smartforms.example.org/launch",
    redirectUris: ["https://smartforms.example.org/callback"],
    scopes: ["launch/patient", "patient/Observation.rs"],
    confidentiality: "public",
    launchContext: "patient",
    needsIntrospection: false,
  };

  /** The field set the pairing snapshots. */
  const registrationFields: RegistrationFields = {
    clientName: "Smart Forms",
    launchUrl: clientProfile.launchUrl,
    redirectUris: clientProfile.redirectUris,
    scopes: clientProfile.scopes,
    confidentiality: "public",
    launchContext: "patient",
    needsIntrospection: false,
  };

  /** The event's first day. */
  const startsOn = dayFromToday(-1);

  /** The event's last day, which caps every statement the suite mints. */
  const endsOn = dayFromToday(1);

  /** The grace period the seeded event allows beyond its last day. */
  const graceDays = 7;

  // A server profile with the registration mode and endpoint under test.
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

  /** Two organisations, an event, a pairing, and who owns which side. */
  type Stage = {
    /** the app owner, who drives the run */
    readonly appOwner: SignedIn;
    /** the server owner, who does nothing at all */
    readonly serverOwner: SignedIn;
    /** the pairing */
    readonly pairingId: string;
    /** the client system, whose identifier the statement vouches for */
    readonly clientSystemId: string;
    /** the event */
    readonly slug: string;
  };

  // Arranges an organisation, a system, an event, an enrolment on each side, and
  // a requested pairing between them.
  const arrangeStage = async (
    registrationMode = "trustedDcr",
    host = "stub.example.org",
  ): Promise<Stage> => {
    const appOwner = await arrangeMember();
    const serverOwner = await arrangeMember();
    const appOrganisationId = await idOf(
      await request(server, "POST", "/api/organisations", {
        body: { name: "CSIRO" },
        cookie: appOwner.cookie,
      }),
      "organisation",
    );
    const serverOrganisationId = await idOf(
      await request(server, "POST", "/api/organisations", {
        body: { name: "Stub Vendor" },
        cookie: serverOwner.cookie,
      }),
      "organisation",
    );
    const slug = uniqueName("event").replaceAll("_", "-");
    const created = await request(server, "POST", "/api/admin/events", {
      body: {
        slug,
        name: "Sparked connectathon",
        startsOn,
        endsOn,
        status: "open",
        capabilityTags: [],
        graceDays,
      },
      cookie: admin.cookie,
    });
    expect(created.status).toBe(201);

    const clientSystemId = await idOf(
      await request(
        server,
        "POST",
        `/api/organisations/${appOrganisationId}/systems`,
        {
          body: { name: "Smart Forms", description: "", clientProfile },
          cookie: appOwner.cookie,
        },
      ),
      "system",
    );
    const serverSystemId = await idOf(
      await request(
        server,
        "POST",
        `/api/organisations/${serverOrganisationId}/systems`,
        {
          body: {
            name: "Stub Auth",
            description: "",
            serverProfile: serverProfile(registrationMode, host),
          },
          cookie: serverOwner.cookie,
        },
      ),
      "system",
    );
    const clientEnrolmentId = await idOf(
      await request(server, "POST", `/api/events/${slug}/enrolments`, {
        body: { systemId: clientSystemId, tags: [] },
        cookie: appOwner.cookie,
      }),
      "enrolment",
    );
    const serverEnrolmentId = await idOf(
      await request(server, "POST", `/api/events/${slug}/enrolments`, {
        body: { systemId: serverSystemId, tags: [] },
        cookie: serverOwner.cookie,
      }),
      "enrolment",
    );
    const requested = await request(server, "POST", "/api/pairings", {
      body: {
        eventSlug: slug,
        clientEnrolmentId,
        serverEnrolmentId,
        registrationFields,
      },
      cookie: appOwner.cookie,
    });
    expect(requested.status).toBe(201);

    return {
      appOwner,
      serverOwner,
      pairingId: await idOf(requested, "pairing"),
      clientSystemId,
      slug,
    };
  };

  // Runs the registration as whoever is given, defaulting to the app owner.
  const runRegistration = async (
    stage: Stage,
    as: SignedIn = stage.appOwner,
  ): Promise<Response> =>
    request(server, "POST", `/api/pairings/${stage.pairingId}/register`, {
      body: {},
      cookie: as.cookie,
    });

  // Reads what the run posted to the participant's server. The body is always a
  // string, because the run always sends JSON it rendered itself.
  const presentedBody = (): Record<string, string> => {
    const body = calls.at(-1)?.init.body;
    const parsed: unknown = JSON.parse(
      typeof body === "string" ? body : "null",
    );
    return (parsed ?? {}) as Record<string, string>;
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

  // Minting and presenting -------------------------------------------------

  // The profile's request shape: statement only, so a server has one source of
  // truth for the metadata and nothing outside the signature can override it.
  test("presents a statement-only body to the server's registration endpoint", async () => {
    const stage = await arrangeStage();

    const response = await runRegistration(stage);

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://stub.example.org/register");
    expect(calls[0]?.init.method).toBe("POST");
    expect(Object.keys(presentedBody())).toEqual(["software_statement"]);
  });

  // Acceptance scenario 1: the claims are the vetted metadata, the event, and an
  // expiry no later than the event's end plus its grace period.
  test("mints a statement carrying the vetted metadata and a capped expiry", async () => {
    const stage = await arrangeStage();

    const response = await runRegistration(stage);

    const { statement } = await readJson(response, dcrRunResponseSchema);
    expect(statement.claims.iss).toBe(server.config.publicUrl);
    expect(statement.claims.sub).toBe(stage.clientSystemId);
    expect(statement.claims.muster_event).toBe(stage.slug);
    expect(statement.claims.client_name).toBe("Smart Forms");
    expect(statement.claims.redirect_uris).toEqual(clientProfile.redirectUris);
    expect(statement.claims.scope).toBe(
      "launch/patient patient/Observation.rs",
    );
    expect(statement.claims.token_endpoint_auth_method).toBe("none");
    expect(statement.claims.smart_launch_url).toBe(clientProfile.launchUrl);
    expect(statement.claims.exp).toBe(
      Math.floor(vouchingExpiresAt({ endsOn, graceDays }).getTime() / 1000),
    );
    expect(statement.expiresAt).toBe(
      vouchingExpiresAt({ endsOn, graceDays }).toISOString(),
    );
  });

  // The signed artefact is what the server checks, so the claims Muster reports
  // are the claims it signed, and the signature verifies against the published
  // JWKS by `kid` (the profile's first validation rule).
  test("signs the statement with a published key", async () => {
    const stage = await arrangeStage();

    const response = await runRegistration(stage);

    const { statement } = await readJson(response, dcrRunResponseSchema);
    const presented = presentedBody()["software_statement"] ?? "";
    expect(decodeProtectedHeader(presented)).toEqual({
      alg: "ES256",
      kid: statement.keyId,
      typ: "JWT",
    });

    const published = await readJson(
      await request(server, "GET", "/.well-known/jwks.json"),
      jwksSchema,
    );
    const key = published.keys.find(
      (candidate) => candidate.kid === statement.keyId,
    );
    expect(key?.muster_purpose).toBe("statements");
    const verified = await jwtVerify(presented, await importJWK({ ...key }));
    expect(verified.payload).toEqual({ ...statement.claims });
  });

  // Acceptance scenario 2: the pairing is fulfilled with the identifier the
  // server issued, and the server's organisation is told that it happened.
  test("fulfils the pairing with the identifier the server issued", async () => {
    const stage = await arrangeStage();

    const response = await runRegistration(stage);

    const run = await readJson(response, dcrRunResponseSchema);
    expect(run.clientId).toBe("stub-client-1");
    expect(run.pairing.state).toBe("fulfilled");
    expect(run.pairing.clientId).toBe("stub-client-1");
    expect(run.steps.map((step) => step.outcome)).toEqual([
      "succeeded",
      "succeeded",
      "succeeded",
    ]);
    expect(run.registeredMetadata).toMatchObject({
      client_name: "Smart Forms",
    });
    expect(run.serverError).toBeNull();

    // The timeline records the run as the client's own action.
    const last = run.pairing.timeline.at(-1);
    expect(last?.fromState).toBe("requested");
    expect(last?.toState).toBe("fulfilled");
    expect(last?.detail.clientId).toBe("stub-client-1");
    expect(last?.actingFor?.name).toBe("CSIRO");

    const notification = server.sentMail.at(-1) ?? "";
    expect(notification).toContain(`To: ${stage.serverOwner.email}`);
    expect(notification).toContain("Stub Auth");
    expect(notification).toContain("stub-client-1");
  });

  // The constitution: the secret is shown once and stored nowhere.
  test("returns the client secret exactly once and stores it nowhere", async () => {
    const stage = await arrangeStage();

    const response = await runRegistration(stage);

    const run = await readJson(response, dcrRunResponseSchema);
    expect(run.clientSecret).toBe("s3cret-from-the-server");

    // Nowhere in the database: not in the statement, not on the pairing, not in
    // the timeline, not anywhere else either.
    expect(await storedAnywhere("s3cret-from-the-server")).toEqual([]);

    // And not in the record either party reads afterwards.
    const reread = await request(
      server,
      "GET",
      `/api/pairings/${stage.pairingId}`,
      { cookie: stage.appOwner.cookie },
    );
    expect(await reread.text()).not.toContain("s3cret-from-the-server");
  });

  // A public client is issued no secret, and the run says so rather than
  // implying one was lost.
  test("reports no secret when the server issues none", async () => {
    const stage = await arrangeStage();
    answer = () => registrationSuccess({ client_secret: undefined });

    const run = await readJson(
      await runRegistration(stage),
      dcrRunResponseSchema,
    );

    expect(run.clientSecret).toBeUndefined();
    expect(run.pairing.state).toBe("fulfilled");
  });

  // Failure ----------------------------------------------------------------

  // Acceptance scenario 3: the pairing records the failure with the server's own
  // error, which is what the app owner has to act on.
  test("records a rejection as a failure carrying the server's error", async () => {
    const stage = await arrangeStage();
    answer = () =>
      Response.json(
        {
          error: "invalid_client_metadata",
          error_description: "redirect_uri must not be a loopback address",
        },
        { status: 400 },
      );

    const run = await readJson(
      await runRegistration(stage),
      dcrRunResponseSchema,
    );

    expect(run.pairing.state).toBe("failed");
    expect(run.clientId).toBeNull();
    expect(run.serverError?.error).toBe("invalid_client_metadata");
    expect(run.serverError?.errorDescription).toContain("loopback");
    expect(run.steps.map((step) => step.outcome)).toEqual([
      "succeeded",
      "failed",
      "succeeded",
    ]);
    expect(run.steps[1]?.detail).toContain("invalid_client_metadata");

    // Both parties can read what went wrong, in the timeline.
    const last = run.pairing.timeline.at(-1);
    expect(last?.toState).toBe("failed");
    expect(last?.detail.reason).toContain("invalid_client_metadata");
  });

  // A server that answers with something other than the profile's error shape is
  // still reported: the status and what it said, rather than a shrug.
  test("records an unparseable rejection with what the server said", async () => {
    const stage = await arrangeStage();
    answer = () =>
      new Response("<html>gateway timeout</html>", { status: 504 });

    const run = await readJson(
      await runRegistration(stage),
      dcrRunResponseSchema,
    );

    expect(run.pairing.state).toBe("failed");
    expect(run.serverError?.error).toBe("http_504");
    expect(run.steps[1]?.detail).toContain("504");
  });

  // A server that accepts the statement but names no client identifier has not
  // registered anything Muster can record, so the run fails rather than
  // inventing one.
  test("records a success with no client identifier as a failure", async () => {
    const stage = await arrangeStage();
    answer = () =>
      Response.json({ client_name: "Smart Forms" }, { status: 201 });

    const run = await readJson(
      await runRegistration(stage),
      dcrRunResponseSchema,
    );

    expect(run.pairing.state).toBe("failed");
    expect(run.serverError?.error).toBe("invalid_response");
  });

  // The owner fixes their server and runs it again: the retry the data model
  // states, then a fresh attempt, both on the timeline.
  test("retries a failed pairing and presents a fresh statement", async () => {
    const stage = await arrangeStage();
    answer = () => Response.json({ error: "invalid_request" }, { status: 400 });
    const failed = await readJson(
      await runRegistration(stage),
      dcrRunResponseSchema,
    );
    answer = () => registrationSuccess();

    const run = await readJson(
      await runRegistration(stage),
      dcrRunResponseSchema,
    );

    expect(run.pairing.state).toBe("fulfilled");
    expect(run.statement.jti).not.toBe(failed.statement.jti);
    expect(run.pairing.timeline.map((entry) => entry.toState)).toEqual([
      "requested",
      "failed",
      "requested",
      "fulfilled",
    ]);
  });

  // The guard is the only path to the network, and a target it refuses is
  // reported with its reason rather than attempted (FR-020).
  test("refuses a registration endpoint the address guard rejects", async () => {
    const stage = await arrangeStage("trustedDcr", "guarded.example.org");

    const response = await runRegistration(stage);

    expect(response.status).toBe(422);
    const envelope = await readJson(response, errorEnvelopeSchema);
    expect(envelope.error).toBe("guarded");
    expect(envelope.detail).toContain("loopback");
    expect(calls).toHaveLength(0);

    // Muster's own refusal is not the server's failure, so the request stands.
    const reread = await readJson(
      await request(server, "GET", `/api/pairings/${stage.pairingId}`, {
        cookie: stage.appOwner.cookie,
      }),
      pairingResponseSchema,
    );
    expect(reread.pairing.state).toBe("requested");
  });

  // Who may run it ---------------------------------------------------------

  // FR-026: the app's owner initiates. The server's organisation has already
  // consented by publishing a registration endpoint.
  test("refuses a run by the server's organisation", async () => {
    const stage = await arrangeStage();

    const response = await runRegistration(stage, stage.serverOwner);

    expect(response.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  // Acceptance scenario 4: a revoked membership mints nothing.
  test("refuses a run by a revoked member", async () => {
    const stage = await arrangeStage();
    await updateAccountStatus(server.database.sql, {
      accountId: stage.appOwner.id,
      status: "revoked",
      decidedBy: admin.id,
      decidedAt: new Date(),
    });

    const response = await runRegistration(stage);

    expect(response.status).toBe(403);
    const envelope = await readJson(response, errorEnvelopeSchema);
    expect(envelope.detail).toContain("revoked");
    expect(calls).toHaveLength(0);
  });

  test("refuses a run by a member of neither organisation", async () => {
    const stage = await arrangeStage();
    const stranger = await arrangeMember();

    const response = await runRegistration(stage, stranger);

    expect(response.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  test("refuses a run without a session", async () => {
    const stage = await arrangeStage();

    const response = await request(
      server,
      "POST",
      `/api/pairings/${stage.pairingId}/register`,
      { body: {} },
    );

    expect(response.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  // A server that registers clients by hand has not asked to be trusted.
  test("refuses a run against a manual-registration server", async () => {
    const stage = await arrangeStage("manual");

    const response = await runRegistration(stage);

    expect(response.status).toBe(422);
    const envelope = await readJson(response, errorEnvelopeSchema);
    expect(envelope.detail).toContain("by hand");
    expect(calls).toHaveLength(0);
  });

  // A pairing that has already been registered is not registered again: which
  // identifier would be the current one?
  test("refuses a second run on a fulfilled pairing", async () => {
    const stage = await arrangeStage();
    expect((await runRegistration(stage)).status).toBe(200);

    const response = await runRegistration(stage);

    expect(response.status).toBe(409);
    expect(calls).toHaveLength(1);
  });

  // FR-011: a closed event vouches for nothing.
  test("refuses a run once the event has closed", async () => {
    const stage = await arrangeStage();
    const closed = await request(
      server,
      "PATCH",
      `/api/admin/events/${stage.slug}`,
      { body: { status: "closed" }, cookie: admin.cookie },
    );
    expect(closed.status).toBe(200);

    const response = await runRegistration(stage);

    expect(response.status).toBe(409);
    expect(calls).toHaveLength(0);
  });

  // Downloading ------------------------------------------------------------

  // FR-027: the same artefact, byte for byte, for a member registering by hand.
  test("hands back the identical statement for out-of-band registration", async () => {
    const stage = await arrangeStage();
    await runRegistration(stage);
    const presented = presentedBody()["software_statement"] ?? "";

    const response = await request(
      server,
      "GET",
      `/api/pairings/${stage.pairingId}/statement`,
      { cookie: stage.appOwner.cookie },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/jwt");
    expect(await response.text()).toBe(presented);
  });

  // Both parties may read what was vouched for; neither may read it anonymously,
  // because the field set it carries is the pairing's, not the public record's.
  test("lets the server's organisation download the statement too", async () => {
    const stage = await arrangeStage();
    await runRegistration(stage);

    const response = await request(
      server,
      "GET",
      `/api/pairings/${stage.pairingId}/statement`,
      { cookie: stage.serverOwner.cookie },
    );

    expect(response.status).toBe(200);
  });

  test("refuses a statement download without a session", async () => {
    const stage = await arrangeStage();
    await runRegistration(stage);

    const response = await request(
      server,
      "GET",
      `/api/pairings/${stage.pairingId}/statement`,
    );

    expect(response.status).toBe(401);
  });

  // A pairing that has never been registered has no statement to hand over, and
  // says so rather than answering with an empty body.
  test("answers a download with no statement as not found", async () => {
    const stage = await arrangeStage();

    const response = await request(
      server,
      "GET",
      `/api/pairings/${stage.pairingId}/statement`,
      { cookie: stage.appOwner.cookie },
    );

    expect(response.status).toBe(404);
  });

  // The pairing carries its newest statement, so the console can offer the
  // download after the run's own answer is long gone - without the secret.
  test("carries the newest statement on the pairing both parties read", async () => {
    const stage = await arrangeStage();
    const run = await readJson(
      await runRegistration(stage),
      dcrRunResponseSchema,
    );

    const reread = await readJson(
      await request(server, "GET", `/api/pairings/${stage.pairingId}`, {
        cookie: stage.serverOwner.cookie,
      }),
      pairingResponseSchema,
    );

    expect(reread.pairing.statement?.jti).toBe(run.statement.jti);
    expect(reread.pairing.statement?.downloadPath).toBe(
      `/api/pairings/${stage.pairingId}/statement`,
    );
  });
});
