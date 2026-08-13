/**
 * That the harness proves what it claims to prove, and keeps only what it may.
 *
 * The counterparty here is a registration server implemented inside this suite: it applies the
 * profile's rules, it verifies signatures against the application's own published JWKS, and it
 * can be told to break exactly one rule at a time - the same five switches
 * `deploy/stubs/registerServer.ts` carries, so that the mapping this suite asserts is the
 * mapping the live stub demonstrates. A check that has never gone red is not evidence, so
 * every broken mode is exercised and each is asserted to fail *the check it should* rather
 * than merely to fail something.
 *
 * It is an injected `fetchImpl` rather than a socket for the two things a live stub cannot
 * make easy: what Muster *sent* (the statement is described in the evidence, never
 * reproduced), and what Muster *kept* afterwards (nothing resembling the client secret,
 * anywhere in the database - constitution principle IV). The live stub over a real socket is
 * quickstart scenario 4's job.
 *
 * Author: John Grimes
 */

import {
  findStoredValue,
  hasTestDatabase,
  makeEvent,
  makeOrganisation,
  makeSystem,
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
import { compactVerify, createLocalJWKSet } from "jose";

import { apiJson, apiRequest } from "../test/api.js";
import { createTestStack } from "../test/harness.js";

import type { OutboundFetchImpl } from "../outbound/outboundFetch.js";
import type { TestStack } from "../test/harness.js";
import type {
  EnrolledSystem,
  EnrolledSystemDetail,
  HarnessCheckName,
  HarnessRunResult,
  HarnessRuns,
  HarnessRunView,
} from "@muster/contracts";
import type { JSONWebKeySet } from "jose";

/** Where the stub's registration endpoint lives. Public-looking, so the guard admits it. */
const REGISTRATION_ENDPOINT = "https://stub.example.org/register";

/** The secret the stub issues for a confidential client. Distinct per run of this suite. */
const STUB_SECRET = `stub-secret-${uniqueSuffix()}`;

/** A rule the stub can be told to break, named as `deploy/stubs/registerServer.ts` names it. */
type BrokenMode =
  | "skip-signature"
  | "allow-replay"
  | "ignore-expiry"
  | "accept-outside-metadata"
  | "vague-errors";

/** How the stub should misbehave beyond the profile's own rules. */
interface StubBehaviour {
  readonly broken?: readonly BrokenMode[];
  /** Nothing answers at all. */
  readonly silent?: boolean;
  /** No `registration_client_uri`, so the harness has no way to delete what it made. */
  readonly noClientConfiguration?: boolean;
  /** A 201 carrying only an identifier, echoing none of the registered metadata. */
  readonly noMetadataEcho?: boolean;
}

/** A client the stub registered. */
interface StubClient {
  readonly clientId: string;
  readonly claims: Readonly<Record<string, unknown>>;
}

/** The stub, and the levers a case pulls. */
interface Stub {
  readonly requests: { method: string; url: string; body: string }[];
  readonly clients: Map<string, StubClient>;
  behaviour: StubBehaviour;
  readonly fetchImpl: OutboundFetchImpl;
  readonly reset: (behaviour?: StubBehaviour) => void;
}

/** A string member of a claim set, or undefined. */
function stringClaim(
  claims: Readonly<Record<string, unknown>>,
  name: string,
): string | undefined {
  const value = claims[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** An RFC 7591 error response. */
function refuse(stub: Stub, error: string, description: string): Response {
  return Response.json(
    {
      error: (stub.behaviour.broken ?? []).includes("vague-errors")
        ? "invalid_request"
        : error,
      error_description: description,
    },
    { status: 400, headers: { "content-type": "application/json" } },
  );
}

/**
 * A registration server that applies the profile.
 *
 * @param jwks - How to read the anchor's published keys.
 * @param clock - The same clock the application reads, so that a suite which pins the time
 *   pins it for both sides of the exchange. A stub judging expiry by the wall clock would
 *   call a statement current because the suite's pinned "now" is in the future.
 * @returns The stub.
 */
function createStub(
  jwks: () => Promise<JSONWebKeySet>,
  clock: () => Date,
): Stub {
  const stub: Stub = {
    requests: [],
    clients: new Map(),
    behaviour: {},
    reset: (behaviour = {}) => {
      stub.behaviour = behaviour;
      stub.requests.length = 0;
      stub.clients.clear();
      used.clear();
    },
    fetchImpl: async (input, init) => await handle(input, init),
  };
  const used = new Set<string>();

  /** Verifies a statement, or says why it will not. */
  async function verify(
    jws: string,
  ): Promise<Readonly<Record<string, unknown>> | undefined> {
    const parts = jws.split(".");
    if (parts.length !== 3) {
      return undefined;
    }
    const claims = JSON.parse(
      Buffer.from(parts[1] ?? "", "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    if ((stub.behaviour.broken ?? []).includes("skip-signature")) {
      // The deliberate break: the claims are read and the signature is never checked.
      return claims;
    }
    try {
      await compactVerify(jws, createLocalJWKSet(await jwks()));
    } catch {
      return undefined;
    }
    return claims;
  }

  /** Handles `POST /register`, in the order the profile lists its rules. */
  async function register(body: string): Promise<Response> {
    const broken = stub.behaviour.broken ?? [];
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const jws = parsed["software_statement"];
    if (typeof jws !== "string") {
      return refuse(stub, "invalid_request", "software_statement is required");
    }
    if (
      !broken.includes("accept-outside-metadata") &&
      Object.keys(parsed).some((member) => member !== "software_statement")
    ) {
      return refuse(
        stub,
        "invalid_request",
        "this server takes client metadata only from the software statement",
      );
    }

    const verified = await verify(jws);
    if (verified === undefined) {
      return refuse(
        stub,
        "invalid_software_statement",
        "the signature does not verify against the anchor's keys",
      );
    }
    const now = Math.floor(clock().getTime() / 1000);
    const exp = verified["exp"];
    if (
      !broken.includes("ignore-expiry") &&
      (typeof exp !== "number" || exp <= now)
    ) {
      return refuse(
        stub,
        "invalid_software_statement",
        "the software statement has expired",
      );
    }
    const jti = stringClaim(verified, "jti") ?? "";
    if (!broken.includes("allow-replay") && used.has(jti)) {
      return refuse(
        stub,
        "invalid_software_statement",
        "this statement identifier has already been used",
      );
    }
    used.add(jti);

    // Metadata from outside the statement wins when the stub is told to honour it, which is
    // the whole of that break: a client whose redirect URI came from the request body.
    const outside = broken.includes("accept-outside-metadata")
      ? Object.fromEntries(
          Object.entries(parsed).filter(
            ([member]) => member !== "software_statement",
          ),
        )
      : {};
    const claims = { ...verified, ...outside };
    const clientId = `stub-${String(stub.clients.size + 1)}-${uniqueSuffix()}`;
    stub.clients.set(clientId, { clientId, claims });

    return Response.json(
      {
        client_id: clientId,
        client_id_issued_at: now,
        ...(stringClaim(claims, "token_endpoint_auth_method") ===
        "client_secret_basic"
          ? { client_secret: STUB_SECRET, client_secret_expires_at: 0 }
          : {}),
        ...(stub.behaviour.noMetadataEcho === true
          ? {}
          : {
              client_name: claims["client_name"],
              redirect_uris: claims["redirect_uris"],
              grant_types: claims["grant_types"],
              token_endpoint_auth_method: claims["token_endpoint_auth_method"],
              scope: claims["scope"],
              software_id: claims["software_id"],
            }),
        ...(stub.behaviour.noClientConfiguration === true
          ? {}
          : {
              registration_client_uri: `https://stub.example.org/clients/${clientId}`,
              registration_access_token: `rat-${clientId}`,
            }),
      },
      { status: 201, headers: { "content-type": "application/json" } },
    );
  }

  /** Routes one request. */
  async function handle(input: URL, init: RequestInit): Promise<Response> {
    const body = typeof init.body === "string" ? init.body : "";
    stub.requests.push({
      method: init.method ?? "GET",
      url: input.href,
      body,
    });
    if (stub.behaviour.silent === true) {
      throw new Error("connect ECONNREFUSED");
    }
    if (init.method === "POST" && input.pathname === "/register") {
      return await register(body);
    }
    const client = /^\/clients\/([^/]+)$/.exec(input.pathname);
    if (client !== null && init.method === "DELETE") {
      return new Response(null, {
        status: stub.clients.delete(client[1] ?? "") ? 204 : 404,
      });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  return stub;
}

describe.skipIf(!hasTestDatabase())("the conformance harness", () => {
  let stack: TestStack;
  let stub: Stub;
  /** The time both sides read. `createTestStack` starts its own clock here. */
  let now = new Date("2026-09-01T10:00:00.000Z");

  /** Pins the clock for the application and for the stub at once. */
  function pinNow(at: Date): void {
    now = at;
    stack.setNow(at);
  }

  beforeAll(async () => {
    stub = createStub(
      async () => {
        const response = await apiRequest(
          stack,
          "GET",
          "/.well-known/jwks.json",
        );
        return (await response.json()) as JSONWebKeySet;
      },
      () => now,
    );
    stack = await createTestStack({
      outbound: {
        fetchImpl: async (input, init) => await stub.fetchImpl(input, init),
        // Every host resolves to a routable address, so the guard's own checks are what is
        // under test rather than DNS.
        resolve: async () => await Promise.resolve(["93.184.216.34"]),
      },
    });
  });

  afterAll(async () => {
    await stack.close();
  });

  beforeEach(() => {
    stub.reset();
    // Every case starts from the same time. A case that depends on where the previous one
    // left the clock is a case that fails when it is run on its own.
    pinNow(new Date("2026-09-01T10:00:00.000Z"));
  });

  /** A server owner with a trusted-DCR entry enrolled in an open event. */
  async function arrange(
    overrides: {
      readonly registrationMode?: "open" | "manual" | "trustedDcr";
      readonly registrationEndpoint?: string | null;
    } = {},
  ) {
    const owner = await stack.makeMember({ displayName: "Sam Ito" });
    const cookie = await stack.signIn(owner.email);
    const event = await makeEvent(stack.db, {
      slug: `harness-${uniqueSuffix()}`,
      status: "open",
      endsOn: "2026-09-19",
      graceDays: 7,
    });
    const organisation = await makeOrganisation(
      stack.db,
      owner.id,
      `Stub Vendor ${uniqueSuffix()}`,
    );
    const system = await makeSystem(stack.db, organisation.id, {
      name: "Stub Auth",
      serverProfile: serverProfileFixture({
        registrationMode: overrides.registrationMode ?? "trustedDcr",
        registrationEndpoint:
          overrides.registrationEndpoint === undefined
            ? REGISTRATION_ENDPOINT
            : overrides.registrationEndpoint,
      }),
    });
    const enrolled = await apiJson<{ enrolment: { id: string } }>(
      stack,
      "POST",
      `/api/events/${event.slug}/enrolments`,
      { cookie, body: { systemId: system.id, tags: [] } },
      201,
    );

    return {
      cookie,
      owner,
      event,
      systemId: system.id,
      enrolmentId: enrolled.enrolment.id,
    };
  }

  /** Runs the harness as the entry's owner. */
  async function run(
    enrolmentId: string,
    cookie: string,
  ): Promise<HarnessRunResult> {
    return await apiJson<HarnessRunResult>(
      stack,
      "POST",
      `/api/enrolments/${enrolmentId}/harness-runs`,
      { cookie },
    );
  }

  /** The outcome of each check, in the order the run reports them. */
  function outcomes(recorded: HarnessRunView): Record<string, string> {
    return Object.fromEntries(
      recorded.checks.map((check) => [check.name, check.outcome]),
    );
  }

  /** One enrolled system, as the public event listing shows it. */
  async function publicEntry(
    slug: string,
    systemId: string,
  ): Promise<EnrolledSystem> {
    const listing = await apiJson<{ systems: EnrolledSystem[] }>(
      stack,
      "GET",
      `/api/events/${slug}/systems`,
    );
    const found = listing.systems.find((entry) => entry.systemId === systemId);
    if (found === undefined) {
      throw new Error("the enrolled system is missing from the public listing");
    }
    return found;
  }

  describe("against a conformant server", () => {
    it("runs every check FR-029 names and records the run with its time", async () => {
      const { cookie, enrolmentId } = await arrange();
      pinNow(new Date("2026-09-02T14:31:00.000Z"));

      const result = await run(enrolmentId, cookie);

      expect(result.run.verdict).toBe("passed");
      expect(result.run.checks.map((check) => check.name)).toEqual([
        "valid-statement",
        "tampered-signature",
        "expired-statement",
        "replayed-statement",
        "metadata-fidelity",
        "statement-only",
      ]);
      expect(
        result.run.checks.every((check) => check.outcome === "passed"),
      ).toBe(true);
      expect(result.run.ranAt).toBe("2026-09-02T14:31:00.000Z");
      expect(result.run.registrationEndpoint).toBe(REGISTRATION_ENDPOINT);
    });

    it("carries the request and response evidence of every check (scenario 1)", async () => {
      const { cookie, enrolmentId } = await arrange();

      const result = await run(enrolmentId, cookie);

      for (const check of result.run.checks) {
        expect(check.request.url).toBe(REGISTRATION_ENDPOINT);
        expect(check.request.method).toBe("POST");
        expect(check.response).not.toBeNull();
        expect(check.detail.length).toBeGreaterThan(0);
      }
      // The statement is described rather than reproduced: a valid one names no audience, so
      // publishing it would let anybody register a client at any server that trusts Muster.
      expect(JSON.stringify(result.run.checks)).not.toContain("eyJ");
    });

    it("presents exactly the profile's five cases, statement-only but for one", async () => {
      const { cookie, enrolmentId } = await arrange();

      await run(enrolmentId, cookie);

      const posts = stub.requests.filter(
        (request) => request.method === "POST",
      );
      expect(posts).toHaveLength(5);
      const bodies = posts.map(
        (request) => JSON.parse(request.body) as Record<string, unknown>,
      );
      // Four statement-only bodies, and one that deliberately asserts metadata outside the
      // statement so that honouring it is detectable.
      expect(
        bodies.filter((body) => Object.keys(body).length === 1),
      ).toHaveLength(4);
      const outside = bodies.find((body) => Object.keys(body).length > 1);
      expect(Object.keys(outside ?? {})).toContain("client_name");
      // The replay presents the identifier the first exchange consumed, not a fresh one.
      expect(bodies[0]?.["software_statement"]).toBe(
        bodies[3]?.["software_statement"],
      );
    });

    it("deletes the throwaway clients and says so (scenario 4)", async () => {
      const { cookie, enrolmentId } = await arrange();

      const result = await run(enrolmentId, cookie);

      expect(stub.clients.size).toBe(0);
      expect(result.run.cleanup).toContain("Deleted");
      expect(stub.requests.some((request) => request.method === "DELETE")).toBe(
        true,
      );
    });

    it("reports what it left behind when the profile gives it no way to delete", async () => {
      const { cookie, enrolmentId } = await arrange();
      stub.reset({ noClientConfiguration: true });

      const result = await run(enrolmentId, cookie);

      // RFC 7592's client configuration endpoint is how a client is deleted. Without it the
      // harness cannot clean up, and the report says which client is still there.
      expect(result.run.cleanup).toContain("left behind");
      expect(stub.clients.size).toBeGreaterThan(0);
      const leftBehind = [...stub.clients.keys()][0] ?? "";
      expect(result.run.cleanup).toContain(leftBehind);
      expect(result.run.verdict).toBe("passed");
    });
  });

  describe("the DCR-verified badge", () => {
    it("appears on the event entry with the run date (FR-030, scenario 2)", async () => {
      const { cookie, enrolmentId, event, systemId } = await arrange();
      pinNow(new Date("2026-09-03T09:00:00.000Z"));

      await run(enrolmentId, cookie);

      const entry = await publicEntry(event.slug, systemId);
      expect(entry.dcrVerified?.verifiedAt).toBe("2026-09-03T09:00:00.000Z");
      // Readable without an account: the badge is a public claim (principle V).
      const detail = await apiJson<{ system: EnrolledSystemDetail }>(
        stack,
        "GET",
        `/api/events/${event.slug}/systems/${systemId}`,
      );
      expect(detail.system.dcrVerified).not.toBeNull();
    });

    it("is absent before anything has run", async () => {
      const { event, systemId } = await arrange();

      const entry = await publicEntry(event.slug, systemId);

      // An absence rather than a failure: a server nobody has tested has not failed.
      expect(entry.dcrVerified).toBeNull();
    });

    it("disappears when a later run fails (FR-030, scenario 3)", async () => {
      const { cookie, enrolmentId, event, systemId } = await arrange();
      pinNow(new Date("2026-09-05T09:00:00.000Z"));
      const passing = await run(enrolmentId, cookie);
      expect(passing.run.verdict).toBe("passed");
      expect(
        (await publicEntry(event.slug, systemId)).dcrVerified,
      ).not.toBeNull();

      stub.reset({ broken: ["skip-signature"] });
      pinNow(new Date("2026-09-05T11:00:00.000Z"));
      const failing = await run(enrolmentId, cookie);

      expect(failing.run.verdict).toBe("failed");
      // The latest run decides. An earlier pass does not survive a later failure.
      expect((await publicEntry(event.slug, systemId)).dcrVerified).toBeNull();
      const detail = await apiJson<{ system: EnrolledSystemDetail }>(
        stack,
        "GET",
        `/api/events/${event.slug}/systems/${systemId}`,
      );
      expect(detail.system.dcrVerified).toBeNull();
    });
  });

  describe("against a server that breaks one rule", () => {
    /** Each broken mode, and the check it must break. */
    const mapping: readonly {
      readonly mode: BrokenMode;
      readonly fails: HarnessCheckName | null;
    }[] = [
      { mode: "skip-signature", fails: "tampered-signature" },
      { mode: "allow-replay", fails: "replayed-statement" },
      { mode: "ignore-expiry", fails: "expired-statement" },
      { mode: "accept-outside-metadata", fails: "statement-only" },
      // A SHOULD rather than a MUST: the profile asks servers to distinguish their error
      // codes, so this is reported as an advisory and does not remove the badge.
      { mode: "vague-errors", fails: null },
    ];

    for (const { mode, fails } of mapping) {
      it(`fails ${fails ?? "no check"} and nothing else when the server is ${mode}`, async () => {
        const { cookie, enrolmentId } = await arrange();
        stub.reset({ broken: [mode] });

        const result = await run(enrolmentId, cookie);

        const failed = result.run.checks
          .filter((check) => check.outcome === "failed")
          .map((check) => check.name);
        expect(failed).toEqual(fails === null ? [] : [fails]);
        expect(result.run.verdict).toBe(fails === null ? "passed" : "failed");
      });
    }

    it("says what the server did wrong, in the failing check's own words", async () => {
      const { cookie, enrolmentId } = await arrange();
      stub.reset({ broken: ["skip-signature"] });

      const result = await run(enrolmentId, cookie);

      const tampered = result.run.checks.find(
        (check) => check.name === "tampered-signature",
      );
      expect(tampered?.outcome).toBe("failed");
      expect(tampered?.detail).toContain("signature");
      // The valid case still passes: the run distinguishes a server that accepts everything
      // from one that accepts nothing.
      expect(outcomes(result.run)["valid-statement"]).toBe("passed");
    });

    it("advises on the error vocabulary without failing the run", async () => {
      const { cookie, enrolmentId } = await arrange();
      stub.reset({ broken: ["vague-errors"] });

      const result = await run(enrolmentId, cookie);

      const advisories = result.run.checks.flatMap((check) => check.advisories);
      expect(advisories.join(" ")).toContain("invalid_software_statement");
      expect(result.run.verdict).toBe("passed");
    });

    it("fails fidelity when the response echoes no registered metadata", async () => {
      const { cookie, enrolmentId } = await arrange();
      stub.reset({ noMetadataEcho: true });

      const result = await run(enrolmentId, cookie);

      expect(outcomes(result.run)["metadata-fidelity"]).toBe("failed");
      expect(result.run.verdict).toBe("failed");
    });

    it("fails every check when the endpoint never answers", async () => {
      const { cookie, enrolmentId, event, systemId } = await arrange();
      stub.reset({ silent: true });

      const result = await run(enrolmentId, cookie);

      expect(result.run.verdict).toBe("failed");
      expect(
        result.run.checks.every((check) => check.outcome === "failed"),
      ).toBe(true);
      expect(result.run.checks[0]?.failure).toContain("stub.example.org");
      expect((await publicEntry(event.slug, systemId)).dcrVerified).toBeNull();
    });
  });

  describe("the client secret", () => {
    it("is redacted from the evidence and stored nowhere (principle IV)", async () => {
      const { cookie, enrolmentId } = await arrange();

      const result = await run(enrolmentId, cookie);

      // The evidence is kept and the credential in it is not: the body is still there to
      // read, with the secret replaced.
      const valid = result.run.checks.find(
        (check) => check.name === "valid-statement",
      );
      expect(valid?.response?.body).toContain("client_secret");
      expect(valid?.response?.body).toContain("[redacted]");
      expect(JSON.stringify(result)).not.toContain(STUB_SECRET);
      // And nowhere in the database, in any column of any table in the public schema.
      expect(await findStoredValue(stack.db, STUB_SECRET)).toEqual([]);
    });

    it("is absent from the run when it is read again", async () => {
      const { cookie, enrolmentId } = await arrange();
      const result = await run(enrolmentId, cookie);

      const reread = await apiJson<{ run: HarnessRunView }>(
        stack,
        "GET",
        `/api/harness-runs/${result.run.id}`,
      );

      expect(JSON.stringify(reread)).not.toContain(STUB_SECRET);
    });
  });

  describe("reading runs", () => {
    it("serves one run's evidence without an account (SC-005)", async () => {
      const { cookie, enrolmentId } = await arrange();
      const result = await run(enrolmentId, cookie);

      const read = await apiJson<{ run: HarnessRunView }>(
        stack,
        "GET",
        `/api/harness-runs/${result.run.id}`,
      );

      expect(read.run.id).toBe(result.run.id);
      expect(read.run.checks).toHaveLength(6);
      expect(read.run.verdict).toBe("passed");
    });

    it("lists an entry's runs newest first, with the target the screen names", async () => {
      const { cookie, enrolmentId, event } = await arrange();
      pinNow(new Date("2026-09-04T09:00:00.000Z"));
      await run(enrolmentId, cookie);
      pinNow(new Date("2026-09-04T10:00:00.000Z"));
      stub.reset({ broken: ["allow-replay"] });
      await run(enrolmentId, cookie);

      const read = await apiJson<HarnessRuns>(
        stack,
        "GET",
        `/api/enrolments/${enrolmentId}/harness-runs`,
        { cookie },
      );

      expect(read.runs.map((recorded) => recorded.verdict)).toEqual([
        "failed",
        "passed",
      ]);
      expect(read.target.systemName).toBe("Stub Auth");
      expect(read.target.eventSlug).toBe(event.slug);
      expect(read.target.registrationEndpoint).toBe(REGISTRATION_ENDPOINT);
      expect(read.target.canRun).toBe(true);
      expect(read.target.refusal).toBeNull();
    });

    it("tells an anonymous reader why they cannot run one", async () => {
      const { enrolmentId } = await arrange();

      const read = await apiJson<HarnessRuns>(
        stack,
        "GET",
        `/api/enrolments/${enrolmentId}/harness-runs`,
      );

      // Public, per principle V, and honest about what a visitor may do (FR-037).
      expect(read.target.canRun).toBe(false);
      expect(read.target.refusal).toBe("not_signed_in");
    });

    it("answers 404 for a run that does not exist", async () => {
      const response = await apiRequest(
        stack,
        "GET",
        "/api/harness-runs/6d1a4a1e-0000-4000-8000-000000000000",
      );

      expect(response.status).toBe(404);
    });
  });

  describe("refusing to run at all", () => {
    it("refuses a member with no session", async () => {
      const { enrolmentId } = await arrange();

      const response = await apiRequest(
        stack,
        "POST",
        `/api/enrolments/${enrolmentId}/harness-runs`,
      );

      expect(response.status).toBe(401);
    });

    it("refuses anybody but the entry's owner, with a 404", async () => {
      const { enrolmentId } = await arrange();
      const stranger = await stack.makeMember();
      const cookie = await stack.signIn(stranger.email);

      const response = await apiRequest(
        stack,
        "POST",
        `/api/enrolments/${enrolmentId}/harness-runs`,
        { cookie },
      );

      // The same answer as an enrolment that does not exist: a 403 would confirm which
      // organisation holds it.
      expect(response.status).toBe(404);
      expect(stub.requests).toEqual([]);
    });

    it("refuses a server whose registration mode is not trusted DCR", async () => {
      const { cookie, enrolmentId } = await arrange({
        registrationMode: "manual",
        registrationEndpoint: null,
      });

      const response = await apiRequest(
        stack,
        "POST",
        `/api/enrolments/${enrolmentId}/harness-runs`,
        { cookie },
      );

      expect(response.status).toBe(422);
      expect(((await response.json()) as { error: string }).error).toBe(
        "not_trusted_dcr",
      );
      expect(stub.requests).toEqual([]);
    });

    it("refuses an endpoint the outbound guard will not reach, and records nothing", async () => {
      const { cookie, enrolmentId } = await arrange({
        registrationEndpoint: "https://10.0.0.5/register",
      });

      const response = await apiRequest(
        stack,
        "POST",
        `/api/enrolments/${enrolmentId}/harness-runs`,
        { cookie },
      );

      expect(response.status).toBe(422);
      expect(((await response.json()) as { error: string }).error).toBe(
        "guarded_address",
      );
      // Nothing was signed and nothing was recorded: the address is wrong, so there was no
      // attempt to report (constitution principle III).
      expect(stub.requests).toEqual([]);
      const read = await apiJson<HarnessRuns>(
        stack,
        "GET",
        `/api/enrolments/${enrolmentId}/harness-runs`,
      );
      expect(read.runs).toEqual([]);
    });

    it("refuses once the event's grace period has run out", async () => {
      // The clock is pinned before the fixtures, so the session the owner signs in with is
      // one the server still recognises: moving it six weeks after the fact would expire the
      // session and answer 401 for a reason that is not this case's subject.
      pinNow(new Date("2026-10-15T00:00:00.000Z"));
      const { cookie, enrolmentId } = await arrange();

      const response = await apiRequest(
        stack,
        "POST",
        `/api/enrolments/${enrolmentId}/harness-runs`,
        { cookie },
      );

      // A statement minted now would already be expired, so the valid-statement check would
      // fail for Muster's reason rather than the vendor's.
      expect(response.status).toBe(409);
      expect(((await response.json()) as { error: string }).error).toBe(
        "vouching_window_closed",
      );
    });

    it("refuses an enrolment that does not exist", async () => {
      const owner = await stack.makeMember();
      const cookie = await stack.signIn(owner.email);

      const response = await apiRequest(
        stack,
        "POST",
        "/api/enrolments/6d1a4a1e-0000-4000-8000-000000000000/harness-runs",
        { cookie },
      );

      expect(response.status).toBe(404);
    });
  });
});
