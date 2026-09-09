/*
 * Copyright © 2026 Commonwealth Scientific and Industrial Research Organisation
 * (CSIRO) ABN 41 687 119 230. Licensed under the Apache License, Version 2.0.
 */

import {
  pairingConflictSchema,
  pairingResponseSchema,
  pairingsResponseSchema,
} from "@muster/contracts";
import { insertCheckResult, updateAccountStatus } from "@muster/db";
import { describeDatabase, uniqueName } from "@muster/db/test/harness";
import { afterAll, beforeAll, expect, test } from "bun:test";

import {
  readJson,
  request,
  signUpAndSignIn,
  startTestServer,
} from "../test/support.ts";

import type { SignedIn, TestServer } from "../test/support.ts";
import type { RegistrationFields } from "@muster/contracts";

/**
 * The pairing tracker's routes.
 *
 * User Story 2 is a workflow between two organisations, so almost every test
 * here is about who may do what: the app owner requests, the server owner
 * fulfils or declines, and neither can take the other's action. The rest is about
 * both parties reading the same thing - one timeline, one state, one client
 * identifier - because the tracker exists so that neither has to ask the other
 * what happened (SC-002).
 */

describeDatabase("the pairing routes", () => {
  let server: TestServer;
  let admin: SignedIn;

  beforeAll(async () => {
    server = await startTestServer("pairing");
    admin = await arrangeMember(true);
  });

  afterAll(async () => {
    await server.close();
  });

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

  // The client profile the app owner's system declares.
  const clientProfile = {
    launchUrl: "https://smartforms.example.org/launch",
    redirectUris: ["https://smartforms.example.org/callback"],
    scopes: ["launch/patient", "patient/Observation.rs"],
    confidentiality: "public",
    launchContext: "patient",
    needsIntrospection: false,
  };

  // The field set the app owner submits, prefilled from the client record.
  const registrationFields: RegistrationFields = {
    clientName: "Smart Forms",
    launchUrl: clientProfile.launchUrl,
    redirectUris: clientProfile.redirectUris,
    scopes: clientProfile.scopes,
    confidentiality: "public",
    launchContext: "patient",
    needsIntrospection: false,
  };

  // A server profile with the registration mode under test.
  const serverProfile = (registrationMode: string) => ({
    fhirBaseUrl: "https://fhir.medirecords.example.org",
    authorizationMode: "smart",
    registrationMode,
    ...(registrationMode === "trustedDcr"
      ? {
          registrationEndpoint: "https://fhir.medirecords.example.org/register",
        }
      : {}),
    notes: "",
  });

  // Arranges an organisation owned by a member.
  const arrangeOrganisation = async (
    member: SignedIn,
    name: string,
  ): Promise<string> => {
    const response = await request(server, "POST", "/api/organisations", {
      body: { name },
      cookie: member.cookie,
    });
    expect(response.status).toBe(201);
    return idOf(response, "organisation");
  };

  // Arranges a system with whichever profiles it needs.
  const arrangeSystem = async (
    member: SignedIn,
    organisationId: string,
    name: string,
    profiles: Record<string, unknown>,
  ): Promise<string> => {
    const response = await request(
      server,
      "POST",
      `/api/organisations/${organisationId}/systems`,
      {
        body: { name, description: "", ...profiles },
        cookie: member.cookie,
      },
    );
    expect(response.status).toBe(201);
    return idOf(response, "system");
  };

  // Arranges an event through the admin routes.
  const arrangeEvent = async (
    status: "draft" | "open" | "closed" = "open",
  ): Promise<string> => {
    const slug = uniqueName("event").replaceAll("_", "-");
    const response = await request(server, "POST", "/api/admin/events", {
      body: {
        slug,
        name: "Sparked connectathon",
        startsOn: "2026-09-01",
        endsOn: "2026-09-03",
        status,
        capabilityTags: [],
      },
      cookie: admin.cookie,
    });
    expect(response.status).toBe(201);
    return slug;
  };

  // Enrols a system into an event, answering with the enrolment's identifier.
  const arrangeEnrolment = async (
    member: SignedIn,
    slug: string,
    systemId: string,
  ): Promise<string> => {
    const response = await request(
      server,
      "POST",
      `/api/events/${slug}/enrolments`,
      { body: { systemId, tags: [] }, cookie: member.cookie },
    );
    expect(response.status).toBe(201);
    return idOf(response, "enrolment");
  };

  /** Two organisations, an event, and an enrolment on each side of it. */
  type Stage = {
    /** the app owner */
    readonly appOwner: SignedIn;
    /** the server owner */
    readonly serverOwner: SignedIn;
    /** the app owner's organisation */
    readonly appOrganisationId: string;
    /** the server owner's organisation */
    readonly serverOrganisationId: string;
    /** the event both are enrolled in */
    readonly slug: string;
    /** the client enrolment */
    readonly clientEnrolmentId: string;
    /** the server enrolment */
    readonly serverEnrolmentId: string;
  };

  // Arranges everything a pairing needs: two organisations, an event, and an
  // enrolled client and server.
  const arrangeStage = async (
    registrationMode = "manual",
    status: "draft" | "open" | "closed" = "open",
  ): Promise<Stage> => {
    const appOwner = await arrangeMember();
    const serverOwner = await arrangeMember();
    const appOrganisationId = await arrangeOrganisation(appOwner, "CSIRO");
    const serverOrganisationId = await arrangeOrganisation(
      serverOwner,
      "MediRecords",
    );
    const slug = await arrangeEvent(status);
    const clientSystemId = await arrangeSystem(
      appOwner,
      appOrganisationId,
      "Smart Forms",
      { clientProfile },
    );
    const serverSystemId = await arrangeSystem(
      serverOwner,
      serverOrganisationId,
      "MediRecords FHIR",
      { serverProfile: serverProfile(registrationMode) },
    );
    return {
      appOwner,
      serverOwner,
      appOrganisationId,
      serverOrganisationId,
      slug,
      clientEnrolmentId: await arrangeEnrolment(appOwner, slug, clientSystemId),
      serverEnrolmentId: await arrangeEnrolment(
        serverOwner,
        slug,
        serverSystemId,
      ),
    };
  };

  // Requests a pairing as the app owner.
  const requestPairing = async (
    stage: Stage,
    overrides: Record<string, unknown> = {},
    as: SignedIn = stage.appOwner,
  ): Promise<Response> =>
    request(server, "POST", "/api/pairings", {
      body: {
        eventSlug: stage.slug,
        clientEnrolmentId: stage.clientEnrolmentId,
        serverEnrolmentId: stage.serverEnrolmentId,
        registrationFields,
        ...overrides,
      },
      cookie: as.cookie,
    });

  // Requests a pairing and asserts it was created.
  const arrangePairing = async (stage: Stage): Promise<string> => {
    const response = await requestPairing(stage);
    expect(response.status).toBe(201);
    return idOf(response, "pairing");
  };

  // Requesting ----------------------------------------------------------------

  // Acceptance scenario 1: the pairing is created as requested, carrying the
  // field set the app owner submitted, and the server's members are notified.
  test("creates a requested pairing and notifies the server's organisation", async () => {
    const stage = await arrangeStage();

    const response = await requestPairing(stage);

    expect(response.status).toBe(201);
    const { pairing } = await readJson(response, pairingResponseSchema);
    expect(pairing.state).toBe("requested");
    expect(pairing.registrationFields).toEqual(registrationFields);
    expect(pairing.client.systemName).toBe("Smart Forms");
    expect(pairing.server.systemName).toBe("MediRecords FHIR");
    expect(pairing.registrationMode).toBe("manual");
    expect(pairing.clientId).toBeNull();
    expect(pairing.sides).toEqual(["client"]);

    // The first timeline entry is the request itself, recorded against the
    // organisation it was made for (FR-013).
    expect(pairing.timeline).toHaveLength(1);
    expect(pairing.timeline[0]?.fromState).toBeNull();
    expect(pairing.timeline[0]?.toState).toBe("requested");
    expect(pairing.timeline[0]?.actingFor?.name).toBe("CSIRO");

    const notification = server.sentMail.at(-1) ?? "";
    expect(notification).toContain(`To: ${stage.serverOwner.email}`);
    expect(notification).toContain("MediRecords FHIR");
    expect(notification).toContain("Smart Forms");
    expect(notification).toContain(`/pairings/${pairing.id}`);
  });

  // FR-012: the field set is editable before submission, and what is stored is
  // what was submitted rather than what the client record happens to say now.
  test("stores the submitted field set rather than the client record", async () => {
    const stage = await arrangeStage();
    const edited: RegistrationFields = {
      ...registrationFields,
      clientName: "Smart Forms (connectathon build)",
      scopes: ["launch/patient"],
    };

    const response = await requestPairing(stage, {
      registrationFields: edited,
    });

    const { pairing } = await readJson(response, pairingResponseSchema);
    expect(pairing.registrationFields).toEqual(edited);
  });

  // FR-015 and the specification's edge case: the second request is refused and
  // the existing pairing is named, so the console can offer it.
  test("refuses a duplicate request and names the existing pairing", async () => {
    const stage = await arrangeStage();
    const first = await arrangePairing(stage);

    const response = await requestPairing(stage);

    expect(response.status).toBe(409);
    const conflict = await readJson(response, pairingConflictSchema);
    expect(conflict.error).toBe("conflict");
    expect(conflict.pairingId).toBe(first);
    expect(conflict.detail).toContain("already");
  });

  // FR-016, acceptance scenario 5: an open server needs no registration, so a
  // pairing against it is refused rather than tracked.
  test("refuses a request against a server that needs no registration", async () => {
    const stage = await arrangeStage("open");

    const response = await requestPairing(stage);

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      detail: expect.stringContaining("no registration"),
    });
  });

  // A trusted-DCR server takes requests like a manual one; who fulfils it is
  // what differs, and that is User Story 5.
  test("accepts a request against a trusted-DCR server", async () => {
    const stage = await arrangeStage("trustedDcr");

    const response = await requestPairing(stage);

    expect(response.status).toBe(201);
    const { pairing } = await readJson(response, pairingResponseSchema);
    expect(pairing.registrationMode).toBe("trustedDcr");
  });

  // Acceptance scenario 6: pairings exist within a single event.
  test("refuses a request naming an enrolment from another event", async () => {
    const stage = await arrangeStage();
    const otherStage = await arrangeStage();

    const response = await requestPairing(stage, {
      serverEnrolmentId: otherStage.serverEnrolmentId,
    });

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      detail: expect.stringContaining("server"),
    });
  });

  // FR-011: a closed event takes no new pairing requests.
  test("refuses a request against a closed event", async () => {
    const stage = await arrangeStage();
    await request(server, "PATCH", `/api/admin/events/${stage.slug}`, {
      body: { status: "closed" },
      cookie: admin.cookie,
    });

    const response = await requestPairing(stage);

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      detail: expect.stringContaining("closed"),
    });
  });

  // Only the client's organisation asks for a client of theirs to be registered.
  test("refuses a request by an organisation on neither side", async () => {
    const stage = await arrangeStage();
    const outsider = await arrangeMember();

    const response = await requestPairing(stage, {}, outsider);

    expect(response.status).toBe(403);
  });

  test("refuses a request made by the server's organisation", async () => {
    const stage = await arrangeStage();

    const response = await requestPairing(stage, {}, stage.serverOwner);

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      detail: expect.stringContaining("client"),
    });
  });

  // A system with no client profile cannot be the client side, and a system with
  // no server profile cannot be the server side.
  test("refuses a request whose client side is not a client", async () => {
    const stage = await arrangeStage();

    const response = await requestPairing(stage, {
      clientEnrolmentId: stage.serverEnrolmentId,
    });

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      detail: expect.stringContaining("client"),
    });
  });

  test("refuses a request whose server side is not a server", async () => {
    const stage = await arrangeStage();

    const response = await requestPairing(stage, {
      serverEnrolmentId: stage.clientEnrolmentId,
    });

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      detail: expect.stringContaining("server"),
    });
  });

  test("refuses an anonymous request", async () => {
    const stage = await arrangeStage();

    const response = await request(server, "POST", "/api/pairings", {
      body: {
        eventSlug: stage.slug,
        clientEnrolmentId: stage.clientEnrolmentId,
        serverEnrolmentId: stage.serverEnrolmentId,
        registrationFields,
      },
    });

    expect(response.status).toBe(401);
  });

  test("refuses a request naming an event that does not exist", async () => {
    const stage = await arrangeStage();

    const response = await requestPairing(stage, {
      eventSlug: "no-such-event",
    });

    expect(response.status).toBe(404);
  });

  test("refuses a request naming an enrolment that does not exist", async () => {
    const stage = await arrangeStage();

    const response = await requestPairing(stage, {
      serverEnrolmentId: "6b3d6f27-77c6-4f52-9c37-9ab7d6a4a0f1",
    });

    expect(response.status).toBe(422);
  });

  // Fulfilling and declining --------------------------------------------------

  // Acceptance scenario 2: the server's organisation records the identifier, the
  // app owner is notified, and both sides see it.
  test("fulfils a pairing for the server's organisation and notifies the owner", async () => {
    const stage = await arrangeStage();
    const pairingId = await arrangePairing(stage);

    const response = await request(
      server,
      "POST",
      `/api/pairings/${pairingId}/fulfil`,
      {
        body: { clientId: "smart-forms-test-1" },
        cookie: stage.serverOwner.cookie,
      },
    );

    expect(response.status).toBe(200);
    const { pairing } = await readJson(response, pairingResponseSchema);
    expect(pairing.state).toBe("fulfilled");
    expect(pairing.clientId).toBe("smart-forms-test-1");
    expect(pairing.timeline).toHaveLength(2);
    expect(pairing.timeline[1]?.fromState).toBe("requested");
    expect(pairing.timeline[1]?.toState).toBe("fulfilled");
    expect(pairing.timeline[1]?.actingFor?.name).toBe("MediRecords");
    expect(pairing.timeline[1]?.detail.clientId).toBe("smart-forms-test-1");

    const notification = server.sentMail.at(-1) ?? "";
    expect(notification).toContain(`To: ${stage.appOwner.email}`);
    expect(notification).toContain("smart-forms-test-1");
  });

  // Acceptance scenario 4: both parties read the same state and the same history.
  test("shows both parties the same state and the same timeline", async () => {
    const stage = await arrangeStage();
    const pairingId = await arrangePairing(stage);
    await request(server, "POST", `/api/pairings/${pairingId}/fulfil`, {
      body: { clientId: "smart-forms-test-1" },
      cookie: stage.serverOwner.cookie,
    });

    const asApp = await readJson(
      await request(server, "GET", `/api/pairings/${pairingId}`, {
        cookie: stage.appOwner.cookie,
      }),
      pairingResponseSchema,
    );
    const asServer = await readJson(
      await request(server, "GET", `/api/pairings/${pairingId}`, {
        cookie: stage.serverOwner.cookie,
      }),
      pairingResponseSchema,
    );

    expect(asApp.pairing.state).toBe("fulfilled");
    expect(asApp.pairing.clientId).toBe("smart-forms-test-1");
    expect(asApp.pairing.timeline).toEqual(asServer.pairing.timeline);
    // The one difference is which side the reader is on.
    expect(asApp.pairing.sides).toEqual(["client"]);
    expect(asServer.pairing.sides).toEqual(["server"]);
  });

  // Acceptance scenario 3: the reason reaches the app owner, on screen and by
  // email.
  test("declines a pairing with a reason and notifies the owner", async () => {
    const stage = await arrangeStage();
    const pairingId = await arrangePairing(stage);

    const response = await request(
      server,
      "POST",
      `/api/pairings/${pairingId}/decline`,
      {
        body: { reason: "That redirect URI is not on our allowed list." },
        cookie: stage.serverOwner.cookie,
      },
    );

    expect(response.status).toBe(200);
    const { pairing } = await readJson(response, pairingResponseSchema);
    expect(pairing.state).toBe("declined");
    expect(pairing.declineReason).toBe(
      "That redirect URI is not on our allowed list.",
    );
    expect(pairing.timeline.at(-1)?.detail.reason).toBe(
      "That redirect URI is not on our allowed list.",
    );

    const notification = server.sentMail.at(-1) ?? "";
    expect(notification).toContain(`To: ${stage.appOwner.email}`);
    expect(notification).toContain("not on our allowed list");
  });

  // FR-014: the identifier comes from the server's organisation, so the app owner
  // cannot record one for themselves.
  test("refuses a fulfilment by the client's organisation", async () => {
    const stage = await arrangeStage();
    const pairingId = await arrangePairing(stage);

    const response = await request(
      server,
      "POST",
      `/api/pairings/${pairingId}/fulfil`,
      { body: { clientId: "self-issued" }, cookie: stage.appOwner.cookie },
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      detail: expect.stringContaining("server"),
    });
  });

  test("refuses a decline by the client's organisation", async () => {
    const stage = await arrangeStage();
    const pairingId = await arrangePairing(stage);

    const response = await request(
      server,
      "POST",
      `/api/pairings/${pairingId}/decline`,
      { body: { reason: "No thanks." }, cookie: stage.appOwner.cookie },
    );

    expect(response.status).toBe(403);
  });

  test("refuses a fulfilment by an organisation on neither side", async () => {
    const stage = await arrangeStage();
    const pairingId = await arrangePairing(stage);
    const outsider = await arrangeMember();

    const response = await request(
      server,
      "POST",
      `/api/pairings/${pairingId}/fulfil`,
      { body: { clientId: "x" }, cookie: outsider.cookie },
    );

    expect(response.status).toBe(403);
  });

  // US5: a trusted-DCR pairing is fulfilled by the run, which records what the
  // server's own endpoint issued. Typing an identifier in instead would have
  // Muster report a registration nothing performed, and leave the pairing
  // settled so the run could never be made - so it is refused, and the pairing
  // is left where it was.
  test("refuses a hand fulfilment at a trusted-DCR server", async () => {
    const stage = await arrangeStage("trustedDcr");
    const pairingId = await arrangePairing(stage);

    const response = await request(
      server,
      "POST",
      `/api/pairings/${pairingId}/fulfil`,
      { body: { clientId: "invented" }, cookie: stage.serverOwner.cookie },
    );

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      detail: expect.stringContaining("vouches"),
    });

    const { pairing } = await readJson(
      await request(server, "GET", `/api/pairings/${pairingId}`, {
        cookie: stage.serverOwner.cookie,
      }),
      pairingResponseSchema,
    );
    expect(pairing.state).toBe("requested");
    expect(pairing.clientId).toBeNull();
    expect(pairing.timeline).toHaveLength(1);
  });

  // The other action stays available: a server's organisation that has changed
  // its mind about a particular client can still say so, and a decline records
  // only what they said.
  test("declines a trusted-DCR pairing for the server's organisation", async () => {
    const stage = await arrangeStage("trustedDcr");
    const pairingId = await arrangePairing(stage);

    const response = await request(
      server,
      "POST",
      `/api/pairings/${pairingId}/decline`,
      {
        body: { reason: "Not for this event." },
        cookie: stage.serverOwner.cookie,
      },
    );

    expect(response.status).toBe(200);
    const { pairing } = await readJson(response, pairingResponseSchema);
    expect(pairing.state).toBe("declined");
  });

  // A settled pairing does not move again: the second fulfilment is refused
  // rather than overwriting the first, so nobody is left wondering which
  // identifier is current.
  test("refuses to fulfil a pairing that has been declined", async () => {
    const stage = await arrangeStage();
    const pairingId = await arrangePairing(stage);
    await request(server, "POST", `/api/pairings/${pairingId}/decline`, {
      body: { reason: "No." },
      cookie: stage.serverOwner.cookie,
    });

    const response = await request(
      server,
      "POST",
      `/api/pairings/${pairingId}/fulfil`,
      { body: { clientId: "late" }, cookie: stage.serverOwner.cookie },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      detail: expect.stringContaining("declined"),
    });
  });

  test("refuses to fulfil a pairing that does not exist", async () => {
    const stage = await arrangeStage();

    const response = await request(
      server,
      "POST",
      "/api/pairings/6b3d6f27-77c6-4f52-9c37-9ab7d6a4a0f1/fulfil",
      { body: { clientId: "x" }, cookie: stage.serverOwner.cookie },
    );

    expect(response.status).toBe(404);
  });

  test("refuses a fulfilment with no client identifier", async () => {
    const stage = await arrangeStage();
    const pairingId = await arrangePairing(stage);

    const response = await request(
      server,
      "POST",
      `/api/pairings/${pairingId}/fulfil`,
      { body: { clientId: "  " }, cookie: stage.serverOwner.cookie },
    );

    expect(response.status).toBe(400);
  });

  test("refuses a decline with no reason", async () => {
    const stage = await arrangeStage();
    const pairingId = await arrangePairing(stage);

    const response = await request(
      server,
      "POST",
      `/api/pairings/${pairingId}/decline`,
      { body: { reason: "" }, cookie: stage.serverOwner.cookie },
    );

    expect(response.status).toBe(400);
  });

  // The specification's edge case: one member in both organisations acts for
  // either side, and the timeline says which side each action was taken for.
  test("lets a member of both organisations act for either side", async () => {
    const stage = await arrangeStage();
    await request(
      server,
      "POST",
      `/api/organisations/${stage.serverOrganisationId}/members`,
      {
        body: { email: stage.appOwner.email },
        cookie: stage.serverOwner.cookie,
      },
    );
    const pairingId = await arrangePairing(stage);

    const response = await request(
      server,
      "POST",
      `/api/pairings/${pairingId}/fulfil`,
      { body: { clientId: "both-sides-1" }, cookie: stage.appOwner.cookie },
    );

    expect(response.status).toBe(200);
    const { pairing } = await readJson(response, pairingResponseSchema);
    expect(pairing.sides.toSorted()).toEqual(["client", "server"]);
    expect(pairing.timeline[0]?.actingFor?.name).toBe("CSIRO");
    expect(pairing.timeline[1]?.actingFor?.name).toBe("MediRecords");
  });

  // Reading -------------------------------------------------------------------

  // FR-013: the list is every pairing involving the caller's organisations, in
  // both directions.
  test("lists a pairing for both parties and for nobody else", async () => {
    const stage = await arrangeStage();
    const outsider = await arrangeMember();
    const pairingId = await arrangePairing(stage);

    const asApp = await readJson(
      await request(server, "GET", `/api/pairings?event=${stage.slug}`, {
        cookie: stage.appOwner.cookie,
      }),
      pairingsResponseSchema,
    );
    const asServer = await readJson(
      await request(server, "GET", `/api/pairings?event=${stage.slug}`, {
        cookie: stage.serverOwner.cookie,
      }),
      pairingsResponseSchema,
    );
    const asOutsider = await readJson(
      await request(server, "GET", `/api/pairings?event=${stage.slug}`, {
        cookie: outsider.cookie,
      }),
      pairingsResponseSchema,
    );

    expect(asApp.pairings.map((pairing) => pairing.id)).toEqual([pairingId]);
    expect(asApp.pairings[0]?.sides).toEqual(["client"]);
    expect(asServer.pairings.map((pairing) => pairing.id)).toEqual([pairingId]);
    expect(asServer.pairings[0]?.sides).toEqual(["server"]);
    expect(asOutsider.pairings).toEqual([]);
  });

  // Deny by default: a list request that does not say which event is not
  // answered with every event's pairings.
  test("refuses a list request that names no event", async () => {
    const stage = await arrangeStage();

    const response = await request(server, "GET", "/api/pairings", {
      cookie: stage.appOwner.cookie,
    });

    expect(response.status).toBe(400);
  });

  test("refuses to show a pairing to an organisation on neither side", async () => {
    const stage = await arrangeStage();
    const pairingId = await arrangePairing(stage);
    const outsider = await arrangeMember();

    const response = await request(
      server,
      "GET",
      `/api/pairings/${pairingId}`,
      {
        cookie: outsider.cookie,
      },
    );

    expect(response.status).toBe(403);
  });

  test("refuses to show a pairing to an anonymous reader", async () => {
    const stage = await arrangeStage();
    const pairingId = await arrangePairing(stage);

    const response = await request(server, "GET", `/api/pairings/${pairingId}`);

    expect(response.status).toBe(401);
  });

  test("answers 404 for a pairing that does not exist", async () => {
    const stage = await arrangeStage();

    const response = await request(
      server,
      "GET",
      "/api/pairings/6b3d6f27-77c6-4f52-9c37-9ab7d6a4a0f1",
      { cookie: stage.appOwner.cookie },
    );

    expect(response.status).toBe(404);
  });

  // Lapsing on close ----------------------------------------------------------

  // FR-011: closing an event lapses what is still open, recording the transition
  // on the timeline like any other.
  test("lapses an open pairing when the event closes", async () => {
    const stage = await arrangeStage();
    const pairingId = await arrangePairing(stage);

    const closed = await request(
      server,
      "PATCH",
      `/api/admin/events/${stage.slug}`,
      { body: { status: "closed" }, cookie: admin.cookie },
    );
    expect(closed.status).toBe(200);

    const { pairing } = await readJson(
      await request(server, "GET", `/api/pairings/${pairingId}`, {
        cookie: stage.appOwner.cookie,
      }),
      pairingResponseSchema,
    );
    expect(pairing.state).toBe("lapsed");
    expect(pairing.timeline.at(-1)?.fromState).toBe("requested");
    expect(pairing.timeline.at(-1)?.toState).toBe("lapsed");
    // Nobody acted for a side: the event closing is Muster's own doing.
    expect(pairing.timeline.at(-1)?.actingFor).toBeNull();
  });

  // A settled pairing is a record, and closing the event does not rewrite it.
  test("leaves a fulfilled pairing alone when the event closes", async () => {
    const stage = await arrangeStage();
    const pairingId = await arrangePairing(stage);
    await request(server, "POST", `/api/pairings/${pairingId}/fulfil`, {
      body: { clientId: "smart-forms-test-1" },
      cookie: stage.serverOwner.cookie,
    });

    await request(server, "PATCH", `/api/admin/events/${stage.slug}`, {
      body: { status: "closed" },
      cookie: admin.cookie,
    });

    const { pairing } = await readJson(
      await request(server, "GET", `/api/pairings/${pairingId}`, {
        cookie: stage.appOwner.cookie,
      }),
      pairingResponseSchema,
    );
    expect(pairing.state).toBe("fulfilled");
    expect(pairing.timeline).toHaveLength(2);
  });

  // A closed event's pairings stay readable, and take no further action.
  test("refuses to fulfil a pairing that lapsed when the event closed", async () => {
    const stage = await arrangeStage();
    const pairingId = await arrangePairing(stage);
    await request(server, "PATCH", `/api/admin/events/${stage.slug}`, {
      body: { status: "closed" },
      cookie: admin.cookie,
    });

    const response = await request(
      server,
      "POST",
      `/api/pairings/${pairingId}/fulfil`,
      { body: { clientId: "too-late" }, cookie: stage.serverOwner.cookie },
    );

    expect(response.status).toBe(409);
  });

  // Records a check of the pairing's server, advertising the given scopes.
  const arrangeCheck = async (
    stage: Stage,
    scopesSupported: readonly string[],
  ): Promise<void> => {
    await insertCheckResult(server.database.sql, {
      enrolmentId: stage.serverEnrolmentId,
      checkedAt: new Date("2026-08-19T01:00:00.000Z"),
      reachable: true,
      failureMode: null,
      detail: null,
      discovery: {
        issuer: "https://auth.medirecords.example.org",
        authorizationEndpoint: "https://auth.medirecords.example.org/authorize",
        tokenEndpoint: "https://auth.medirecords.example.org/token",
        registrationEndpoint: null,
        scopesSupported: [...scopesSupported],
        capabilities: [],
      },
      capability: null,
      driftFlags: [],
    });
  };

  // Reads a pairing as one party.
  const readPairing = async (pairingId: string, as: SignedIn) =>
    readJson(
      await request(server, "GET", `/api/pairings/${pairingId}`, {
        cookie: as.cookie,
      }),
      pairingResponseSchema,
    );

  // FR-019 and acceptance scenario 4: both parties are warned, with the
  // unsupported scopes named, before either wastes a morning on them.
  test("warns both parties about a scope the server does not advertise", async () => {
    const stage = await arrangeStage();
    const pairingId = await arrangePairing(stage);
    await arrangeCheck(stage, ["launch/patient", "patient/Patient.rs"]);

    const asAppOwner = await readPairing(pairingId, stage.appOwner);
    const asServerOwner = await readPairing(pairingId, stage.serverOwner);

    expect(asAppOwner.pairing.scopeWarning).toEqual({
      unsupportedScopes: ["patient/Observation.rs"],
      advertisedScopes: ["launch/patient", "patient/Patient.rs"],
      checkedAt: "2026-08-19T01:00:00.000Z",
    });
    // One record, one warning: neither party is shown something the other is not.
    expect(asServerOwner.pairing.scopeWarning).toEqual(
      asAppOwner.pairing.scopeWarning,
    );
  });

  test("carries no warning when the server advertises every requested scope", async () => {
    const stage = await arrangeStage();
    const pairingId = await arrangePairing(stage);
    await arrangeCheck(stage, ["launch/patient", "patient/*.rs"]);

    expect(
      (await readPairing(pairingId, stage.appOwner)).pairing.scopeWarning,
    ).toBeNull();
  });

  // Nothing has been checked, so nothing is known: a warning drawn from silence
  // would be a guess, and the pairing says nothing rather than guessing.
  test("carries no warning when nothing has checked the server", async () => {
    const stage = await arrangeStage();
    const pairingId = await arrangePairing(stage);

    expect(
      (await readPairing(pairingId, stage.appOwner)).pairing.scopeWarning,
    ).toBeNull();
  });

  // Opening an event again, or editing it, does not lapse anything.
  test("lapses nothing when an event is edited without closing", async () => {
    const stage = await arrangeStage();
    const pairingId = await arrangePairing(stage);

    await request(server, "PATCH", `/api/admin/events/${stage.slug}`, {
      body: { name: "Sparked connectathon, renamed" },
      cookie: admin.cookie,
    });

    const { pairing } = await readJson(
      await request(server, "GET", `/api/pairings/${pairingId}`, {
        cookie: stage.appOwner.cookie,
      }),
      pairingResponseSchema,
    );
    expect(pairing.state).toBe("requested");
  });
});
