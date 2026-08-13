/**
 * That the run does exactly what the profile says, and stores exactly what it may.
 *
 * The stub server is an injected `fetchImpl` rather than a socket, which is what lets this
 * suite assert the two things a live stub cannot make easy: what Muster *sent* (the body is
 * statement-only, per `contracts/registration-profile.md`), and what Muster *kept*
 * afterwards (nothing resembling the client secret, anywhere in the database - constitution
 * principle IV, FR-026). The real stub over a real socket is the quickstart's job.
 *
 * Every case drives the whole application through `app.request()`, so the guards, the state
 * machine and the projections are exercised as a browser would exercise them.
 *
 * Author: John Grimes
 */

import {
  clientProfileFixture,
  findPairing,
  findStoredValue,
  hasTestDatabase,
  makeEvent,
  makeOrganisation,
  makeSystem,
  serverProfileFixture,
  uniqueSuffix,
} from "@muster/db";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createLocalJWKSet, decodeProtectedHeader, jwtVerify } from "jose";

import { apiJson, apiRequest } from "../test/api.js";
import { createTestStack, TEST_PUBLIC_URL } from "../test/harness.js";

import type { OutboundFetchImpl } from "../outbound/outboundFetch.js";
import type { TestStack } from "../test/harness.js";
import type {
  DcrRunResult,
  PairingDetail,
  PairingOutcome,
} from "@muster/contracts";

/** Where the stub's registration endpoint lives. Public-looking, so the guard admits it. */
const REGISTRATION_ENDPOINT = "https://stub.example.org/register";

/** What the injected transport did and what it should answer with next. */
interface Transport {
  /** Every request the guard made, in order. */
  readonly requests: { url: string; body: string; headers: Headers }[];
  /** What to answer with. Set per case. */
  answer: () => Response;
  readonly fetchImpl: OutboundFetchImpl;
}

/** The recording transport the whole suite shares. */
function createTransport(): Transport {
  const transport: Transport = {
    requests: [],
    answer: () =>
      Response.json(
        { client_id: "stub-client" },
        {
          status: 201,
          headers: { "content-type": "application/json" },
        },
      ),
    fetchImpl: async (input, init) => {
      transport.requests.push({
        url: input.href,
        body: typeof init.body === "string" ? init.body : "",
        headers: new Headers(init.headers),
      });
      return await Promise.resolve(transport.answer());
    },
  };
  return transport;
}

describe.skipIf(!hasTestDatabase())("the trusted-DCR run", () => {
  let stack: TestStack;
  let transport: Transport;

  beforeAll(async () => {
    transport = createTransport();
    stack = await createTestStack({
      outbound: {
        fetchImpl: async (input, init) =>
          await transport.fetchImpl(input, init),
        // Every host resolves to a routable address (example.com's), so the guard's own checks are the ones
        // under test rather than DNS.
        resolve: async () => await Promise.resolve(["93.184.216.34"]),
      },
    });
  });

  afterAll(async () => {
    await stack.close();
  });

  /** An app owner, a server owner, an open event, and a pairing awaiting an answer. */
  async function arrange(
    overrides: {
      readonly registrationMode?: "open" | "manual" | "trustedDcr";
      readonly registrationEndpoint?: string | null;
      readonly confidentiality?: "public" | "confidential";
      readonly graceDays?: number;
      readonly endsOn?: string;
    } = {},
  ) {
    const appOwner = await stack.makeMember({ displayName: "Jo Chen" });
    const serverOwner = await stack.makeMember({ displayName: "Sam Ito" });
    const appCookie = await stack.signIn(appOwner.email);
    const serverCookie = await stack.signIn(serverOwner.email);

    const event = await makeEvent(stack.db, {
      slug: `dcr-${uniqueSuffix()}`,
      status: "open",
      endsOn: overrides.endsOn ?? "2026-09-19",
      graceDays: overrides.graceDays ?? 7,
    });
    const [appOrganisation, serverOrganisation] = await Promise.all([
      makeOrganisation(stack.db, appOwner.id, "CSIRO"),
      makeOrganisation(stack.db, serverOwner.id, "Stub Vendor"),
    ]);
    const clientSystem = await makeSystem(stack.db, appOrganisation.id, {
      name: "Smart Forms",
      serverProfile: null,
      clientProfile: clientProfileFixture({
        confidentiality: overrides.confidentiality ?? "public",
      }),
    });
    const serverSystem = await makeSystem(stack.db, serverOrganisation.id, {
      name: "Stub Auth",
      serverProfile: serverProfileFixture({
        registrationMode: overrides.registrationMode ?? "trustedDcr",
        registrationEndpoint:
          overrides.registrationEndpoint === undefined
            ? REGISTRATION_ENDPOINT
            : overrides.registrationEndpoint,
      }),
    });

    const enrol = async (systemId: string, cookie: string) =>
      await apiJson<{ enrolment: { id: string } }>(
        stack,
        "POST",
        `/api/events/${event.slug}/enrolments`,
        { cookie, body: { systemId, tags: [] } },
        201,
      );
    const [client, server] = await Promise.all([
      enrol(clientSystem.id, appCookie),
      enrol(serverSystem.id, serverCookie),
    ]);

    const requested = await apiJson<PairingOutcome>(
      stack,
      "POST",
      "/api/pairings",
      {
        cookie: appCookie,
        body: {
          eventSlug: event.slug,
          clientEnrolmentId: client.enrolment.id,
          serverEnrolmentId: server.enrolment.id,
          registrationFields: {
            clientName: "Smart Forms",
            launchUrl: "https://app.muster.test/launch",
            redirectUris: ["https://app.muster.test/callback"],
            scopes: ["launch", "openid", "fhirUser"],
            confidentiality: overrides.confidentiality ?? "public",
            launchContext: "patient",
            needsIntrospection: false,
          },
        },
      },
      201,
    );

    return {
      appCookie,
      serverCookie,
      event,
      pairingId: requested.pairing.id,
    };
  }

  describe("presenting the statement", () => {
    it("sends a statement-only body, as the profile requires", async () => {
      const { appCookie, pairingId } = await arrange();
      transport.requests.length = 0;
      transport.answer = () =>
        Response.json(
          { client_id: "stub-1" },
          {
            status: 201,
            headers: { "content-type": "application/json" },
          },
        );

      await apiJson<DcrRunResult>(
        stack,
        "POST",
        `/api/pairings/${pairingId}/register`,
        {
          cookie: appCookie,
        },
      );

      expect(transport.requests).toHaveLength(1);
      const sent = transport.requests[0];
      expect(sent?.url).toBe(REGISTRATION_ENDPOINT);
      expect(sent?.headers.get("content-type")).toBe("application/json");
      // Exactly one member. The anchor vouches for the metadata, so a body that could add
      // or override a field would reopen the gap vouching closes.
      const body = JSON.parse(sent?.body ?? "{}") as Record<string, unknown>;
      expect(Object.keys(body)).toEqual(["software_statement"]);
      expect(body["software_statement"]).toBeString();
    });

    it("signs the statement with the published key, and caps its expiry", async () => {
      const { appCookie, pairingId } = await arrange({
        endsOn: "2026-09-19",
        graceDays: 7,
      });
      transport.requests.length = 0;

      const result = await apiJson<DcrRunResult>(
        stack,
        "POST",
        `/api/pairings/${pairingId}/register`,
        { cookie: appCookie },
      );

      const body = JSON.parse(transport.requests[0]?.body ?? "{}") as {
        software_statement: string;
      };
      // Verified against the JWKS the public route serves, matched by `kid` - which is what
      // the vendor at the other end does.
      const jwks = (await (
        await apiRequest(stack, "GET", "/.well-known/jwks.json")
      ).json()) as { keys: Record<string, unknown>[] };
      const verified = await jwtVerify(
        body.software_statement,
        createLocalJWKSet(jwks),
        { issuer: TEST_PUBLIC_URL },
      );
      expect(decodeProtectedHeader(body.software_statement).kid).toBe(
        result.run.statement.keyId,
      );
      // FR-023, scenario 1: no later than event end plus the event's grace period.
      expect(new Date((verified.payload.exp ?? 0) * 1000).toISOString()).toBe(
        "2026-09-27T00:00:00.000Z",
      );
      expect(verified.payload["muster_event"]).toBe(
        result.run.statement.claims.muster_event,
      );
      expect(verified.payload["client_name"]).toBe("Smart Forms");
    });
  });

  describe("when the server registers the client", () => {
    it("fulfils the pairing with the returned identifier", async () => {
      const { appCookie, pairingId } = await arrange();
      transport.answer = () =>
        Response.json(
          { client_id: "smart-forms-7f3a" },
          {
            status: 201,
            headers: { "content-type": "application/json" },
          },
        );

      const result = await apiJson<DcrRunResult>(
        stack,
        "POST",
        `/api/pairings/${pairingId}/register`,
        { cookie: appCookie },
      );

      expect(result.run.outcome).toBe("registered");
      expect(result.run.clientId).toBe("smart-forms-7f3a");
      expect(result.pairing.state).toBe("fulfilled");
      expect(result.pairing.clientId).toBe("smart-forms-7f3a");
      // Every step reported, so the console can show progress rather than a verdict.
      expect(result.run.steps.map((step) => step.name)).toEqual([
        "mint",
        "present",
        "record",
      ]);
      expect(result.run.steps.every((step) => step.outcome === "done")).toBe(
        true,
      );
    });

    it("tells the server's organisation, and records the transition", async () => {
      const { appCookie, pairingId } = await arrange();
      transport.answer = () =>
        Response.json({ client_id: "stub-2" }, { status: 201 });
      const before = stack.sent.length;

      const result = await apiJson<DcrRunResult>(
        stack,
        "POST",
        `/api/pairings/${pairingId}/register`,
        { cookie: appCookie },
      );

      expect(result.notified).toBe(true);
      expect(stack.sent.length).toBeGreaterThan(before);
      const last = result.pairing.timeline.at(-1);
      expect(last?.fromState).toBe("requested");
      expect(last?.toState).toBe("fulfilled");
      expect(last?.clientId).toBe("stub-2");
    });

    it("shows a client secret once and stores it nowhere", async () => {
      const secret = `sekrit-${uniqueSuffix()}`;
      const { appCookie, pairingId } = await arrange({
        confidentiality: "confidential",
      });
      transport.answer = () =>
        Response.json(
          { client_id: "conf-1", client_secret: secret },
          { status: 201, headers: { "content-type": "application/json" } },
        );

      const result = await apiJson<DcrRunResult>(
        stack,
        "POST",
        `/api/pairings/${pairingId}/register`,
        { cookie: appCookie },
      );

      // Shown once, in the response of the run that produced it (FR-026).
      expect(result.run.clientSecret).toBe(secret);

      // And nowhere else. Not on the pairing when it is read again...
      const reread = await apiJson<{ pairing: PairingDetail }>(
        stack,
        "GET",
        `/api/pairings/${pairingId}`,
        { cookie: appCookie },
      );
      expect(JSON.stringify(reread)).not.toContain(secret);

      // ...and not in the database, in any column of any table in the public schema
      // (principle IV). `findStoredValue` reads the table list from the catalogue, so this
      // covers tables it has never heard of.
      expect(await findStoredValue(stack.db, secret)).toEqual([]);
    });

    it("refuses a second run against a pairing that is already fulfilled", async () => {
      const { appCookie, pairingId } = await arrange();
      transport.answer = () =>
        Response.json({ client_id: "stub-3" }, { status: 201 });
      await apiJson<DcrRunResult>(
        stack,
        "POST",
        `/api/pairings/${pairingId}/register`,
        { cookie: appCookie },
      );

      const response = await apiRequest(
        stack,
        "POST",
        `/api/pairings/${pairingId}/register`,
        { cookie: appCookie },
      );

      expect(response.status).toBe(409);
      expect(((await response.json()) as { error: string }).error).toBe(
        "pairing_not_open",
      );
    });
  });

  describe("when the server refuses", () => {
    it("records the failure with the server's own error (scenario 3)", async () => {
      const { appCookie, pairingId } = await arrange();
      transport.answer = () =>
        Response.json(
          {
            error: "invalid_client_metadata",
            error_description: "redirect_uri is not permitted here",
          },
          { status: 400, headers: { "content-type": "application/json" } },
        );

      const result = await apiJson<DcrRunResult>(
        stack,
        "POST",
        `/api/pairings/${pairingId}/register`,
        { cookie: appCookie },
      );

      expect(result.run.outcome).toBe("refused");
      expect(result.run.answer?.status).toBe(400);
      expect(result.run.answer?.error).toBe("invalid_client_metadata");
      expect(result.run.answer?.errorDescription).toBe(
        "redirect_uri is not permitted here",
      );
      expect(result.pairing.state).toBe("failed");
      expect(result.pairing.clientId).toBeNull();
      // The app owner reads the failure on the pairing, not only in this response.
      const last = result.pairing.timeline.at(-1);
      expect(last?.toState).toBe("failed");
      expect(JSON.stringify(result.pairing.timeline)).toContain(
        "invalid_client_metadata",
      );
    });

    it("lets the owner retry, which re-requests and mints again", async () => {
      const { appCookie, pairingId } = await arrange();
      transport.answer = () =>
        Response.json(
          { error: "invalid_client_metadata" },
          {
            status: 400,
          },
        );
      const first = await apiJson<DcrRunResult>(
        stack,
        "POST",
        `/api/pairings/${pairingId}/register`,
        { cookie: appCookie },
      );
      transport.answer = () =>
        Response.json(
          { client_id: "after-retry" },
          {
            status: 201,
          },
        );

      const second = await apiJson<DcrRunResult>(
        stack,
        "POST",
        `/api/pairings/${pairingId}/register`,
        { cookie: appCookie },
      );

      expect(second.pairing.state).toBe("fulfilled");
      expect(second.pairing.clientId).toBe("after-retry");
      // A new statement, with a new identifier: the profile makes the identifier single-use,
      // so a retry that re-presented the first one would be refused by a conformant server.
      expect(second.run.statement.jti).not.toBe(first.run.statement.jti);
      // The retry itself is recorded, so the timeline explains the second attempt.
      const states = second.pairing.timeline.map(
        (entry) => `${entry.fromState ?? "new"}->${entry.toState}`,
      );
      expect(states).toEqual([
        "new->requested",
        "requested->failed",
        "failed->requested",
        "requested->fulfilled",
      ]);
    });

    it("records a server that never answers as unreachable", async () => {
      const { appCookie, pairingId } = await arrange();
      transport.answer = () => {
        throw new Error("connect ECONNREFUSED");
      };

      const result = await apiJson<DcrRunResult>(
        stack,
        "POST",
        `/api/pairings/${pairingId}/register`,
        { cookie: appCookie },
      );

      expect(result.run.outcome).toBe("unreachable");
      expect(result.run.answer).toBeNull();
      expect(result.pairing.state).toBe("failed");
    });
  });

  describe("refusing to run at all", () => {
    it("refuses a server whose registration mode is manual", async () => {
      const { appCookie, pairingId } = await arrange({
        registrationMode: "manual",
        registrationEndpoint: null,
      });

      const response = await apiRequest(
        stack,
        "POST",
        `/api/pairings/${pairingId}/register`,
        { cookie: appCookie },
      );

      expect(response.status).toBe(422);
      expect(((await response.json()) as { error: string }).error).toBe(
        "not_trusted_dcr",
      );
    });

    it("refuses the server owner: the run is the app owner's (FR-025)", async () => {
      const { serverCookie, pairingId } = await arrange();

      const response = await apiRequest(
        stack,
        "POST",
        `/api/pairings/${pairingId}/register`,
        { cookie: serverCookie },
      );

      expect(response.status).toBe(403);
      expect(((await response.json()) as { error: string }).error).toBe(
        "not_the_app_owner",
      );
    });

    it("refuses a member with no session", async () => {
      const { pairingId } = await arrange();

      const response = await apiRequest(
        stack,
        "POST",
        `/api/pairings/${pairingId}/register`,
      );

      expect(response.status).toBe(401);
    });

    it("refuses a stranger with a 404 rather than a 403", async () => {
      const { pairingId } = await arrange();
      const stranger = await stack.makeMember();
      const cookie = await stack.signIn(stranger.email);

      const response = await apiRequest(
        stack,
        "POST",
        `/api/pairings/${pairingId}/register`,
        { cookie },
      );

      // A 403 would confirm that two named organisations are negotiating.
      expect(response.status).toBe(404);
    });

    it("refuses once the event is closed", async () => {
      const { appCookie, pairingId, event } = await arrange();
      await apiRequest(stack, "PATCH", `/api/admin/events/${event.slug}`, {
        cookie: stack.adminCookie,
        body: { status: "closed" },
      });

      const response = await apiRequest(
        stack,
        "POST",
        `/api/pairings/${pairingId}/register`,
        { cookie: appCookie },
      );

      // Closing lapses the pairing, so the state refuses before the event does; either way
      // nothing is minted for a closed event (FR-025).
      expect(response.status).toBe(409);
    });

    it("refuses an endpoint the outbound guard will not reach, and records nothing", async () => {
      // A private-range literal, which the guard refuses without resolving anything - so no
      // request leaves the process and there is no attempt to record.
      const { appCookie, pairingId } = await arrange({
        registrationEndpoint: "https://10.0.0.5/register",
      });
      transport.requests.length = 0;

      const response = await apiRequest(
        stack,
        "POST",
        `/api/pairings/${pairingId}/register`,
        { cookie: appCookie },
      );

      expect(response.status).toBe(422);
      expect(((await response.json()) as { error: string }).error).toBe(
        "guarded_address",
      );
      expect(transport.requests).toEqual([]);
      // Still awaiting an answer: nothing was presented, so nothing failed.
      const row = await findPairing(stack.db, pairingId);
      expect(row?.pairing.state).toBe("requested");
    });
  });

  describe("downloading the statement", () => {
    it("serves the identical artefact that was presented (FR-027, scenario 6)", async () => {
      const { appCookie, pairingId } = await arrange();
      transport.requests.length = 0;
      transport.answer = () =>
        Response.json({ client_id: "stub-4" }, { status: 201 });
      await apiJson<DcrRunResult>(
        stack,
        "POST",
        `/api/pairings/${pairingId}/register`,
        { cookie: appCookie },
      );
      const presented = (
        JSON.parse(transport.requests[0]?.body ?? "{}") as {
          software_statement: string;
        }
      ).software_statement;

      const response = await apiRequest(
        stack,
        "GET",
        `/api/pairings/${pairingId}/statement`,
        { cookie: appCookie },
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/jwt");
      // Byte-identical, not merely equivalent: an ES256 signature is randomised, so a
      // re-signed statement would verify and still be a different artefact.
      expect(await response.text()).toBe(presented);
    });

    it("offers it as a file, named for the pairing", async () => {
      const { appCookie, pairingId } = await arrange();
      transport.answer = () =>
        Response.json({ client_id: "stub-5" }, { status: 201 });
      await apiJson<DcrRunResult>(
        stack,
        "POST",
        `/api/pairings/${pairingId}/register`,
        { cookie: appCookie },
      );

      const response = await apiRequest(
        stack,
        "GET",
        `/api/pairings/${pairingId}/statement`,
        { cookie: appCookie },
      );

      expect(response.headers.get("content-disposition")).toContain(
        "attachment",
      );
    });

    it("answers 404 before anything has been minted", async () => {
      const { appCookie, pairingId } = await arrange();

      const response = await apiRequest(
        stack,
        "GET",
        `/api/pairings/${pairingId}/statement`,
        { cookie: appCookie },
      );

      expect(response.status).toBe(404);
    });

    it("is the app owner's alone", async () => {
      const { appCookie, serverCookie, pairingId } = await arrange();
      transport.answer = () =>
        Response.json({ client_id: "stub-6" }, { status: 201 });
      await apiJson<DcrRunResult>(
        stack,
        "POST",
        `/api/pairings/${pairingId}/register`,
        { cookie: appCookie },
      );

      const response = await apiRequest(
        stack,
        "GET",
        `/api/pairings/${pairingId}/statement`,
        { cookie: serverCookie },
      );

      // The statement names no audience, so whoever holds it can present it at any server
      // that trusts Muster. It is handed to as few people as the requirement allows.
      expect(response.status).toBe(403);
    });
  });

  describe("what the pairing says about registration", () => {
    it("offers the run to the app owner and not to the server owner", async () => {
      const { appCookie, serverCookie, pairingId } = await arrange();

      const [asApp, asServer] = await Promise.all([
        apiJson<{ pairing: PairingDetail }>(
          stack,
          "GET",
          `/api/pairings/${pairingId}`,
          { cookie: appCookie },
        ),
        apiJson<{ pairing: PairingDetail }>(
          stack,
          "GET",
          `/api/pairings/${pairingId}`,
          { cookie: serverCookie },
        ),
      ]);

      expect(asApp.pairing.actions).toContain("register");
      expect(asServer.pairing.actions).not.toContain("register");
      expect(asServer.pairing.actions).toContain("fulfil");
    });

    it("does not offer the run against a manual server", async () => {
      const { appCookie, pairingId } = await arrange({
        registrationMode: "manual",
        registrationEndpoint: null,
      });

      const read = await apiJson<{ pairing: PairingDetail }>(
        stack,
        "GET",
        `/api/pairings/${pairingId}`,
        { cookie: appCookie },
      );

      expect(read.pairing.actions).not.toContain("register");
    });

    it("carries the minted statement's claims for both parties", async () => {
      const { appCookie, serverCookie, pairingId } = await arrange();
      transport.answer = () =>
        Response.json({ client_id: "stub-7" }, { status: 201 });
      await apiJson<DcrRunResult>(
        stack,
        "POST",
        `/api/pairings/${pairingId}/register`,
        { cookie: appCookie },
      );

      const read = await apiJson<{ pairing: PairingDetail }>(
        stack,
        "GET",
        `/api/pairings/${pairingId}`,
        { cookie: serverCookie },
      );

      expect(read.pairing.statement?.claims.client_name).toBe("Smart Forms");
      expect(read.pairing.statement?.claims.iss).toBe(TEST_PUBLIC_URL);
      // The signed artefact itself is not in the projection: it is a download, not a field.
      expect(JSON.stringify(read.pairing.statement)).not.toContain("eyJ");
    });
  });
});
