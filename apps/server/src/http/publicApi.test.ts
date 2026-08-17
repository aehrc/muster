import {
  eventResponseSchema,
  eventsResponseSchema,
  eventSystemSchema,
  eventSystemsSchema,
} from "@muster/contracts";
import {
  insertEnrolment,
  insertEvent,
  insertOrganisation,
  insertOrganisationMember,
  insertSystem,
  updateAccountStatus,
} from "@muster/db";
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
 * The public read API: the replacement for the participant table.
 *
 * Two properties matter more than the rest, and both are here. An anonymous
 * reader sees every enrolled system and no contact detail (FR-007, FR-010,
 * SC-006). A system that is not enrolled in the event is not in the event's
 * answer, whatever else is true of it (FR-009).
 *
 * The fixtures are written through the repositories rather than the routes, so
 * this suite fails for the reading and not for anything about enrolling.
 */

describeDatabase("the public read API", () => {
  let server: TestServer;
  let member: SignedIn;
  let organisationId: string;

  beforeAll(async () => {
    server = await startTestServer("public");
    member = await signUpAndSignIn(
      server,
      `${uniqueName("member")}@example.org`,
    );
    await updateAccountStatus(server.database.sql, {
      accountId: member.id,
      status: "approved",
      decidedBy: member.id,
      decidedAt: new Date(),
    });
    const organisation = await insertOrganisation(server.database.sql, {
      name: "MediRecords",
    });
    organisationId = organisation.id;
    await insertOrganisationMember(server.database.sql, {
      organisationId,
      accountId: member.id,
    });
  });

  afterAll(async () => {
    await server.close();
  });

  const serverProfile = {
    fhirBaseUrl: "https://fhir.medirecords.example.org",
    authorizationMode: "smart",
    registrationMode: "manual",
    notes: "",
  };

  // Arranges a system owned by the suite's organisation.
  const arrangeSystem = async (name: string) =>
    insertSystem(server.database.sql, {
      organisationId,
      name,
      description: "A FHIR server.",
      serverProfile,
      clientProfile: null,
    });

  // Arranges an event with two capability tags.
  const arrangeEvent = async (status: "draft" | "open" | "closed" = "open") =>
    insertEvent(server.database.sql, {
      slug: uniqueName("event").replaceAll("_", "-"),
      name: "Sparked connectathon",
      startsOn: "2026-09-01",
      endsOn: "2026-09-03",
      status,
      capabilityTags: ["form renderer host", "form filler"],
      graceDays: 7,
    });

  // FR-021: the same data the web views read, without an account.
  test("lists the events and one event's detail to an anonymous reader", async () => {
    const event = await arrangeEvent();

    const list = await request(server, "GET", "/api/events");
    expect(list.status).toBe(200);
    const listed = await readJson(list, eventsResponseSchema);
    expect(listed.events.map((entry) => entry.slug)).toContain(event.slug);

    const detail = await request(server, "GET", `/api/events/${event.slug}`);
    expect(detail.status).toBe(200);
    expect((await readJson(detail, eventResponseSchema)).event).toEqual({
      slug: event.slug,
      name: "Sparked connectathon",
      startsOn: "2026-09-01",
      endsOn: "2026-09-03",
      status: "open",
      capabilityTags: ["form renderer host", "form filler"],
      personaSourceUrl: null,
      graceDays: 7,
    });
  });

  test("answers an unknown event with a 404 envelope", async () => {
    const response = await request(server, "GET", "/api/events/no-such-event");

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: "not_found" });
  });

  // FR-007, SC-006: the whole point of the gate.
  test("excludes contact details from an anonymous answer", async () => {
    const event = await arrangeEvent();
    const system = await arrangeSystem("MediRecords FHIR");
    await insertEnrolment(server.database.sql, {
      eventId: event.id,
      systemId: system.id,
      tags: ["form filler"],
      confirmedBy: member.id,
    });

    const response = await request(
      server,
      "GET",
      `/api/events/${event.slug}/systems`,
    );

    expect(response.status).toBe(200);
    const body = await readJson(response, eventSystemsSchema);
    expect(body.systems).toHaveLength(1);
    expect(body.systems[0]).toMatchObject({
      tags: ["form filler"],
      system: {
        name: "MediRecords FHIR",
        kinds: ["server"],
        serverProfile,
        clientProfile: null,
      },
      organisation: { id: organisationId, name: "MediRecords" },
    });
    expect(body.systems[0]?.contacts).toBeUndefined();
    // Not just absent from the parsed shape: absent from the bytes.
    expect(JSON.stringify(body)).not.toContain(member.email);
  });

  // FR-007: a signed-in approved member sees the contacts on the same route.
  test("includes contact details for a signed-in approved member", async () => {
    const event = await arrangeEvent();
    const system = await arrangeSystem("MediRecords FHIR");
    await insertEnrolment(server.database.sql, {
      eventId: event.id,
      systemId: system.id,
      tags: [],
      confirmedBy: member.id,
    });

    const response = await request(
      server,
      "GET",
      `/api/events/${event.slug}/systems`,
      { cookie: member.cookie },
    );

    const body = await readJson(response, eventSystemsSchema);
    expect(body.systems[0]?.contacts).toEqual([
      {
        accountId: member.id,
        displayName: member.email,
        email: member.email,
      },
    ]);
  });

  // An account that is signed in but not approved is not a member of anything,
  // so it reads what an anonymous caller reads.
  test("withholds contact details from a signed-in pending account", async () => {
    const event = await arrangeEvent();
    const system = await arrangeSystem("MediRecords FHIR");
    await insertEnrolment(server.database.sql, {
      eventId: event.id,
      systemId: system.id,
      tags: [],
      confirmedBy: member.id,
    });
    const pending = await signUpAndSignIn(
      server,
      `${uniqueName("pending")}@example.org`,
    );

    const response = await request(
      server,
      "GET",
      `/api/events/${event.slug}/systems`,
      { cookie: pending.cookie },
    );

    const body = await readJson(response, eventSystemsSchema);
    expect(body.systems[0]?.contacts).toBeUndefined();
  });

  // FR-009 and the spec's scenario 7: last event's entry is not this event's.
  test("excludes a system that is not enrolled in the event", async () => {
    const event = await arrangeEvent();
    const pastEvent = await arrangeEvent("closed");
    const enrolled = await arrangeSystem("Enrolled Server");
    const unenrolled = await arrangeSystem("Unenrolled Server");
    const lastTime = await arrangeSystem("Last Year's Server");
    await insertEnrolment(server.database.sql, {
      eventId: event.id,
      systemId: enrolled.id,
      tags: [],
      confirmedBy: member.id,
    });
    await insertEnrolment(server.database.sql, {
      eventId: pastEvent.id,
      systemId: lastTime.id,
      tags: [],
      confirmedBy: member.id,
    });

    const response = await request(
      server,
      "GET",
      `/api/events/${event.slug}/systems`,
    );

    const body = await readJson(response, eventSystemsSchema);
    expect(body.systems.map((entry) => entry.system.name)).toEqual([
      "Enrolled Server",
    ]);
    expect(body.systems.map((entry) => entry.system.id)).not.toContain(
      unenrolled.id,
    );
    // The unenrolled system has no entry of its own in this event either.
    expect(
      (
        await request(
          server,
          "GET",
          `/api/events/${event.slug}/systems/${unenrolled.id}`,
        )
      ).status,
    ).toBe(404);
  });

  test("answers one enrolled system with its event", async () => {
    const event = await arrangeEvent();
    const system = await arrangeSystem("MediRecords FHIR");
    await insertEnrolment(server.database.sql, {
      eventId: event.id,
      systemId: system.id,
      tags: ["form renderer host"],
      confirmedBy: member.id,
    });

    const response = await request(
      server,
      "GET",
      `/api/events/${event.slug}/systems/${system.id}`,
    );

    expect(response.status).toBe(200);
    const body = await readJson(response, eventSystemSchema);
    expect(body.event.slug).toBe(event.slug);
    expect(body.system.system.id).toBe(system.id);
    expect(body.system.tags).toEqual(["form renderer host"]);
    expect(body.system.contacts).toBeUndefined();
  });

  // FR-011: a closed event keeps its records readable and takes nothing new.
  test("keeps a closed event readable while refusing enrolment into it", async () => {
    const closed = await arrangeEvent("closed");
    const system = await arrangeSystem("MediRecords FHIR");
    await insertEnrolment(server.database.sql, {
      eventId: closed.id,
      systemId: system.id,
      tags: [],
      confirmedBy: member.id,
    });

    const readable = await request(
      server,
      "GET",
      `/api/events/${closed.slug}/systems`,
    );
    expect(readable.status).toBe(200);
    expect((await readJson(readable, eventSystemsSchema)).systems).toHaveLength(
      1,
    );

    const refused = await request(
      server,
      "POST",
      `/api/events/${closed.slug}/enrolments`,
      {
        body: { systemId: system.id, tags: [] },
        cookie: member.cookie,
      },
    );
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({
      error: "conflict",
      detail: expect.stringContaining("closed"),
    });
  });

  // A draft event is not open for enrolment either, and says so.
  test("refuses enrolment into a draft event", async () => {
    const draft = await arrangeEvent("draft");
    const system = await arrangeSystem("MediRecords FHIR");

    const refused = await request(
      server,
      "POST",
      `/api/events/${draft.slug}/enrolments`,
      { body: { systemId: system.id, tags: [] }, cookie: member.cookie },
    );

    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({
      detail: expect.stringContaining("draft"),
    });
  });
});
