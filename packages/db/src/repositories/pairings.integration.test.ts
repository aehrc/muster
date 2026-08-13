/**
 * The pairing tables and repositories, against a real Postgres.
 *
 * What these assert is what no unit test can: the constraints, and the concurrency they
 * resolve. One pairing per client, server and event is true because a unique index says so, and
 * FR-015's "refused, with the existing pairing linked" is that violation being recognised
 * rather than a look-then-insert with a window in the middle. A fulfilled pairing carries an
 * identifier and a declined one carries a reason because check constraints say so, so a bug in
 * a future route cannot leave a yes with nothing attached to it.
 *
 * The timeline is the other subject. It is append-only (`data-model.md`), which means the
 * assertions are about what survives: two transitions leave two rows, in order, each naming who
 * acted and which organisation they acted for - the last of which is the only way to read the
 * history of a pairing where one person belongs to both organisations (spec edge case).
 *
 * Every call is made as the non-owning serving role, which is what a deployment serves with.
 *
 * Skipped unless `MUSTER_TEST_DATABASE_URL` names a throwaway database. CI provides one, so a
 * skip there is a failure of the workflow rather than an accepted state.
 *
 * Author: John Grimes
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import { updateSystem } from "./directory.js";
import { isCheckViolation } from "./errors.js";
import {
  findPairing,
  findPairingSide,
  insertPairing,
  lapseOpenPairings,
  listPairingTimeline,
  listPairingsForOrganisations,
  transitionPairing,
} from "./pairings.js";
import { pairing as pairingTable } from "../schema/pairings.js";
import {
  clientProfileFixture,
  makeAccount,
  makeEnrolment,
  makeEvent,
  makeOrganisation,
  makeSystem,
  serverProfileFixture,
  uniqueSuffix,
} from "../test/factories.js";
import { hasTestDatabase, openTestDatabase } from "../test/harness.js";

import type { DatabaseHandle } from "../client.js";
import type { Executor } from "../executor.js";
import type { RegistrationFieldsInput } from "@muster/contracts";

/** The field set every fixture pairing carries. */
const FIELDS: RegistrationFieldsInput = {
  clientName: "Smart Forms",
  launchUrl: "https://smartforms.csiro.au/launch",
  redirectUris: ["https://smartforms.csiro.au/"],
  scopes: ["launch", "openid", "fhirUser"],
  confidentiality: "public",
  launchContext: "patient",
  needsIntrospection: false,
};

describe.skipIf(!hasTestDatabase())("the pairing repositories", () => {
  let handle: DatabaseHandle;
  let db: Executor;

  beforeAll(async () => {
    handle = (await openTestDatabase())!;
    db = handle.db;
  });

  afterAll(async () => {
    await handle.close();
  });

  /** An app owner, a server owner, an open event and one enrolment each. */
  async function scene() {
    const appOwner = await makeAccount(db);
    const serverOwner = await makeAccount(db);
    const appOrganisation = await makeOrganisation(db, appOwner.id, "CSIRO");
    const serverOrganisation = await makeOrganisation(
      db,
      serverOwner.id,
      "MediRecords",
    );
    const event = await makeEvent(db, { status: "open" });

    const clientSystem = await makeSystem(db, appOrganisation.id, {
      name: "Smart Forms",
      serverProfile: null,
      clientProfile: clientProfileFixture(),
    });
    const serverSystem = await makeSystem(db, serverOrganisation.id, {
      name: "MediRecords FHIR",
      serverProfile: serverProfileFixture(),
    });

    const clientEnrolment = await makeEnrolment(db, {
      event,
      systemId: clientSystem.id,
      accountId: appOwner.id,
    });
    const serverEnrolment = await makeEnrolment(db, {
      event,
      systemId: serverSystem.id,
      accountId: serverOwner.id,
    });

    return {
      appOwner,
      serverOwner,
      appOrganisation,
      serverOrganisation,
      event,
      clientSystem,
      serverSystem,
      clientEnrolment,
      serverEnrolment,
    };
  }

  /** Requests the pairing of `scene`, as the app owner. */
  async function request(
    stage: Awaited<ReturnType<typeof scene>>,
    at = new Date("2026-09-03T10:12:00.000Z"),
  ) {
    const written = await insertPairing(db, {
      eventId: stage.event.id,
      clientEnrolmentId: stage.clientEnrolment.id,
      serverEnrolmentId: stage.serverEnrolment.id,
      registrationFields: FIELDS,
      actorAccountId: stage.appOwner.id,
      actingForOrganisationId: stage.appOrganisation.id,
      now: at,
    });
    if (!written.ok) {
      throw new Error(`the fixture pairing was refused: ${written.reason}`);
    }
    return written.pairing;
  }

  describe("insertPairing", () => {
    it("creates the pairing in the requested state with its field snapshot", async () => {
      const stage = await scene();
      const created = await request(stage);

      expect(created.state).toBe("requested");
      expect(created.clientId).toBeNull();
      expect(created.declineReason).toBeNull();
      expect(created.registrationFields).toEqual(FIELDS);
    });

    it("records the request as the timeline's first entry", async () => {
      const stage = await scene();
      const created = await request(stage);

      const timeline = await listPairingTimeline(db, created.id);

      expect(timeline).toHaveLength(1);
      // From no prior state: the request created the pairing rather than moving it.
      expect(timeline[0]?.entry.fromState).toBeNull();
      expect(timeline[0]?.entry.toState).toBe("requested");
      expect(timeline[0]?.actorDisplayName).toBe(stage.appOwner.displayName);
      expect(timeline[0]?.actingFor?.id).toBe(stage.appOrganisation.id);
    });

    it("refuses a second request for the same client, server and event", async () => {
      // FR-015, and the reason it is a caught constraint violation rather than a prior
      // lookup: two requests arriving together would both pass the lookup.
      const stage = await scene();
      const first = await request(stage);

      const second = await insertPairing(db, {
        eventId: stage.event.id,
        clientEnrolmentId: stage.clientEnrolment.id,
        serverEnrolmentId: stage.serverEnrolment.id,
        registrationFields: FIELDS,
        actorAccountId: stage.appOwner.id,
        actingForOrganisationId: stage.appOrganisation.id,
        now: new Date("2026-09-03T11:00:00.000Z"),
      });

      expect(second.ok).toBe(false);
      // The existing pairing, so the refusal can link to it rather than mention it.
      expect(second.ok ? undefined : second.pairingId).toBe(first.id);
    });

    it("leaves no timeline entry behind when a duplicate is refused", async () => {
      const stage = await scene();
      const first = await request(stage);

      await insertPairing(db, {
        eventId: stage.event.id,
        clientEnrolmentId: stage.clientEnrolment.id,
        serverEnrolmentId: stage.serverEnrolment.id,
        registrationFields: FIELDS,
        actorAccountId: stage.appOwner.id,
        actingForOrganisationId: stage.appOrganisation.id,
        now: new Date("2026-09-03T11:00:00.000Z"),
      });

      // The pairing and its first entry are written together, so a refused duplicate must
      // not have appended anything to the history of the pairing it collided with.
      expect(await listPairingTimeline(db, first.id)).toHaveLength(1);
    });

    it("admits a second client against the same server", async () => {
      const stage = await scene();
      await request(stage);

      const other = await makeSystem(db, stage.appOrganisation.id, {
        serverProfile: null,
        clientProfile: clientProfileFixture(),
      });
      const otherEnrolment = await makeEnrolment(db, {
        event: stage.event,
        systemId: other.id,
        accountId: stage.appOwner.id,
      });

      const written = await insertPairing(db, {
        eventId: stage.event.id,
        clientEnrolmentId: otherEnrolment.id,
        serverEnrolmentId: stage.serverEnrolment.id,
        registrationFields: FIELDS,
        actorAccountId: stage.appOwner.id,
        actingForOrganisationId: stage.appOrganisation.id,
        now: new Date("2026-09-03T12:00:00.000Z"),
      });

      expect(written.ok).toBe(true);
    });

    it("admits the same two systems at a second event", async () => {
      // The unique index is per event, because a system re-enrolled next December negotiates
      // its registration again (SC-008).
      const stage = await scene();
      await request(stage);

      const later = await makeEvent(db, { status: "open" });
      const clientAgain = await makeEnrolment(db, {
        event: later,
        systemId: stage.clientSystem.id,
        accountId: stage.appOwner.id,
      });
      const serverAgain = await makeEnrolment(db, {
        event: later,
        systemId: stage.serverSystem.id,
        accountId: stage.serverOwner.id,
      });

      const written = await insertPairing(db, {
        eventId: later.id,
        clientEnrolmentId: clientAgain.id,
        serverEnrolmentId: serverAgain.id,
        registrationFields: FIELDS,
        actorAccountId: stage.appOwner.id,
        actingForOrganisationId: stage.appOrganisation.id,
        now: new Date("2026-12-01T09:00:00.000Z"),
      });

      expect(written.ok).toBe(true);
    });

    it("keeps the snapshot when the client's record changes afterwards", async () => {
      // The reason `registration_fields` is a snapshot: a client entry edited mid-event does
      // not silently change what a server owner was asked to register (spec edge case).
      const stage = await scene();
      const created = await request(stage);

      await updateSystem(db, {
        systemId: stage.clientSystem.id,
        system: {
          name: "Smart Forms Renamed",
          description: "",
          serverProfile: null,
          clientProfile: clientProfileFixture({
            scopes: ["launch", "patient/Patient.rs"],
            redirectUris: ["https://elsewhere.test/callback"],
          }),
        },
        now: new Date("2026-09-04T09:00:00.000Z"),
      });

      const found = await findPairing(db, created.id);
      expect(found?.pairing.registrationFields).toEqual(FIELDS);
    });
  });

  describe("transitionPairing", () => {
    it("records the issued identifier and appends the transition", async () => {
      const stage = await scene();
      const created = await request(stage);

      const moved = await transitionPairing(db, {
        pairingId: created.id,
        from: "requested",
        change: { to: "fulfilled", clientId: "smart-forms-test-1" },
        actorAccountId: stage.serverOwner.id,
        actingForOrganisationId: stage.serverOrganisation.id,
        now: new Date("2026-09-03T14:31:00.000Z"),
      });

      expect(moved.ok).toBe(true);
      expect(moved.ok ? moved.pairing.state : undefined).toBe("fulfilled");
      expect(moved.ok ? moved.pairing.clientId : undefined).toBe(
        "smart-forms-test-1",
      );

      const timeline = await listPairingTimeline(db, created.id);
      expect(timeline).toHaveLength(2);
      expect(timeline[1]?.entry.fromState).toBe("requested");
      expect(timeline[1]?.entry.toState).toBe("fulfilled");
      // What changed, recorded beside the transition: the pairing carries only its latest
      // answer, so a timeline reading the identifier off the pairing would misattribute it.
      expect(timeline[1]?.entry.detail.clientId).toBe("smart-forms-test-1");
      expect(timeline[1]?.actingFor?.id).toBe(stage.serverOrganisation.id);
    });

    it("records a decline with its reason", async () => {
      const stage = await scene();
      const created = await request(stage);

      const moved = await transitionPairing(db, {
        pairingId: created.id,
        from: "requested",
        change: { to: "declined", reason: "redirect URI not permitted here" },
        actorAccountId: stage.serverOwner.id,
        actingForOrganisationId: stage.serverOrganisation.id,
        now: new Date("2026-09-03T15:00:00.000Z"),
      });

      expect(moved.ok ? moved.pairing.declineReason : undefined).toBe(
        "redirect URI not permitted here",
      );
      const timeline = await listPairingTimeline(db, created.id);
      expect(timeline[1]?.entry.detail.reason).toBe(
        "redirect URI not permitted here",
      );
    });

    it("moves the updated timestamp so the list can be ordered by it", async () => {
      const stage = await scene();
      const created = await request(stage);
      const at = new Date("2026-09-03T14:31:00.000Z");

      const moved = await transitionPairing(db, {
        pairingId: created.id,
        from: "requested",
        change: { to: "declined", reason: "no" },
        actorAccountId: stage.serverOwner.id,
        actingForOrganisationId: stage.serverOrganisation.id,
        now: at,
      });

      expect(moved.ok ? moved.pairing.updatedAt : undefined).toEqual(at);
    });

    it("refuses a transition from a state the pairing has already left", async () => {
      // Two members of the server's organisation answering at once: the second is told the
      // pairing moved rather than overwriting the first answer.
      const stage = await scene();
      const created = await request(stage);
      await transitionPairing(db, {
        pairingId: created.id,
        from: "requested",
        change: { to: "fulfilled", clientId: "first-answer" },
        actorAccountId: stage.serverOwner.id,
        actingForOrganisationId: stage.serverOrganisation.id,
        now: new Date("2026-09-03T14:31:00.000Z"),
      });

      const second = await transitionPairing(db, {
        pairingId: created.id,
        from: "requested",
        change: { to: "declined", reason: "too late" },
        actorAccountId: stage.serverOwner.id,
        actingForOrganisationId: stage.serverOrganisation.id,
        now: new Date("2026-09-03T14:32:00.000Z"),
      });

      expect(second.ok).toBe(false);
      expect(second.ok ? undefined : second.reason).toBe("state-changed");
      // The first answer stands, and the second appended nothing.
      expect(await listPairingTimeline(db, created.id)).toHaveLength(2);
    });

    it("reports an unknown pairing as absent rather than as a race", async () => {
      const moved = await transitionPairing(db, {
        pairingId: "00000000-0000-4000-8000-000000000000",
        from: "requested",
        change: { to: "declined", reason: "no such pairing" },
        actorAccountId: null,
        actingForOrganisationId: null,
        now: new Date("2026-09-03T14:31:00.000Z"),
      });

      expect(moved.ok ? undefined : moved.reason).toBe("not-found");
    });

    it("keeps every earlier entry, in the order they happened", async () => {
      // Append-only: the timeline is the record both parties read, and a transition that
      // rewrote an earlier row would be a record of only the latest thing.
      const stage = await scene();
      const created = await request(stage);
      await transitionPairing(db, {
        pairingId: created.id,
        from: "requested",
        change: { to: "failed", reason: "the stub refused the statement" },
        actorAccountId: stage.appOwner.id,
        actingForOrganisationId: stage.appOrganisation.id,
        now: new Date("2026-09-03T11:00:00.000Z"),
      });
      await transitionPairing(db, {
        pairingId: created.id,
        from: "failed",
        change: { to: "requested" },
        actorAccountId: stage.appOwner.id,
        actingForOrganisationId: stage.appOrganisation.id,
        now: new Date("2026-09-03T12:00:00.000Z"),
      });

      const timeline = await listPairingTimeline(db, created.id);
      expect(
        timeline.map((row) => [row.entry.fromState, row.entry.toState]),
      ).toEqual([
        [null, "requested"],
        ["requested", "failed"],
        ["failed", "requested"],
      ]);
    });

    it("records an actor who acted for neither organisation", async () => {
      // A track admin closing an event acts as an admin, not for a participant.
      const stage = await scene();
      const created = await request(stage);
      const admin = await makeAccount(db, { isAdmin: true });

      await transitionPairing(db, {
        pairingId: created.id,
        from: "requested",
        change: { to: "lapsed" },
        actorAccountId: admin.id,
        actingForOrganisationId: null,
        now: new Date("2026-09-20T09:00:00.000Z"),
      });

      const timeline = await listPairingTimeline(db, created.id);
      expect(timeline[1]?.actorDisplayName).toBe(admin.displayName);
      expect(timeline[1]?.actingFor).toBeNull();
    });
  });

  describe("the pairing table's own rules", () => {
    it("refuses a fulfilled pairing with no client identifier", async () => {
      // Written directly rather than through the repository: the point is that the database
      // holds the rule, so a future route cannot record a yes with nothing attached.
      const stage = await scene();

      let thrown: unknown;
      try {
        await db.insert(pairingTable).values({
          eventId: stage.event.id,
          clientEnrolmentId: stage.clientEnrolment.id,
          serverEnrolmentId: stage.serverEnrolment.id,
          state: "fulfilled",
          registrationFields: FIELDS,
        });
      } catch (error) {
        thrown = error;
      }

      expect(isCheckViolation(thrown, "pairing_fulfilled_has_client_id")).toBe(
        true,
      );
    });

    it("refuses a declined pairing with no reason", async () => {
      const stage = await scene();

      let thrown: unknown;
      try {
        await db.insert(pairingTable).values({
          eventId: stage.event.id,
          clientEnrolmentId: stage.clientEnrolment.id,
          serverEnrolmentId: stage.serverEnrolment.id,
          state: "declined",
          registrationFields: FIELDS,
        });
      } catch (error) {
        thrown = error;
      }

      expect(isCheckViolation(thrown, "pairing_declined_has_reason")).toBe(
        true,
      );
    });
  });

  describe("findPairingSide", () => {
    it("resolves an enrolment to its system and owner", async () => {
      // What the request route needs before it can judge anything: which event the enrolment is
      // in, whether its system is a client or a server, and whose it is.
      const stage = await scene();

      const side = await findPairingSide(db, stage.clientEnrolment.id);

      expect(side?.enrolment.eventId).toBe(stage.event.id);
      expect(side?.system.id).toBe(stage.clientSystem.id);
      expect(side?.system.clientProfile).not.toBeNull();
      expect(side?.organisation.id).toBe(stage.appOrganisation.id);
    });

    it("finds nothing for an enrolment that does not exist", async () => {
      expect(
        await findPairingSide(db, "00000000-0000-4000-8000-000000000000"),
      ).toBeUndefined();
    });
  });

  describe("findPairing", () => {
    it("joins both sides to their systems and owners", async () => {
      const stage = await scene();
      const created = await request(stage);

      const found = await findPairing(db, created.id);

      expect(found?.client.system.name).toBe("Smart Forms");
      expect(found?.client.organisation.id).toBe(stage.appOrganisation.id);
      expect(found?.server.system.name).toBe("MediRecords FHIR");
      expect(found?.server.organisation.id).toBe(stage.serverOrganisation.id);
      expect(found?.event.slug).toBe(stage.event.slug);
    });

    it("finds nothing for an unknown identifier", async () => {
      expect(
        await findPairing(db, "00000000-0000-4000-8000-000000000000"),
      ).toBeUndefined();
    });
  });

  describe("listPairingsForOrganisations", () => {
    it("returns a pairing to the organisation on either side of it", async () => {
      const stage = await scene();
      const created = await request(stage);

      const asApp = await listPairingsForOrganisations(db, {
        organisationIds: [stage.appOrganisation.id],
      });
      const asServer = await listPairingsForOrganisations(db, {
        organisationIds: [stage.serverOrganisation.id],
      });

      expect(asApp.map((row) => row.pairing.id)).toContain(created.id);
      expect(asServer.map((row) => row.pairing.id)).toContain(created.id);
    });

    it("returns it once to a member of both organisations", async () => {
      // The spec's edge case: one person in both organisations sees both sides of one
      // pairing, not the same pairing twice.
      const stage = await scene();
      const created = await request(stage);

      const both = await listPairingsForOrganisations(db, {
        organisationIds: [
          stage.appOrganisation.id,
          stage.serverOrganisation.id,
        ],
      });

      expect(both.filter((row) => row.pairing.id === created.id)).toHaveLength(
        1,
      );
    });

    it("does not return somebody else's pairing", async () => {
      const stage = await scene();
      const created = await request(stage);
      const outsider = await makeAccount(db);
      const theirs = await makeOrganisation(db, outsider.id);

      const listed = await listPairingsForOrganisations(db, {
        organisationIds: [theirs.id],
      });

      expect(listed.map((row) => row.pairing.id)).not.toContain(created.id);
    });

    it("narrows to one event when asked", async () => {
      const stage = await scene();
      const created = await request(stage);
      const elsewhere = await makeEvent(db, { status: "open" });

      const listed = await listPairingsForOrganisations(db, {
        organisationIds: [stage.appOrganisation.id],
        eventSlug: elsewhere.slug,
      });

      expect(listed.map((row) => row.pairing.id)).not.toContain(created.id);
      expect(
        (
          await listPairingsForOrganisations(db, {
            organisationIds: [stage.appOrganisation.id],
            eventSlug: stage.event.slug,
          })
        ).map((row) => row.pairing.id),
      ).toContain(created.id);
    });

    it("returns nothing when the caller belongs to no organisation", async () => {
      expect(
        await listPairingsForOrganisations(db, { organisationIds: [] }),
      ).toEqual([]);
    });
  });

  describe("lapseOpenPairings", () => {
    it("lapses the pairings still waiting for an answer", async () => {
      // FR-011: closing an event marks still-open pairings lapsed.
      const stage = await scene();
      const open = await request(stage);
      const admin = await makeAccount(db, { isAdmin: true });

      const lapsed = await lapseOpenPairings(db, {
        eventId: stage.event.id,
        actorAccountId: admin.id,
        now: new Date("2026-09-20T09:00:00.000Z"),
      });

      expect(lapsed.map((row) => row.pairing.id)).toEqual([open.id]);
      expect(lapsed[0]?.pairing.state).toBe("lapsed");
      const timeline = await listPairingTimeline(db, open.id);
      expect(timeline[1]?.entry.fromState).toBe("requested");
      expect(timeline[1]?.entry.toState).toBe("lapsed");
      // The admin who closed the event, acting for neither organisation.
      expect(timeline[1]?.actorDisplayName).toBe(admin.displayName);
      expect(timeline[1]?.actingFor).toBeNull();
    });

    it("leaves a settled pairing alone", async () => {
      const stage = await scene();
      const answered = await request(stage);
      await transitionPairing(db, {
        pairingId: answered.id,
        from: "requested",
        change: { to: "fulfilled", clientId: "already-issued" },
        actorAccountId: stage.serverOwner.id,
        actingForOrganisationId: stage.serverOrganisation.id,
        now: new Date("2026-09-03T14:31:00.000Z"),
      });

      const lapsed = await lapseOpenPairings(db, {
        eventId: stage.event.id,
        actorAccountId: null,
        now: new Date("2026-09-20T09:00:00.000Z"),
      });

      expect(lapsed).toEqual([]);
      const found = await findPairing(db, answered.id);
      expect(found?.pairing.state).toBe("fulfilled");
      // Nothing appended: a pairing that did not move has no transition to record.
      expect(await listPairingTimeline(db, answered.id)).toHaveLength(2);
    });

    it("touches no other event's pairings", async () => {
      const stage = await scene();
      const untouched = await request(stage);
      const elsewhere = await makeEvent(db, {
        slug: `event-${uniqueSuffix()}`,
        status: "open",
      });

      const lapsed = await lapseOpenPairings(db, {
        eventId: elsewhere.id,
        actorAccountId: null,
        now: new Date("2026-09-20T09:00:00.000Z"),
      });

      expect(lapsed).toEqual([]);
      expect((await findPairing(db, untouched.id))?.pairing.state).toBe(
        "requested",
      );
    });

    it("returns both sides of what it lapsed, so both can be notified", async () => {
      // FR-014: every transition notifies, and a lapse notifies both organisations because
      // neither of them chose it.
      const stage = await scene();
      await request(stage);

      const lapsed = await lapseOpenPairings(db, {
        eventId: stage.event.id,
        actorAccountId: null,
        now: new Date("2026-09-20T09:00:00.000Z"),
      });

      expect(lapsed[0]?.client.organisation.id).toBe(stage.appOrganisation.id);
      expect(lapsed[0]?.server.organisation.id).toBe(
        stage.serverOrganisation.id,
      );
    });
  });
});
