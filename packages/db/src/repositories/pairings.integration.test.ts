/*
 * Copyright © 2026 Commonwealth Scientific and Industrial Research Organisation
 * (CSIRO) ABN 41 687 119 230. Licensed under the Apache License, Version 2.0.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";

import {
  insertAccount,
  insertEnrolment,
  insertEvent,
  insertOrganisation,
  insertOrganisationMember,
  insertSystem,
} from "./directory.ts";
import {
  findPairingByKey,
  findPairingRecord,
  insertPairing,
  insertPairingEvent,
  listPairingEvents,
  listPairingRecordsForOrganisations,
  listPairingsInState,
  updatePairingState,
} from "./pairings.ts";
import { isUniqueViolation } from "../errors.ts";
import {
  createMigratedSchema,
  describeDatabase,
  uniqueName,
} from "../test/harness.ts";

import type { NewPairing, PairingRow } from "./pairings.ts";
import type { MigratedSchema } from "../test/harness.ts";

/**
 * The pairing schema and its repositories against a real PostgreSQL.
 *
 * Two rules here are the schema's rather than a route handler's, because they
 * must hold whatever a handler believes. A client, a server and an event admit
 * one pairing (FR-015), so the second request cannot become a second row however
 * it arrives; and the timeline is append-only (FR-013), so a row that says who
 * did what cannot be rewritten afterwards.
 */

describeDatabase("the pairing schema and repositories", () => {
  let database: MigratedSchema;

  beforeAll(async () => {
    database = await createMigratedSchema("pairings");
  });

  afterAll(async () => {
    await database.close();
  });

  // Returns the error a promise rejected with, so a test can classify it.
  const rejection = async (work: Promise<unknown>): Promise<unknown> => {
    try {
      await work;
      return undefined;
    } catch (cause) {
      return cause;
    }
  };

  // The registration field set as an app owner would submit it.
  const registrationFields = {
    clientName: "Smart Forms",
    launchUrl: "https://smartforms.csiro.au/launch",
    redirectUris: ["https://smartforms.csiro.au/callback"],
    scopes: ["launch", "patient/Patient.rs"],
    confidentiality: "public",
    launchContext: "patient",
    needsIntrospection: false,
  };

  /** An organisation with one member, and the member's account. */
  type Party = {
    /** the account */
    readonly accountId: string;
    /** the organisation it belongs to */
    readonly organisationId: string;
    /** what the organisation is called */
    readonly organisationName: string;
  };

  // Arranges an organisation with a single member.
  const arrangeParty = async (name: string): Promise<Party> => {
    const account = await insertAccount(database.sql, {
      email: `${uniqueName("member")}@example.org`,
      displayName: `A member of ${name}`,
      passwordHash: "argon2id$stub",
    });
    const organisation = await insertOrganisation(database.sql, { name });
    await insertOrganisationMember(database.sql, {
      organisationId: organisation.id,
      accountId: account.id,
    });
    return {
      accountId: account.id,
      organisationId: organisation.id,
      organisationName: organisation.name,
    };
  };

  // Arranges an event open for pairing.
  const arrangeEvent = async () =>
    insertEvent(database.sql, {
      slug: uniqueName("event"),
      name: "Sparked connectathon",
      startsOn: "2026-09-01",
      endsOn: "2026-09-03",
      status: "open",
      capabilityTags: [],
      graceDays: 7,
    });

  // Arranges an enrolled system, as a server or as a client.
  const arrangeEnrolment = async (
    party: Party,
    eventId: string,
    kind: "server" | "client",
    name: string,
  ) => {
    const system = await insertSystem(database.sql, {
      organisationId: party.organisationId,
      name,
      description: "",
      serverProfile:
        kind === "server"
          ? {
              fhirBaseUrl: "https://fhir.example.org",
              authorizationMode: "smart",
              registrationMode: "manual",
              notes: "",
            }
          : null,
      clientProfile:
        kind === "client"
          ? {
              launchUrl: registrationFields.launchUrl,
              redirectUris: registrationFields.redirectUris,
              scopes: registrationFields.scopes,
              confidentiality: "public",
              launchContext: "patient",
              needsIntrospection: false,
            }
          : null,
    });
    const enrolment = await insertEnrolment(database.sql, {
      eventId,
      systemId: system.id,
      tags: [],
      confirmedBy: party.accountId,
    });
    return { system, enrolment };
  };

  /** A whole arranged pairing, and everything it was built from. */
  type Arranged = {
    /** the app owner's organisation */
    readonly app: Party;
    /** the server owner's organisation */
    readonly host: Party;
    /** the event both are enrolled in */
    readonly eventId: string;
    /** the event's slug */
    readonly eventSlug: string;
    /** the client enrolment */
    readonly clientEnrolmentId: string;
    /** the server enrolment */
    readonly serverEnrolmentId: string;
    /** the pairing itself */
    readonly pairing: PairingRow;
  };

  // Arranges two organisations, an event, an enrolment each, and a pairing.
  const arrangePairing = async (): Promise<Arranged> => {
    const app = await arrangeParty("CSIRO");
    const host = await arrangeParty("MediRecords");
    const event = await arrangeEvent();
    const client = await arrangeEnrolment(
      app,
      event.id,
      "client",
      "Smart Forms",
    );
    const server = await arrangeEnrolment(
      host,
      event.id,
      "server",
      "MediRecords FHIR",
    );
    const pairing = await insertPairing(database.sql, {
      eventId: event.id,
      clientEnrolmentId: client.enrolment.id,
      serverEnrolmentId: server.enrolment.id,
      registrationFields,
    });
    return {
      app,
      host,
      eventId: event.id,
      eventSlug: event.slug,
      clientEnrolmentId: client.enrolment.id,
      serverEnrolmentId: server.enrolment.id,
      pairing,
    };
  };

  // Pairings ------------------------------------------------------------------

  // A pairing starts as requested, carrying the field set the app owner
  // submitted, with nothing recorded against it yet (FR-012, FR-013).
  test("records a pairing as requested with its registration field snapshot", async () => {
    const arranged = await arrangePairing();

    expect(arranged.pairing.state).toBe("requested");
    expect(arranged.pairing.registrationFields).toEqual(registrationFields);
    expect(arranged.pairing.clientId).toBeNull();
    expect(arranged.pairing.declineReason).toBeNull();
    expect(arranged.pairing.eventId).toBe(arranged.eventId);
  });

  // FR-015: the schema holds the rule, so a duplicate cannot arrive by a route
  // that forgot to look for one first.
  test("refuses a second pairing for the same event, client and server", async () => {
    const arranged = await arrangePairing();
    const duplicate: NewPairing = {
      eventId: arranged.eventId,
      clientEnrolmentId: arranged.clientEnrolmentId,
      serverEnrolmentId: arranged.serverEnrolmentId,
      registrationFields,
    };

    const cause = await rejection(insertPairing(database.sql, duplicate));

    expect(isUniqueViolation(cause)).toBe(true);
  });

  // The existing pairing is findable by the same key, which is what lets the
  // refusal link to it rather than merely refusing.
  test("finds the existing pairing by its event, client and server", async () => {
    const arranged = await arrangePairing();

    const found = await findPairingByKey(database.sql, {
      eventId: arranged.eventId,
      clientEnrolmentId: arranged.clientEnrolmentId,
      serverEnrolmentId: arranged.serverEnrolmentId,
    });

    expect(found?.id).toBe(arranged.pairing.id);
  });

  test("finds no pairing for a key that has none", async () => {
    const arranged = await arrangePairing();

    const found = await findPairingByKey(database.sql, {
      eventId: arranged.eventId,
      clientEnrolmentId: arranged.serverEnrolmentId,
      serverEnrolmentId: arranged.clientEnrolmentId,
    });

    expect(found).toBeUndefined();
  });

  // The record both parties read: each side's system and owning organisation,
  // and the event the pairing belongs to.
  test("reads a pairing with both sides and their organisations", async () => {
    const arranged = await arrangePairing();

    const record = await findPairingRecord(database.sql, arranged.pairing.id);

    expect(record?.eventSlug).toBe(arranged.eventSlug);
    expect(record?.eventStatus).toBe("open");
    expect(record?.client.systemName).toBe("Smart Forms");
    expect(record?.client.organisationName).toBe("CSIRO");
    expect(record?.client.enrolmentId).toBe(arranged.clientEnrolmentId);
    expect(record?.server.systemName).toBe("MediRecords FHIR");
    expect(record?.server.organisationName).toBe("MediRecords");
    expect(record?.server.enrolmentId).toBe(arranged.serverEnrolmentId);
  });

  // The server's own profile travels with the record, because whether a pairing
  // can be requested at all depends on its registration mode (FR-016).
  test("reads the profiles of both sides with the pairing", async () => {
    const arranged = await arrangePairing();

    const record = await findPairingRecord(database.sql, arranged.pairing.id);

    expect(record?.serverProfile).toMatchObject({ registrationMode: "manual" });
    expect(record?.clientProfile).toMatchObject({ confidentiality: "public" });
  });

  test("reads no record for an identifier that has no pairing", async () => {
    const record = await findPairingRecord(
      database.sql,
      "1b0f8f4e-6a4a-4d64-9a4f-3c7c9c0f5b21",
    );

    expect(record).toBeUndefined();
  });

  // Acceptance scenario 2: the identifier the server issued is recorded against
  // the pairing, and the state moves with it.
  test("records the issued client identifier when a pairing is fulfilled", async () => {
    const arranged = await arrangePairing();

    const updated = await updatePairingState(database.sql, {
      id: arranged.pairing.id,
      state: "fulfilled",
      clientId: "smart-forms-test-1",
    });

    expect(updated?.state).toBe("fulfilled");
    expect(updated?.clientId).toBe("smart-forms-test-1");
    expect(updated?.updatedAt.getTime()).toBeGreaterThanOrEqual(
      arranged.pairing.updatedAt.getTime(),
    );
  });

  // Acceptance scenario 3: the reason is recorded so the app owner can read it.
  test("records the reason when a pairing is declined", async () => {
    const arranged = await arrangePairing();

    const updated = await updatePairingState(database.sql, {
      id: arranged.pairing.id,
      state: "declined",
      declineReason: "Redirect URI is not on our allowed list.",
    });

    expect(updated?.state).toBe("declined");
    expect(updated?.declineReason).toBe(
      "Redirect URI is not on our allowed list.",
    );
  });

  // A retry after a failure resubmits the metadata, so the snapshot is replaced
  // rather than accumulated.
  test("replaces the registration field snapshot when it is resubmitted", async () => {
    const arranged = await arrangePairing();
    const corrected = { ...registrationFields, clientName: "Smart Forms 2" };

    const updated = await updatePairingState(database.sql, {
      id: arranged.pairing.id,
      state: "requested",
      registrationFields: corrected,
    });

    expect(updated?.registrationFields).toEqual(corrected);
  });

  test("updates no pairing for an identifier that has none", async () => {
    const updated = await updatePairingState(database.sql, {
      id: "1b0f8f4e-6a4a-4d64-9a4f-3c7c9c0f5b21",
      state: "fulfilled",
    });

    expect(updated).toBeUndefined();
  });

  // FR-011: the lapsing that closing an event does needs to find what is still
  // open, and nothing that has already settled.
  test("lists the pairings of an event that are in a given state", async () => {
    const arranged = await arrangePairing();
    const settled = await arrangePairing();
    await updatePairingState(database.sql, {
      id: settled.pairing.id,
      state: "declined",
      declineReason: "No.",
    });

    const open = await listPairingsInState(database.sql, {
      eventId: arranged.eventId,
      states: ["requested"],
    });

    expect(open.map((pairing) => pairing.id)).toEqual([arranged.pairing.id]);
  });

  // Timeline ------------------------------------------------------------------

  // FR-013: every transition is recorded with who made it, for which
  // organisation, and what changed.
  test("appends a timeline entry naming the actor and the organisation", async () => {
    const arranged = await arrangePairing();

    await insertPairingEvent(database.sql, {
      pairingId: arranged.pairing.id,
      actorAccountId: arranged.app.accountId,
      actingForOrganisationId: arranged.app.organisationId,
      fromState: null,
      toState: "requested",
      detail: {},
    });
    await insertPairingEvent(database.sql, {
      pairingId: arranged.pairing.id,
      actorAccountId: arranged.host.accountId,
      actingForOrganisationId: arranged.host.organisationId,
      fromState: "requested",
      toState: "fulfilled",
      detail: { clientId: "smart-forms-test-1" },
    });

    const timeline = await listPairingEvents(database.sql, arranged.pairing.id);

    expect(timeline).toHaveLength(2);
    expect(timeline[0]?.fromState).toBeNull();
    expect(timeline[0]?.toState).toBe("requested");
    expect(timeline[0]?.actingForOrganisationName).toBe("CSIRO");
    expect(timeline[0]?.actorDisplayName).toBe("A member of CSIRO");
    expect(timeline[1]?.fromState).toBe("requested");
    expect(timeline[1]?.toState).toBe("fulfilled");
    expect(timeline[1]?.actingForOrganisationName).toBe("MediRecords");
    expect(timeline[1]?.detail).toEqual({ clientId: "smart-forms-test-1" });
  });

  // A lapse is Muster's own doing when an event closes, so the entry carries no
  // organisation: nobody acted for a side.
  test("appends a timeline entry for an action taken for no organisation", async () => {
    const arranged = await arrangePairing();

    const entry = await insertPairingEvent(database.sql, {
      pairingId: arranged.pairing.id,
      actorAccountId: null,
      actingForOrganisationId: null,
      fromState: "requested",
      toState: "lapsed",
      detail: { reason: "The event closed." },
    });

    expect(entry.actorAccountId).toBeNull();
    expect(entry.actingForOrganisationId).toBeNull();
    expect(entry.actorDisplayName).toBeNull();
    expect(entry.actingForOrganisationName).toBeNull();
    expect(entry.toState).toBe("lapsed");
  });

  // Both parties read one timeline, in the order things happened, so neither can
  // be looking at a different history from the other (SC-002).
  test("returns the timeline oldest first", async () => {
    const arranged = await arrangePairing();
    for (const toState of ["requested", "failed", "requested"] as const) {
      await insertPairingEvent(database.sql, {
        pairingId: arranged.pairing.id,
        actorAccountId: arranged.app.accountId,
        actingForOrganisationId: arranged.app.organisationId,
        fromState: null,
        toState,
        detail: {},
      });
    }

    const timeline = await listPairingEvents(database.sql, arranged.pairing.id);

    expect(timeline.map((entry) => entry.toState)).toEqual([
      "requested",
      "failed",
      "requested",
    ]);
  });

  // Append-only, enforced by the database: the record of who did what is not
  // something a later statement gets to revise.
  test("refuses to rewrite a timeline entry", async () => {
    const arranged = await arrangePairing();
    const entry = await insertPairingEvent(database.sql, {
      pairingId: arranged.pairing.id,
      actorAccountId: arranged.app.accountId,
      actingForOrganisationId: arranged.app.organisationId,
      fromState: null,
      toState: "requested",
      detail: {},
    });

    const cause = await rejection(
      database.sql`update pairing_event set to_state = 'fulfilled' where id = ${entry.id}`,
    );

    expect(cause).toBeDefined();
  });

  test("refuses to delete a timeline entry", async () => {
    const arranged = await arrangePairing();
    const entry = await insertPairingEvent(database.sql, {
      pairingId: arranged.pairing.id,
      actorAccountId: arranged.app.accountId,
      actingForOrganisationId: arranged.app.organisationId,
      fromState: null,
      toState: "requested",
      detail: {},
    });

    const cause = await rejection(
      database.sql`delete from pairing_event where id = ${entry.id}`,
    );

    expect(cause).toBeDefined();
  });

  // Listing -------------------------------------------------------------------

  // FR-013: a pairing is listed to both organisations, in both directions, so
  // each side sees the same set without asking the other.
  test("lists a pairing for the client's and the server's organisation alike", async () => {
    const arranged = await arrangePairing();

    const forApp = await listPairingRecordsForOrganisations(database.sql, {
      eventId: arranged.eventId,
      organisationIds: [arranged.app.organisationId],
    });
    const forHost = await listPairingRecordsForOrganisations(database.sql, {
      eventId: arranged.eventId,
      organisationIds: [arranged.host.organisationId],
    });

    expect(forApp.map((record) => record.pairing.id)).toEqual([
      arranged.pairing.id,
    ]);
    expect(forHost.map((record) => record.pairing.id)).toEqual([
      arranged.pairing.id,
    ]);
  });

  // A member of both organisations sees the pairing once, not twice: it is one
  // record with them on both sides of it.
  test("lists a pairing once for a member of both organisations", async () => {
    const arranged = await arrangePairing();

    const records = await listPairingRecordsForOrganisations(database.sql, {
      eventId: arranged.eventId,
      organisationIds: [
        arranged.app.organisationId,
        arranged.host.organisationId,
      ],
    });

    expect(records).toHaveLength(1);
  });

  // Somebody else's pairing is not the caller's business, and nor is a pairing
  // in another event.
  test("lists no pairing for an organisation on neither side", async () => {
    const arranged = await arrangePairing();
    const stranger = await arrangeParty("Someone Else");

    const records = await listPairingRecordsForOrganisations(database.sql, {
      eventId: arranged.eventId,
      organisationIds: [stranger.organisationId],
    });

    expect(records).toEqual([]);
  });

  test("lists no pairing from another event", async () => {
    const arranged = await arrangePairing();
    const other = await arrangeEvent();

    const records = await listPairingRecordsForOrganisations(database.sql, {
      eventId: other.id,
      organisationIds: [arranged.app.organisationId],
    });

    expect(records).toEqual([]);
  });
});
