/**
 * The pairing tracker, end to end.
 *
 * Three things are asserted here and nowhere else.
 *
 * **Authority per side.** Only the client side's organisation may request, and only the server
 * side's may fulfil or decline (FR-014). Every one of those is exercised from the wrong side as
 * well as the right one, because what stops an app owner issuing themselves a client identifier
 * is a predicate in a handler - and a predicate is the thing that gets omitted from the fourth
 * route by somebody adding the fifth.
 *
 * **The refusals a participant has to act on.** A duplicate links the pairing that already
 * exists (FR-015), an open-registration server says no pairing is needed (FR-016), two systems
 * in two events cannot be paired (scenario 6), and a closed event takes nothing new (FR-011).
 *
 * **The notifications and the timeline.** FR-014 requires the counterparty to be told on every
 * transition, and FR-013 requires both organisations to read the same history - so the messages
 * are read out of the recording transport, and the timeline is fetched as both parties and
 * compared.
 *
 * Author: John Grimes
 */

import {
  clientProfileFixture,
  hasTestDatabase,
  insertCheckResult,
  makeEnrolment,
  makeEvent,
  makeOrganisation,
  makeSystem,
  serverProfileFixture,
  uniqueSuffix,
} from "@muster/db";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import { apiJson, apiRequest } from "../test/api.js";
import { createTestStack } from "../test/harness.js";

import type { TestStack } from "../test/harness.js";
import type {
  EventDetail,
  PairingConflict,
  PairingDetail,
  PairingOutcome,
  PairingSummary,
  RegistrationFieldsInput,
} from "@muster/contracts";
import type { AccountRow, EventRow, OrganisationRow } from "@muster/db";

/** The field set the quickstart's request carries. */
const FIELDS: RegistrationFieldsInput = {
  clientName: "Smart Forms",
  launchUrl: "https://smartforms.csiro.au/launch",
  redirectUris: ["https://smartforms.csiro.au/"],
  scopes: ["launch", "openid", "fhirUser", "patient/Patient.rs"],
  confidentiality: "public",
  launchContext: "patient",
  needsIntrospection: false,
};

describe.skipIf(!hasTestDatabase())("the pairing routes", () => {
  let stack: TestStack;

  beforeAll(async () => {
    stack = await createTestStack();
  });

  afterAll(async () => {
    await stack.close();
  });

  /** A signed-in approved member with an organisation of their own. */
  async function member(name: string): Promise<{
    readonly account: AccountRow;
    readonly cookie: string;
    readonly organisation: OrganisationRow;
  }> {
    const account = await stack.makeMember({ displayName: name });
    return {
      account,
      cookie: await stack.signIn(account.email),
      organisation: await makeOrganisation(
        stack.db,
        account.id,
        `${name}'s organisation ${uniqueSuffix()}`,
      ),
    };
  }

  /** An open event with an enrolled client and an enrolled server, and their owners. */
  async function scene(
    options: {
      readonly registrationMode?: "open" | "manual" | "trustedDcr";
      /** Puts the server's enrolment in a second event, for the cross-event case. */
      readonly serverInOwnEvent?: boolean;
    } = {},
  ) {
    const app = await member("Jo Chen");
    const server = await member("Sam Patel");
    const event = await makeEvent(stack.db, { status: "open" });
    const serverEvent = options.serverInOwnEvent
      ? await makeEvent(stack.db, { status: "open" })
      : event;

    const clientSystem = await makeSystem(stack.db, app.organisation.id, {
      name: "Smart Forms",
      serverProfile: null,
      clientProfile: clientProfileFixture(),
    });
    const serverSystem = await makeSystem(stack.db, server.organisation.id, {
      name: "MediRecords FHIR",
      serverProfile: serverProfileFixture({
        registrationMode: options.registrationMode ?? "manual",
        ...(options.registrationMode === "trustedDcr"
          ? { registrationEndpoint: "https://mr.test/register" }
          : {}),
      }),
    });

    const clientEnrolment = await makeEnrolment(stack.db, {
      event,
      systemId: clientSystem.id,
      accountId: app.account.id,
    });
    const serverEnrolment = await makeEnrolment(stack.db, {
      event: serverEvent,
      systemId: serverSystem.id,
      accountId: server.account.id,
    });

    return {
      app,
      server,
      event,
      serverEvent,
      clientSystem,
      serverSystem,
      clientEnrolment,
      serverEnrolment,
    };
  }

  /** The body a request carries for one scene. */
  function requestBody(
    stage: Awaited<ReturnType<typeof scene>>,
    fields: RegistrationFieldsInput = FIELDS,
  ) {
    return {
      eventSlug: stage.event.slug,
      clientEnrolmentId: stage.clientEnrolment.id,
      serverEnrolmentId: stage.serverEnrolment.id,
      registrationFields: fields,
    };
  }

  /** Requests the pairing as the app owner, expecting it to be created. */
  async function request(stage: Awaited<ReturnType<typeof scene>>) {
    return await apiJson<PairingOutcome>(
      stack,
      "POST",
      "/api/pairings",
      { cookie: stage.app.cookie, body: requestBody(stage) },
      201,
    );
  }

  /** The messages the recording transport holds, addressed to one person. */
  function messagesFor(account: AccountRow) {
    return stack.sent.filter((message) => message.to === account.email);
  }

  describe("requesting a pairing", () => {
    it("creates it in the requested state with the submitted field snapshot", async () => {
      // Scenario 1: the request is created in state "requested" carrying the standard field
      // set, which the console prefilled from the client's record.
      const stage = await scene();

      const created = await request(stage);

      expect(created.pairing.state).toBe("requested");
      expect(created.pairing.registrationFields).toEqual(FIELDS);
      expect(created.pairing.client.name).toBe("Smart Forms");
      expect(created.pairing.server.name).toBe("MediRecords FHIR");
      expect(created.pairing.clientId).toBeNull();
    });

    it("notifies the server organisation's members by email", async () => {
      // Scenario 1 and FR-014. The server owner reads this out of the console transport's log
      // in the quickstart, so the message has to name the pairing and link to it.
      const stage = await scene();

      const created = await request(stage);

      const notices = messagesFor(stage.server.account);
      expect(notices.length).toBeGreaterThan(0);
      const latest = notices.at(-1);
      expect(latest?.subject).toContain("pairing");
      expect(latest?.text).toContain("Smart Forms");
      expect(latest?.text).toContain(`/pairings/${created.pairing.id}`);
      // Reported as part of the answer, not left to be discovered (FR-037).
      expect(created.notified).toBe(true);
    });

    it("does not notify the requester's own organisation", async () => {
      const stage = await scene();

      await request(stage);

      expect(messagesFor(stage.app.account)).toEqual([]);
    });

    it("tells the requester which side they hold and what they may do", async () => {
      const stage = await scene();

      const created = await request(stage);

      expect(created.pairing.sides).toEqual(["client"]);
      // The identifier is the server's to issue, so the app owner is offered nothing.
      expect(created.pairing.actions).toEqual([]);
    });

    it("records the request as the timeline's first entry", async () => {
      const stage = await scene();

      const created = await request(stage);

      expect(created.pairing.timeline).toHaveLength(1);
      expect(created.pairing.timeline[0]?.fromState).toBeNull();
      expect(created.pairing.timeline[0]?.toState).toBe("requested");
      expect(created.pairing.timeline[0]?.actorDisplayName).toBe("Jo Chen");
      expect(created.pairing.timeline[0]?.actingFor?.id).toBe(
        stage.app.organisation.id,
      );
      // Derived from the transition, so both parties read the same claim about who was told.
      expect(created.pairing.timeline[0]?.notifies).toEqual(["server"]);
    });

    it("refuses an anonymous visitor", async () => {
      const stage = await scene();

      const response = await apiRequest(stack, "POST", "/api/pairings", {
        body: requestBody(stage),
      });

      expect(response.status).toBe(401);
    });

    it("refuses a revoked member", async () => {
      // FR-002: revocation blocks vouching actions, and asking a server to register your app
      // is one.
      const stage = await scene();
      const revoked = await apiRequest(
        stack,
        "POST",
        `/api/admin/accounts/${stage.app.account.id}/revoke`,
        { cookie: stack.adminCookie },
      );
      expect(revoked.status).toBe(200);

      const response = await apiRequest(stack, "POST", "/api/pairings", {
        cookie: stage.app.cookie,
        body: requestBody(stage),
      });

      expect(response.status).toBe(403);
      expect(((await response.json()) as { error: string }).error).toBe(
        "revoked_member",
      );
    });

    it("refuses a client enrolment the caller's organisations do not own", async () => {
      // Answered 404 rather than 403: a 403 would confirm the identifier names something, which
      // is how a directory of vendors is enumerated by anybody with an account.
      const stage = await scene();
      const outsider = await member("Outsider");

      const response = await apiRequest(stack, "POST", "/api/pairings", {
        cookie: outsider.cookie,
        body: requestBody(stage),
      });

      expect(response.status).toBe(404);
    });

    it("refuses a duplicate and links the pairing that exists", async () => {
      // FR-015 and the spec's edge case.
      const stage = await scene();
      const first = await request(stage);

      const response = await apiRequest(stack, "POST", "/api/pairings", {
        cookie: stage.app.cookie,
        body: requestBody(stage),
      });

      expect(response.status).toBe(409);
      const body = (await response.json()) as PairingConflict;
      expect(body.error).toBe("pairing_exists");
      expect(body.pairingId).toBe(first.pairing.id);
    });

    it("refuses a server that needs no registration", async () => {
      // FR-016 and scenario 5. The console offers no button; this is the same refusal made
      // server-side, because the console is not a security boundary.
      const stage = await scene({ registrationMode: "open" });

      const response = await apiRequest(stack, "POST", "/api/pairings", {
        cookie: stage.app.cookie,
        body: requestBody(stage),
      });

      expect(response.status).toBe(422);
      expect(((await response.json()) as { error: string }).error).toBe(
        "no_registration_needed",
      );
    });

    it("refuses a server enrolled in a different event", async () => {
      // Scenario 6: pairings exist within a single event.
      const stage = await scene({ serverInOwnEvent: true });

      const response = await apiRequest(stack, "POST", "/api/pairings", {
        cookie: stage.app.cookie,
        body: requestBody(stage),
      });

      expect(response.status).toBe(422);
      expect(((await response.json()) as { error: string }).error).toBe(
        "cross_event",
      );
    });

    it("refuses a closed event", async () => {
      // FR-011: nothing new can be requested against a closed event, and its records stay
      // readable.
      const stage = await scene();
      await apiJson<{ event: EventDetail }>(
        stack,
        "PATCH",
        `/api/admin/events/${stage.event.slug}`,
        { cookie: stack.adminCookie, body: { status: "closed" } },
      );

      const response = await apiRequest(stack, "POST", "/api/pairings", {
        cookie: stage.app.cookie,
        body: requestBody(stage),
      });

      expect(response.status).toBe(409);
      expect(((await response.json()) as { error: string }).error).toBe(
        "event_not_open",
      );
    });

    it("refuses a server side that is not a server", async () => {
      const stage = await scene();
      const clientOnly = await makeSystem(
        stack.db,
        stage.server.organisation.id,
        {
          serverProfile: null,
          clientProfile: clientProfileFixture(),
        },
      );
      const enrolled = await makeEnrolment(stack.db, {
        event: stage.event,
        systemId: clientOnly.id,
        accountId: stage.server.account.id,
      });

      const response = await apiRequest(stack, "POST", "/api/pairings", {
        cookie: stage.app.cookie,
        body: {
          ...requestBody(stage),
          serverEnrolmentId: enrolled.id,
        },
      });

      expect(response.status).toBe(422);
      expect(((await response.json()) as { error: string }).error).toBe(
        "not_a_server",
      );
    });

    it("refuses a field set with no redirect URI", async () => {
      // The domain minimum, held by `registrationFieldRefusal` in the pure core: a client with
      // nowhere to be redirected cannot complete an authorization code flow.
      const stage = await scene();

      const response = await apiRequest(stack, "POST", "/api/pairings", {
        cookie: stage.app.cookie,
        body: requestBody(stage, { ...FIELDS, redirectUris: [] }),
      });

      expect(response.status).toBe(422);
      expect(((await response.json()) as { error: string }).error).toBe(
        "no_redirect_uris",
      );
    });

    it("refuses a body that is not the contract", async () => {
      const stage = await scene();

      const response = await apiRequest(stack, "POST", "/api/pairings", {
        cookie: stage.app.cookie,
        body: { eventSlug: stage.event.slug },
      });

      expect(response.status).toBe(400);
    });

    it("refuses an enrolment identifier that names nothing", async () => {
      const stage = await scene();

      const response = await apiRequest(stack, "POST", "/api/pairings", {
        cookie: stage.app.cookie,
        body: {
          ...requestBody(stage),
          serverEnrolmentId: "00000000-0000-4000-8000-000000000000",
        },
      });

      expect(response.status).toBe(404);
    });
  });

  describe("fulfilling a request", () => {
    it("records the issued identifier and notifies the app owner", async () => {
      // Scenario 2: the server organisation records the client identifier, the pairing becomes
      // fulfilled, the app owner is notified, and the identifier is visible to both.
      const stage = await scene();
      const created = await request(stage);

      const answered = await apiJson<PairingOutcome>(
        stack,
        "POST",
        `/api/pairings/${created.pairing.id}/fulfil`,
        {
          cookie: stage.server.cookie,
          body: { clientId: "smart-forms-test-1" },
        },
      );

      expect(answered.pairing.state).toBe("fulfilled");
      expect(answered.pairing.clientId).toBe("smart-forms-test-1");
      expect(answered.notified).toBe(true);
      const notices = messagesFor(stage.app.account);
      expect(notices.at(-1)?.text).toContain("smart-forms-test-1");
    });

    it("appends the transition to the timeline", async () => {
      const stage = await scene();
      const created = await request(stage);

      const answered = await apiJson<PairingOutcome>(
        stack,
        "POST",
        `/api/pairings/${created.pairing.id}/fulfil`,
        {
          cookie: stage.server.cookie,
          body: { clientId: "smart-forms-test-2" },
        },
      );

      expect(
        answered.pairing.timeline.map((entry) => [
          entry.fromState,
          entry.toState,
        ]),
      ).toEqual([
        [null, "requested"],
        ["requested", "fulfilled"],
      ]);
      expect(answered.pairing.timeline[1]?.clientId).toBe("smart-forms-test-2");
      expect(answered.pairing.timeline[1]?.actingFor?.id).toBe(
        stage.server.organisation.id,
      );
    });

    it("refuses the app owner fulfilling their own request", async () => {
      // The whole point of the workflow: the identifier is the server's to issue.
      const stage = await scene();
      const created = await request(stage);

      const response = await apiRequest(
        stack,
        "POST",
        `/api/pairings/${created.pairing.id}/fulfil`,
        { cookie: stage.app.cookie, body: { clientId: "self-issued" } },
      );

      expect(response.status).toBe(403);
      expect(((await response.json()) as { error: string }).error).toBe(
        "wrong_side",
      );
    });

    it("refuses fulfilling a pairing that has already been answered", async () => {
      const stage = await scene();
      const created = await request(stage);
      await apiJson<PairingOutcome>(
        stack,
        "POST",
        `/api/pairings/${created.pairing.id}/fulfil`,
        { cookie: stage.server.cookie, body: { clientId: "first" } },
      );

      const response = await apiRequest(
        stack,
        "POST",
        `/api/pairings/${created.pairing.id}/fulfil`,
        { cookie: stage.server.cookie, body: { clientId: "second" } },
      );

      expect(response.status).toBe(409);
      expect(((await response.json()) as { error: string }).error).toBe(
        "illegal_transition",
      );
    });

    it("refuses a member of neither organisation", async () => {
      // 404, not 403: somebody with an account must not be able to discover that a pairing
      // between two other organisations exists.
      const stage = await scene();
      const created = await request(stage);
      const outsider = await member("Nobody");

      const response = await apiRequest(
        stack,
        "POST",
        `/api/pairings/${created.pairing.id}/fulfil`,
        { cookie: outsider.cookie, body: { clientId: "nope" } },
      );

      expect(response.status).toBe(404);
    });

    it("refuses an empty client identifier", async () => {
      const stage = await scene();
      const created = await request(stage);

      const response = await apiRequest(
        stack,
        "POST",
        `/api/pairings/${created.pairing.id}/fulfil`,
        { cookie: stage.server.cookie, body: { clientId: "  " } },
      );

      expect(response.status).toBe(400);
    });

    it("refuses a pairing that does not exist", async () => {
      const stage = await scene();

      const response = await apiRequest(
        stack,
        "POST",
        "/api/pairings/00000000-0000-4000-8000-000000000000/fulfil",
        { cookie: stage.server.cookie, body: { clientId: "nope" } },
      );

      expect(response.status).toBe(404);
    });
  });

  describe("declining a request", () => {
    it("records the reason and notifies the app owner", async () => {
      // Scenario 3: the reason is visible to the app owner, who was notified.
      const stage = await scene();
      const created = await request(stage);

      const answered = await apiJson<PairingOutcome>(
        stack,
        "POST",
        `/api/pairings/${created.pairing.id}/decline`,
        {
          cookie: stage.server.cookie,
          body: { reason: "redirect URI not permitted in our environment" },
        },
      );

      expect(answered.pairing.state).toBe("declined");
      expect(answered.pairing.declineReason).toBe(
        "redirect URI not permitted in our environment",
      );
      expect(answered.pairing.timeline[1]?.reason).toBe(
        "redirect URI not permitted in our environment",
      );
      expect(messagesFor(stage.app.account).at(-1)?.text).toContain(
        "redirect URI not permitted",
      );
    });

    it("refuses the app owner declining their own request", async () => {
      const stage = await scene();
      const created = await request(stage);

      const response = await apiRequest(
        stack,
        "POST",
        `/api/pairings/${created.pairing.id}/decline`,
        { cookie: stage.app.cookie, body: { reason: "no thanks" } },
      );

      expect(response.status).toBe(403);
    });

    it("refuses a decline with no reason", async () => {
      // A decline with nothing in it leaves the app owner with nothing to fix.
      const stage = await scene();
      const created = await request(stage);

      const response = await apiRequest(
        stack,
        "POST",
        `/api/pairings/${created.pairing.id}/decline`,
        { cookie: stage.server.cookie, body: { reason: "" } },
      );

      expect(response.status).toBe(400);
    });
  });

  describe("the pairing list", () => {
    it("shows a member the pairings on either side of them", async () => {
      // Scenario 4, from both directions.
      const stage = await scene();
      const created = await request(stage);

      const asApp = await apiJson<{ pairings: PairingSummary[] }>(
        stack,
        "GET",
        "/api/pairings",
        { cookie: stage.app.cookie },
      );
      const asServer = await apiJson<{ pairings: PairingSummary[] }>(
        stack,
        "GET",
        "/api/pairings",
        { cookie: stage.server.cookie },
      );

      expect(asApp.pairings.map((row) => row.id)).toContain(created.pairing.id);
      expect(asServer.pairings.map((row) => row.id)).toContain(
        created.pairing.id,
      );
    });

    it("offers the server organisation the actions it may take", async () => {
      const stage = await scene();
      const created = await request(stage);

      const asServer = await apiJson<{ pairings: PairingSummary[] }>(
        stack,
        "GET",
        "/api/pairings",
        { cookie: stage.server.cookie },
      );

      const row = asServer.pairings.find(
        (one) => one.id === created.pairing.id,
      );
      expect(row?.sides).toEqual(["server"]);
      // The wireframe's Respond action: offered because the server may take it.
      expect(row?.actions).toEqual(["fulfil", "decline"]);
    });

    it("shows both sides to a member of both organisations", async () => {
      // The spec's edge case: one person in both organisations sees both sides of one pairing.
      const stage = await scene();
      const created = await request(stage);
      await apiRequest(
        stack,
        "POST",
        `/api/organisations/${stage.server.organisation.id}/members`,
        {
          cookie: stage.server.cookie,
          body: { email: stage.app.account.email },
        },
      );

      const listed = await apiJson<{ pairings: PairingSummary[] }>(
        stack,
        "GET",
        "/api/pairings",
        { cookie: stage.app.cookie },
      );

      const rows = listed.pairings.filter(
        (one) => one.id === created.pairing.id,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.sides).toEqual(["client", "server"]);
      expect(rows[0]?.actions).toEqual(["fulfil", "decline"]);
    });

    it("does not show somebody else's pairings", async () => {
      const stage = await scene();
      const created = await request(stage);
      const outsider = await member("Unrelated");

      const listed = await apiJson<{ pairings: PairingSummary[] }>(
        stack,
        "GET",
        "/api/pairings",
        { cookie: outsider.cookie },
      );

      expect(listed.pairings.map((row) => row.id)).not.toContain(
        created.pairing.id,
      );
    });

    it("narrows to one event when asked", async () => {
      const stage = await scene();
      const created = await request(stage);
      const elsewhere = await makeEvent(stack.db, { status: "open" });

      const mine = await apiJson<{ pairings: PairingSummary[] }>(
        stack,
        "GET",
        `/api/pairings?event=${stage.event.slug}`,
        { cookie: stage.app.cookie },
      );
      const other = await apiJson<{ pairings: PairingSummary[] }>(
        stack,
        "GET",
        `/api/pairings?event=${elsewhere.slug}`,
        { cookie: stage.app.cookie },
      );

      expect(mine.pairings.map((row) => row.id)).toContain(created.pairing.id);
      expect(other.pairings.map((row) => row.id)).not.toContain(
        created.pairing.id,
      );
    });

    it("refuses an anonymous visitor", async () => {
      const response = await apiRequest(stack, "GET", "/api/pairings");

      expect(response.status).toBe(401);
    });
  });

  describe("the pairing detail", () => {
    it("shows both parties the identical timeline", async () => {
      // FR-013: the timeline is what both organisations watch, and it is the same timeline.
      const stage = await scene();
      const created = await request(stage);
      await apiJson<PairingOutcome>(
        stack,
        "POST",
        `/api/pairings/${created.pairing.id}/fulfil`,
        { cookie: stage.server.cookie, body: { clientId: "shared-view-1" } },
      );

      const asApp = await apiJson<{ pairing: PairingDetail }>(
        stack,
        "GET",
        `/api/pairings/${created.pairing.id}`,
        { cookie: stage.app.cookie },
      );
      const asServer = await apiJson<{ pairing: PairingDetail }>(
        stack,
        "GET",
        `/api/pairings/${created.pairing.id}`,
        { cookie: stage.server.cookie },
      );

      expect(asApp.pairing.timeline).toEqual(asServer.pairing.timeline);
      expect(asApp.pairing.state).toBe("fulfilled");
      expect(asServer.pairing.clientId).toBe("shared-view-1");
      // What differs between the two readings is only whose side they are on.
      expect(asApp.pairing.sides).toEqual(["client"]);
      expect(asServer.pairing.sides).toEqual(["server"]);
    });

    it("shows the registration snapshot to the server organisation", async () => {
      // The point of the request: everything the server owner needs to register the client,
      // without asking a question by email.
      const stage = await scene();
      const created = await request(stage);

      const detail = await apiJson<{ pairing: PairingDetail }>(
        stack,
        "GET",
        `/api/pairings/${created.pairing.id}`,
        { cookie: stage.server.cookie },
      );

      expect(detail.pairing.registrationFields).toEqual(FIELDS);
    });

    it("carries no contact details", async () => {
      // Constitution principle V: a pairing names the person who acted, and how to reach them
      // stays behind the contacts route.
      const stage = await scene();
      const created = await request(stage);

      const detail = await apiJson<{ pairing: PairingDetail }>(
        stack,
        "GET",
        `/api/pairings/${created.pairing.id}`,
        { cookie: stage.server.cookie },
      );

      expect(JSON.stringify(detail)).not.toContain(stage.app.account.email);
    });

    it("refuses a member of neither organisation", async () => {
      const stage = await scene();
      const created = await request(stage);
      const outsider = await member("Passer-by");

      const response = await apiRequest(
        stack,
        "GET",
        `/api/pairings/${created.pairing.id}`,
        { cookie: outsider.cookie },
      );

      expect(response.status).toBe(404);
    });

    it("refuses an anonymous visitor", async () => {
      const stage = await scene();
      const created = await request(stage);

      const response = await apiRequest(
        stack,
        "GET",
        `/api/pairings/${created.pairing.id}`,
      );

      expect(response.status).toBe(401);
    });
  });

  describe("the scope warning", () => {
    /**
     * Records a check against the scene's server, advertising these scopes.
     *
     * Written straight to the repository rather than run through the scheduler: what this
     * block is about is the warning the pairing detail computes from a check, and the
     * scheduler's own suite covers producing one.
     */
    async function advertise(
      stage: Awaited<ReturnType<typeof scene>>,
      scopesSupported: readonly string[],
      checkedAt = new Date("2026-09-15T12:04:00.000Z"),
    ) {
      await insertCheckResult(stack.db, {
        enrolmentId: stage.serverEnrolment.id,
        checkedAt,
        reachable: true,
        failureMode: null,
        detail: null,
        discovery: {
          issuer: null,
          authorizationEndpoint: null,
          tokenEndpoint: "https://mr.test/token",
          registrationEndpoint: null,
          introspectionEndpoint: null,
          jwksUri: null,
          scopesSupported: [...scopesSupported],
          capabilities: [],
          grantTypesSupported: [],
          permissionTicketTypesSupported: [],
        },
        capability: null,
        driftFlags: [],
      });
    }

    /** The pairing as one side reads it. */
    async function detailAs(pairingId: string, cookie: string) {
      const body = await apiJson<{ pairing: PairingDetail }>(
        stack,
        "GET",
        `/api/pairings/${pairingId}`,
        { cookie },
      );
      return body.pairing;
    }

    it("warns both parties, naming the unsupported scopes (FR-019, scenario 4)", async () => {
      // Both, because an app owner who cannot see it goes on believing the pairing will
      // work and a server owner who cannot see it is asked to register something their
      // own server will refuse.
      const stage = await scene();
      const created = await request(stage);
      await advertise(stage, ["launch", "openid", "fhirUser"]);

      const asApp = await detailAs(created.pairing.id, stage.app.cookie);
      const asServer = await detailAs(created.pairing.id, stage.server.cookie);

      expect(asApp.scopeWarning).toEqual({
        unsupportedScopes: ["patient/Patient.rs"],
        checkedAt: "2026-09-15T12:04:00.000Z",
      });
      expect(asServer.scopeWarning).toEqual(asApp.scopeWarning);
    });

    it("says nothing when the server advertises every requested scope", async () => {
      const stage = await scene();
      const created = await request(stage);
      await advertise(stage, [
        "launch",
        "openid",
        "fhirUser",
        "patient/*.cruds",
      ]);

      expect(
        (await detailAs(created.pairing.id, stage.app.cookie)).scopeWarning,
      ).toBeNull();
    });

    it("says nothing when no check has run against the server", async () => {
      // A warning computed from nothing would name every scope the client asked for.
      const stage = await scene();
      const created = await request(stage);

      expect(
        (await detailAs(created.pairing.id, stage.app.cookie)).scopeWarning,
      ).toBeNull();
    });

    it("judges the snapshot the request carried, not the client's record today", async () => {
      // The registration fields are a snapshot (`data-model.md`), so the warning is about
      // what the server owner was actually asked to register.
      const stage = await scene();
      const created = await apiJson<PairingOutcome>(
        stack,
        "POST",
        "/api/pairings",
        {
          cookie: stage.app.cookie,
          body: requestBody(stage, {
            ...FIELDS,
            scopes: ["launch", "system/Binary.rs"],
          }),
        },
        201,
      );
      await advertise(stage, ["launch", "patient/*.rs"]);

      expect(
        (await detailAs(created.pairing.id, stage.app.cookie)).scopeWarning
          ?.unsupportedScopes,
      ).toEqual(["system/Binary.rs"]);
    });

    it("reads the newest check rather than the first one", async () => {
      // A server that has since added the scope should not be argued with, which is why
      // the warning carries the check's own time.
      const stage = await scene();
      const created = await request(stage);
      await advertise(
        stage,
        ["launch"],
        new Date("2026-09-15T09:31:00.000Z"),
      );
      await advertise(
        stage,
        ["launch", "openid", "fhirUser", "patient/Patient.rs"],
        new Date("2026-09-15T12:04:00.000Z"),
      );

      expect(
        (await detailAs(created.pairing.id, stage.server.cookie)).scopeWarning,
      ).toBeNull();
    });
  });

  describe("closing an event", () => {
    /** Closes one event as the track admin. */
    async function close(event: EventRow) {
      return await apiJson<{ event: EventDetail; lapsedPairings: number }>(
        stack,
        "PATCH",
        `/api/admin/events/${event.slug}`,
        { cookie: stack.adminCookie, body: { status: "closed" } },
      );
    }

    it("lapses the pairings still waiting for an answer", async () => {
      // FR-011, and the spec's edge case: the event ends while pairings are open.
      const stage = await scene();
      const created = await request(stage);

      const closed = await close(stage.event);

      expect(closed.event.status).toBe("closed");
      // Reported, so an admin closing an event knows what it did (FR-037).
      expect(closed.lapsedPairings).toBe(1);
      const detail = await apiJson<{ pairing: PairingDetail }>(
        stack,
        "GET",
        `/api/pairings/${created.pairing.id}`,
        { cookie: stage.app.cookie },
      );
      expect(detail.pairing.state).toBe("lapsed");
      expect(detail.pairing.timeline[1]?.toState).toBe("lapsed");
      // Neither side chose it, so both are told.
      expect(detail.pairing.timeline[1]?.notifies).toEqual([
        "client",
        "server",
      ]);
    });

    it("notifies both organisations", async () => {
      const stage = await scene();
      await request(stage);
      const before = {
        app: messagesFor(stage.app.account).length,
        server: messagesFor(stage.server.account).length,
      };

      await close(stage.event);

      expect(messagesFor(stage.app.account).length).toBe(before.app + 1);
      expect(messagesFor(stage.server.account).length).toBe(before.server + 1);
    });

    it("leaves an answered pairing alone", async () => {
      const stage = await scene();
      const created = await request(stage);
      await apiJson<PairingOutcome>(
        stack,
        "POST",
        `/api/pairings/${created.pairing.id}/fulfil`,
        { cookie: stage.server.cookie, body: { clientId: "issued-already" } },
      );

      const closed = await close(stage.event);

      expect(closed.lapsedPairings).toBe(0);
      const detail = await apiJson<{ pairing: PairingDetail }>(
        stack,
        "GET",
        `/api/pairings/${created.pairing.id}`,
        { cookie: stage.app.cookie },
      );
      // A fulfilled pairing is a fact about the event that happened; its records stay readable.
      expect(detail.pairing.state).toBe("fulfilled");
      expect(detail.pairing.timeline).toHaveLength(2);
    });

    it("reports no lapses when an event is merely opened", async () => {
      const draft = await makeEvent(stack.db);

      const opened = await apiJson<{
        event: EventDetail;
        lapsedPairings: number;
      }>(stack, "PATCH", `/api/admin/events/${draft.slug}`, {
        cookie: stack.adminCookie,
        body: { status: "open" },
      });

      expect(opened.event.status).toBe("open");
      expect(opened.lapsedPairings).toBe(0);
    });
  });

  describe("when the mail relay refuses", () => {
    let failing: TestStack;

    beforeAll(async () => {
      failing = await createTestStack({ mail: "failing" });
    });

    afterAll(async () => {
      await failing.close();
    });

    it("records the request and says the notification did not go", async () => {
      // FR-037: a request whose notification bounced is not the same outcome as one that
      // arrived, and the transition is recorded either way - re-sending is not something the
      // requester can do from here.
      const app = await failing.makeMember({ displayName: "Jo Chen" });
      const appCookie = await failing.signIn(app.email);
      const appOrganisation = await makeOrganisation(failing.db, app.id);
      const owner = await failing.makeMember({ displayName: "Sam Patel" });
      const ownerOrganisation = await makeOrganisation(failing.db, owner.id);
      const event = await makeEvent(failing.db, { status: "open" });
      const clientSystem = await makeSystem(failing.db, appOrganisation.id, {
        serverProfile: null,
        clientProfile: clientProfileFixture(),
      });
      const serverSystem = await makeSystem(failing.db, ownerOrganisation.id);
      const clientEnrolment = await makeEnrolment(failing.db, {
        event,
        systemId: clientSystem.id,
        accountId: app.id,
      });
      const serverEnrolment = await makeEnrolment(failing.db, {
        event,
        systemId: serverSystem.id,
        accountId: owner.id,
      });

      const created = await apiJson<PairingOutcome>(
        failing,
        "POST",
        "/api/pairings",
        {
          cookie: appCookie,
          body: {
            eventSlug: event.slug,
            clientEnrolmentId: clientEnrolment.id,
            serverEnrolmentId: serverEnrolment.id,
            registrationFields: FIELDS,
          },
        },
        201,
      );

      expect(created.pairing.state).toBe("requested");
      expect(created.notified).toBe(false);
    });
  });
});
