import {
  accountsResponseSchema,
  contactsResponseSchema,
  eventSystemsSchema,
  systemsResponseSchema,
} from "@muster/contracts";
import { updateAccountStatus } from "@muster/db";
import { describeDatabase, uniqueName } from "@muster/db/test/harness";
import { afterAll, beforeAll, expect, test } from "bun:test";

import {
  readJson,
  request,
  signUpAndSignIn,
  startTestServer,
} from "../test/support.ts";

import type { SignedIn, TestServer } from "../test/support.ts";

/**
 * Who may change the directory, and what happens when they do.
 *
 * The rule under test throughout is that rights are never implied: an approved
 * member may act for the organisations they belong to and for no others, an
 * admin route needs the admin flag, and an event that is not open takes nothing
 * new.
 */

describeDatabase("the directory routes", () => {
  let server: TestServer;
  let admin: SignedIn;

  beforeAll(async () => {
    server = await startTestServer("directory");
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
    if (
      typeof body === "object" &&
      body !== null &&
      key in body &&
      typeof body[key as keyof typeof body] === "object"
    ) {
      const resource: unknown = body[key as keyof typeof body];
      if (
        typeof resource === "object" &&
        resource !== null &&
        "id" in resource
      ) {
        return String(resource.id);
      }
    }
    throw new Error(`No ${key}.id in ${JSON.stringify(body)}`);
  };

  // Arranges an organisation owned by a member.
  const arrangeOrganisation = async (
    member: SignedIn,
    name = "MediRecords",
  ): Promise<string> => {
    const response = await request(server, "POST", "/api/organisations", {
      body: { name },
      cookie: member.cookie,
    });
    expect(response.status).toBe(201);
    return idOf(response, "organisation");
  };

  const serverProfile = {
    fhirBaseUrl: "https://fhir.medirecords.example.org",
    authorizationMode: "smart",
    registrationMode: "manual",
    notes: "Ask for a client id.",
  };

  const clientProfile = {
    launchUrl: "https://smartforms.example.org/launch",
    redirectUris: ["https://smartforms.example.org/callback"],
    scopes: ["launch/patient", "patient/Observation.rs"],
    confidentiality: "public",
    launchContext: "patient",
    needsIntrospection: false,
  };

  // Arranges a server system owned by an organisation.
  const arrangeSystem = async (
    member: SignedIn,
    organisationId: string,
    name = "MediRecords FHIR",
  ): Promise<string> => {
    const response = await request(
      server,
      "POST",
      `/api/organisations/${organisationId}/systems`,
      {
        body: { name, description: "A FHIR server.", serverProfile },
        cookie: member.cookie,
      },
    );
    expect(response.status).toBe(201);
    return idOf(response, "system");
  };

  // Arranges an event through the admin routes.
  const arrangeEvent = async (
    status: "draft" | "open" | "closed" = "open",
    tags: readonly string[] = ["form renderer host", "form filler"],
  ): Promise<string> => {
    const slug = uniqueName("event").replaceAll("_", "-");
    const response = await request(server, "POST", "/api/admin/events", {
      body: {
        slug,
        name: "Sparked connectathon",
        startsOn: "2026-09-01",
        endsOn: "2026-09-03",
        status,
        capabilityTags: tags,
      },
      cookie: admin.cookie,
    });
    expect(response.status).toBe(201);
    return slug;
  };

  // Organisations and members ------------------------------------------------

  // FR-005: the creator is the first member, and members see the contacts.
  test("makes the creator the first member of an organisation", async () => {
    const member = await arrangeMember();
    const organisationId = await arrangeOrganisation(member);

    const contacts = await request(
      server,
      "GET",
      `/api/organisations/${organisationId}/contacts`,
      { cookie: member.cookie },
    );

    expect(contacts.status).toBe(200);
    expect(await contacts.json()).toEqual({
      contacts: [
        {
          accountId: member.id,
          displayName: member.email,
          email: member.email,
        },
      ],
    });
  });

  // FR-007: contact details are for members of the organisation.
  test("refuses an outsider the organisation's contacts", async () => {
    const member = await arrangeMember();
    const outsider = await arrangeMember();
    const organisationId = await arrangeOrganisation(member);

    const response = await request(
      server,
      "GET",
      `/api/organisations/${organisationId}/contacts`,
      { cookie: outsider.cookie },
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: "forbidden",
      detail: expect.stringContaining("owning organisation"),
    });
  });

  test("adds an approved account as a member and lets it manage the systems", async () => {
    const member = await arrangeMember();
    const colleague = await arrangeMember();
    const organisationId = await arrangeOrganisation(member);

    const added = await request(
      server,
      "POST",
      `/api/organisations/${organisationId}/members`,
      { body: { email: colleague.email }, cookie: member.cookie },
    );

    expect(added.status).toBe(201);
    const body = await readJson(added, contactsResponseSchema);
    expect(body.contacts.map((contact) => contact.accountId).sort()).toEqual(
      [member.id, colleague.id].sort(),
    );
    // The invited member is told, and can now act for the organisation.
    expect(server.sentMail.at(-1)).toContain(`To: ${colleague.email}`);
    await arrangeSystem(colleague, organisationId, "Added By Colleague");
  });

  // FR-005: only approved accounts can be invited, so an organisation cannot be
  // used to smuggle rights to an unapproved account.
  test("refuses to add an account that is not approved", async () => {
    const member = await arrangeMember();
    const pending = await signUpAndSignIn(
      server,
      `${uniqueName("pending")}@example.org`,
    );
    const organisationId = await arrangeOrganisation(member);

    const response = await request(
      server,
      "POST",
      `/api/organisations/${organisationId}/members`,
      { body: { email: pending.email }, cookie: member.cookie },
    );

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      detail: expect.stringContaining("cannot be given rights"),
    });
  });

  // The spec's edge case: the last member leaves and an admin reassigns.
  test("removes a member, and lets an admin reassign the orphan", async () => {
    const member = await arrangeMember();
    const rescuer = await arrangeMember();
    const organisationId = await arrangeOrganisation(member);
    await arrangeSystem(member, organisationId);

    const removed = await request(
      server,
      "DELETE",
      `/api/organisations/${organisationId}/members/${member.id}`,
      { cookie: member.cookie },
    );
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ contacts: [] });

    // Unmanageable, but not gone: the former member is now an outsider.
    expect(
      (
        await request(
          server,
          "GET",
          `/api/organisations/${organisationId}/contacts`,
          { cookie: member.cookie },
        )
      ).status,
    ).toBe(403);

    const reassigned = await request(
      server,
      "POST",
      `/api/admin/organisations/${organisationId}/reassign`,
      { body: { email: rescuer.email }, cookie: admin.cookie },
    );
    expect(reassigned.status).toBe(200);
    const body = await readJson(reassigned, contactsResponseSchema);
    expect(body.contacts.map((contact) => contact.accountId)).toEqual([
      rescuer.id,
    ]);
  });

  test("refuses a reassignment by anyone but an admin", async () => {
    const member = await arrangeMember();
    const organisationId = await arrangeOrganisation(member);

    const response = await request(
      server,
      "POST",
      `/api/admin/organisations/${organisationId}/reassign`,
      { body: { email: member.email }, cookie: member.cookie },
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      detail: expect.stringContaining("admins only"),
    });
  });

  // Systems -------------------------------------------------------------------

  test("records a system with the profiles it was given", async () => {
    const member = await arrangeMember();
    const organisationId = await arrangeOrganisation(member);

    const created = await request(
      server,
      "POST",
      `/api/organisations/${organisationId}/systems`,
      {
        body: {
          name: "Smart Forms",
          description: "A form filler.",
          clientProfile,
        },
        cookie: member.cookie,
      },
    );

    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({
      system: {
        name: "Smart Forms",
        kinds: ["client"],
        serverProfile: null,
        clientProfile,
        organisationId,
      },
    });
  });

  // The console cannot manage what it cannot see, so an organisation's own
  // members read its systems back - and nobody else does, because a system
  // record carries the connection details of a system that is not yet enrolled.
  test("lists an organisation's systems for its members only", async () => {
    const member = await arrangeMember();
    const outsider = await arrangeMember();
    const organisationId = await arrangeOrganisation(member);
    await arrangeSystem(member, organisationId, "Zebra Server");
    await arrangeSystem(member, organisationId, "Alpha Server");
    const path = `/api/organisations/${organisationId}/systems`;

    const listed = await request(server, "GET", path, {
      cookie: member.cookie,
    });
    expect(listed.status).toBe(200);
    const { systems } = await readJson(listed, systemsResponseSchema);
    expect(systems.map((system) => system.name)).toEqual([
      "Alpha Server",
      "Zebra Server",
    ]);
    expect(systems[0]?.kinds).toEqual(["server"]);

    // An approved member of another organisation is still an outsider here.
    expect(
      (await request(server, "GET", path, { cookie: outsider.cookie })).status,
    ).toBe(403);
    expect((await request(server, "GET", path)).status).toBe(401);
  });

  // FR-006: a system is a server, a client, or both - never neither.
  test("refuses a system with no profile at all", async () => {
    const member = await arrangeMember();
    const organisationId = await arrangeOrganisation(member);

    const response = await request(
      server,
      "POST",
      `/api/organisations/${organisationId}/systems`,
      { body: { name: "Neither" }, cookie: member.cookie },
    );

    expect(response.status).toBe(400);
  });

  // Trusted DCR without an endpoint is not usable, and the refusal is at the
  // point the details are entered rather than at mint time.
  test("refuses a trusted-DCR server with no registration endpoint", async () => {
    const member = await arrangeMember();
    const organisationId = await arrangeOrganisation(member);

    const response = await request(
      server,
      "POST",
      `/api/organisations/${organisationId}/systems`,
      {
        body: {
          name: "Half A Server",
          serverProfile: { ...serverProfile, registrationMode: "trustedDcr" },
        },
        cookie: member.cookie,
      },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      detail: expect.stringContaining("registrationEndpoint"),
    });
  });

  test("refuses a system created in someone else's organisation", async () => {
    const member = await arrangeMember();
    const outsider = await arrangeMember();
    const organisationId = await arrangeOrganisation(member);

    const response = await request(
      server,
      "POST",
      `/api/organisations/${organisationId}/systems`,
      {
        body: { name: "Not Yours", serverProfile },
        cookie: outsider.cookie,
      },
    );

    expect(response.status).toBe(403);
  });

  test("edits a system for a member and refuses the edit for an outsider", async () => {
    const member = await arrangeMember();
    const outsider = await arrangeMember();
    const organisationId = await arrangeOrganisation(member);
    const systemId = await arrangeSystem(member, organisationId);

    const edited = await request(server, "PATCH", `/api/systems/${systemId}`, {
      body: { description: "Now with notes." },
      cookie: member.cookie,
    });
    expect(edited.status).toBe(200);
    expect(await edited.json()).toMatchObject({
      system: { description: "Now with notes.", kinds: ["server"] },
    });

    const refused = await request(server, "PATCH", `/api/systems/${systemId}`, {
      body: { description: "Mine now." },
      cookie: outsider.cookie,
    });
    expect(refused.status).toBe(403);
  });

  test("answers a missing system with a 404", async () => {
    const member = await arrangeMember();

    const response = await request(
      server,
      "PATCH",
      `/api/systems/${crypto.randomUUID()}`,
      { body: { description: "Nothing there." }, cookie: member.cookie },
    );

    expect(response.status).toBe(404);
  });

  // Events and enrolment ------------------------------------------------------

  test("refuses event creation by anyone but an admin", async () => {
    const member = await arrangeMember();

    const response = await request(server, "POST", "/api/admin/events", {
      body: {
        slug: "not-yours",
        name: "Mine",
        startsOn: "2026-09-01",
        endsOn: "2026-09-03",
      },
      cookie: member.cookie,
    });

    expect(response.status).toBe(403);
  });

  // FR-008, FR-009: the tags are the event's, and enrolment records a fresh
  // confirmation that the details are current.
  test("enrols a system into an open event and re-confirms it", async () => {
    const member = await arrangeMember();
    const organisationId = await arrangeOrganisation(member);
    const systemId = await arrangeSystem(member, organisationId);
    const slug = await arrangeEvent();

    const enrolled = await request(
      server,
      "POST",
      `/api/events/${slug}/enrolments`,
      {
        body: { systemId, tags: ["form renderer host"] },
        cookie: member.cookie,
      },
    );

    expect(enrolled.status).toBe(201);
    expect(await enrolled.json()).toMatchObject({
      enrolment: {
        eventSlug: slug,
        systemId,
        tags: ["form renderer host"],
      },
    });

    // The second time is a re-confirmation of the same enrolment, not a clash.
    const again = await request(
      server,
      "POST",
      `/api/events/${slug}/enrolments`,
      { body: { systemId, tags: ["form filler"] }, cookie: member.cookie },
    );
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({
      enrolment: { tags: ["form filler"] },
    });
  });

  test("refuses tags the event does not define", async () => {
    const member = await arrangeMember();
    const organisationId = await arrangeOrganisation(member);
    const systemId = await arrangeSystem(member, organisationId);
    const slug = await arrangeEvent();

    const response = await request(
      server,
      "POST",
      `/api/events/${slug}/enrolments`,
      { body: { systemId, tags: ["teleportation"] }, cookie: member.cookie },
    );

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      detail: expect.stringContaining("capability tags"),
    });
  });

  test("refuses to enrol someone else's system", async () => {
    const member = await arrangeMember();
    const outsider = await arrangeMember();
    const organisationId = await arrangeOrganisation(member);
    const systemId = await arrangeSystem(member, organisationId);
    const slug = await arrangeEvent();

    const response = await request(
      server,
      "POST",
      `/api/events/${slug}/enrolments`,
      { body: { systemId, tags: [] }, cookie: outsider.cookie },
    );

    expect(response.status).toBe(403);
  });

  // FR-011: a draft event is not open yet and a closed one never will be again.
  test("refuses enrolment into an event that is not open", async () => {
    const member = await arrangeMember();
    const organisationId = await arrangeOrganisation(member);
    const systemId = await arrangeSystem(member, organisationId);
    const draft = await arrangeEvent("draft");
    const closed = await arrangeEvent("closed");

    for (const slug of [draft, closed]) {
      const response = await request(
        server,
        "POST",
        `/api/events/${slug}/enrolments`,
        { body: { systemId, tags: [] }, cookie: member.cookie },
      );

      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: "conflict" });
    }
  });

  // An admin opens and closes an event through the same route.
  test("opens an event and reports the change", async () => {
    const slug = await arrangeEvent("draft");

    const opened = await request(server, "PATCH", `/api/admin/events/${slug}`, {
      body: { status: "open" },
      cookie: admin.cookie,
    });

    expect(opened.status).toBe(200);
    expect(await opened.json()).toMatchObject({
      event: { slug, status: "open" },
    });
  });

  // Approval and revocation ---------------------------------------------------

  // FR-002, FR-003: approval is standing, revocable, and both are notified.
  test("approves a pending account, tells it, and refuses a second approval", async () => {
    const pending = await signUpAndSignIn(
      server,
      `${uniqueName("queued")}@example.org`,
    );

    const queue = await request(
      server,
      "GET",
      "/api/admin/accounts?status=pending",
      { cookie: admin.cookie },
    );
    expect(queue.status).toBe(200);
    const listed = await readJson(queue, accountsResponseSchema);
    expect(listed.accounts.map((account) => account.id)).toContain(pending.id);

    const approved = await request(
      server,
      "POST",
      `/api/admin/accounts/${pending.id}/approve`,
      { cookie: admin.cookie },
    );
    expect(approved.status).toBe(200);
    expect(await approved.json()).toMatchObject({
      account: { id: pending.id, status: "approved" },
    });
    expect(server.sentMail.at(-1)).toContain(`To: ${pending.email}`);
    expect(server.sentMail.at(-1)).toContain("approved");

    // Approving twice is refused rather than resent.
    const again = await request(
      server,
      "POST",
      `/api/admin/accounts/${pending.id}/approve`,
      { cookie: admin.cookie },
    );
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({
      detail: expect.stringContaining("already approved"),
    });
  });

  test("revokes a membership, tells it, and stops its writes", async () => {
    const member = await arrangeMember();

    const revoked = await request(
      server,
      "POST",
      `/api/admin/accounts/${member.id}/revoke`,
      { cookie: admin.cookie },
    );

    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toMatchObject({
      account: { id: member.id, status: "revoked" },
    });
    expect(server.sentMail.at(-1)).toContain("revoked");

    const write = await request(server, "POST", "/api/organisations", {
      body: { name: "Too Late" },
      cookie: member.cookie,
    });
    expect(write.status).toBe(403);
  });

  test("refuses approval by anyone but an admin", async () => {
    const member = await arrangeMember();
    const other = await arrangeMember();

    const response = await request(
      server,
      "POST",
      `/api/admin/accounts/${other.id}/approve`,
      { cookie: member.cookie },
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      detail: expect.stringContaining("admins only"),
    });
  });

  test("answers an unknown account with a 404", async () => {
    const response = await request(
      server,
      "POST",
      `/api/admin/accounts/${crypto.randomUUID()}/approve`,
      { cookie: admin.cookie },
    );

    expect(response.status).toBe(404);
  });

  // Contact gating on the public route ---------------------------------------

  // FR-007: the same public route, two callers, one difference.
  test("shows contacts to an approved member and to nobody else", async () => {
    const member = await arrangeMember();
    const organisationId = await arrangeOrganisation(member);
    const systemId = await arrangeSystem(member, organisationId);
    const slug = await arrangeEvent();
    await request(server, "POST", `/api/events/${slug}/enrolments`, {
      body: { systemId, tags: [] },
      cookie: member.cookie,
    });

    const anonymous = await request(
      server,
      "GET",
      `/api/events/${slug}/systems`,
    );
    const signedIn = await request(
      server,
      "GET",
      `/api/events/${slug}/systems`,
      { cookie: member.cookie },
    );

    expect(anonymous.status).toBe(200);
    const open = await readJson(anonymous, eventSystemsSchema);
    expect(open.systems).toHaveLength(1);
    expect(open.systems[0]?.contacts).toBeUndefined();

    const gated = await readJson(signedIn, eventSystemsSchema);
    expect(gated.systems[0]?.contacts).toEqual([
      {
        accountId: member.id,
        displayName: member.email,
        email: member.email,
      },
    ]);
  });
});
