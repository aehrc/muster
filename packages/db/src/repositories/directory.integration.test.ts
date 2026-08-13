/**
 * The directory's tables and repositories, against a real Postgres.
 *
 * What these assert is what no unit test can: the constraints. A folded address is unique
 * because an index says so, a system with no profile cannot be written because a check
 * says so, and a second enrolment of one system in one event updates the first row because
 * a unique index turns the insert into an upsert. Each of those is a rule the routes rely
 * on and none of them is expressible in a mock.
 *
 * Every call is made as the non-owning serving role, which is what a deployment serves
 * with. Running as the owner would pass whether or not the grants in `../roles.ts` were
 * correct.
 *
 * Skipped unless `MUSTER_TEST_DATABASE_URL` names a throwaway database. CI provides one,
 * so a skip there is a failure of the workflow rather than an accepted state.
 *
 * Author: John Grimes
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import {
  addOrganisationMember,
  deleteExpiredSessions,
  deleteSession,
  findAccountByEmail,
  findAccountById,
  findAccountBySessionToken,
  findAccountToken,
  findEventBySlug,
  findEventEnrolment,
  findSystemById,
  insertAccount,
  insertAccountToken,
  insertSession,
  insertSystem,
  isOrganisationMember,
  listAccounts,
  listAdminEmails,
  listEnrolmentsForOrganisation,
  listEventEnrolments,
  listEvents,
  listMemberships,
  listOrganisationMembers,
  listOrganisationsForAccounts,
  listSystemsForOrganisation,
  markAccountTokenUsed,
  markEmailVerified,
  removeOrganisationMember,
  setAccountStatus,
  updateEvent,
  updateSystem,
  upsertEnrolment,
} from "./directory.js";
import {
  clientProfileFixture,
  makeAccount,
  makeEvent,
  makeOrganisation,
  makeSystem,
  serverProfileFixture,
  uniqueSuffix,
} from "../test/factories.js";
import { hasTestDatabase, openTestDatabase } from "../test/harness.js";

import type { DatabaseHandle } from "../client.js";
import type { Executor } from "../executor.js";

describe.skipIf(!hasTestDatabase())("the directory repositories", () => {
  let handle: DatabaseHandle;
  let db: Executor;

  beforeAll(async () => {
    handle = (await openTestDatabase())!;
    db = handle.db;
  });

  afterAll(async () => {
    await handle.close();
  });

  const NOW = new Date("2026-09-01T10:00:00.000Z");

  describe("creating accounts", () => {
    it("stores a pending, unverified account", async () => {
      const email = `signup-${uniqueSuffix()}@muster.test`;
      const created = await insertAccount(db, {
        email,
        displayName: "Jo Chen",
        passwordHash: "argon2id$hash",
      });

      expect(created.ok).toBe(true);
      if (!created.ok) {
        return;
      }
      // FR-001 and FR-002 together: a fresh sign-up is neither verified nor approved.
      expect(created.account.status).toBe("pending");
      expect(created.account.emailVerifiedAt).toBeNull();
      expect(created.account.isAdmin).toBe(false);
    });

    it("refuses a second account for the same address", async () => {
      const email = `duplicate-${uniqueSuffix()}@muster.test`;
      const values = {
        email,
        displayName: "First",
        passwordHash: "argon2id$hash",
      };

      expect((await insertAccount(db, values)).ok).toBe(true);
      const second = await insertAccount(db, {
        ...values,
        displayName: "Second",
      });

      // The refusal is a value rather than a throw, because two sign-ups arriving
      // together both pass a prior lookup and only the index decides between them.
      expect(second).toEqual({ ok: false, reason: "email-taken" });
    });

    it("finds an account by the address it was stored under", async () => {
      const email = `lookup-${uniqueSuffix()}@muster.test`;
      const created = await insertAccount(db, {
        email,
        displayName: "Jo",
        passwordHash: "argon2id$hash",
      });

      const found = await findAccountByEmail(db, email);
      expect(found?.id).toBe(created.ok ? created.account.id : "");
      // The repositories store and compare the folded form; the folding itself is
      // `foldEmail`'s job and is unit tested there.
      expect(found?.email).toBe(email);
    });
  });

  describe("verifying an address", () => {
    it("records the moment the holder followed the link", async () => {
      const unverified = await makeAccount(db, {
        verified: false,
        status: "pending",
      });

      const verified = await markEmailVerified(db, unverified.id, NOW);

      expect(verified?.emailVerifiedAt).toEqual(NOW);
    });

    it("refuses to verify twice", async () => {
      const unverified = await makeAccount(db, {
        verified: false,
        status: "pending",
      });
      await markEmailVerified(db, unverified.id, NOW);

      const again = await markEmailVerified(
        db,
        unverified.id,
        new Date("2026-09-02T10:00:00.000Z"),
      );

      // The edge case, held by the predicate rather than by the caller looking first: a
      // replayed link must not move the timestamp.
      expect(again).toBeUndefined();
      const stored = await findAccountById(db, unverified.id);
      expect(stored?.emailVerifiedAt).toEqual(NOW);
    });
  });

  describe("approving and revoking", () => {
    it("records who decided and when", async () => {
      const admin = await makeAccount(db, { isAdmin: true });
      const member = await makeAccount(db, { status: "pending" });

      const approved = await setAccountStatus(db, {
        accountId: member.id,
        status: "approved",
        decidedBy: admin.id,
        now: NOW,
      });

      expect(approved?.status).toBe("approved");
      expect(approved?.approvedBy).toBe(admin.id);
      expect(approved?.approvedAt).toEqual(NOW);
    });

    it("reports nothing for an account that does not exist", async () => {
      const admin = await makeAccount(db, { isAdmin: true });

      const missing = await setAccountStatus(db, {
        accountId: "00000000-0000-0000-0000-000000000000",
        status: "approved",
        decidedBy: admin.id,
        now: NOW,
      });

      expect(missing).toBeUndefined();
    });

    it("lists the accounts in one status, and the admins' addresses", async () => {
      const admin = await makeAccount(db, { isAdmin: true });
      const waiting = await makeAccount(db, { status: "pending" });

      const pending = await listAccounts(db, "pending");
      const admins = await listAdminEmails(db);

      // Filtered to this suite's own fixtures: the tables are shared with every other
      // suite in the run, so a count would be a race.
      expect(pending.map((row) => row.id)).toContain(waiting.id);
      expect(pending.every((row) => row.status === "pending")).toBe(true);
      expect(admins).toContain(admin.email);
      expect((await listAccounts(db)).map((row) => row.id)).toContain(
        waiting.id,
      );
    });
  });

  describe("one-shot tokens", () => {
    it("redeems a token exactly once", async () => {
      const member = await makeAccount(db, {
        verified: false,
        status: "pending",
      });
      const tokenHash = `hash-${uniqueSuffix()}`;
      const stored = await insertAccountToken(db, {
        accountId: member.id,
        purpose: "email_verification",
        tokenHash,
        expiresAt: new Date("2026-09-02T10:00:00.000Z"),
      });

      expect((await findAccountToken(db, tokenHash))?.id).toBe(stored.id);
      expect((await markAccountTokenUsed(db, stored.id, NOW))?.usedAt).toEqual(
        NOW,
      );
      // The second redemption of a link that is still sitting in a mailbox.
      expect(await markAccountTokenUsed(db, stored.id, NOW)).toBeUndefined();
    });

    it("finds nothing for a digest it never stored", async () => {
      expect(
        await findAccountToken(db, `absent-${uniqueSuffix()}`),
      ).toBeUndefined();
    });
  });

  describe("sessions", () => {
    it("resolves a live session to its account and refuses an expired one", async () => {
      const member = await makeAccount(db);
      const live = `live-${uniqueSuffix()}`;
      const stale = `stale-${uniqueSuffix()}`;
      await insertSession(db, {
        accountId: member.id,
        tokenHash: live,
        expiresAt: new Date("2026-09-02T10:00:00.000Z"),
      });
      await insertSession(db, {
        accountId: member.id,
        tokenHash: stale,
        expiresAt: new Date("2026-08-31T10:00:00.000Z"),
      });

      expect((await findAccountBySessionToken(db, live, NOW))?.id).toBe(
        member.id,
      );
      // The expiry is in the predicate rather than checked afterwards, so an expired
      // session identifies nobody.
      expect(await findAccountBySessionToken(db, stale, NOW)).toBeUndefined();
    });

    it("ends one session and sweeps the expired ones", async () => {
      const member = await makeAccount(db);
      const signedOut = `signed-out-${uniqueSuffix()}`;
      await insertSession(db, {
        accountId: member.id,
        tokenHash: signedOut,
        expiresAt: new Date("2026-09-02T10:00:00.000Z"),
      });
      await insertSession(db, {
        accountId: member.id,
        tokenHash: `expired-${uniqueSuffix()}`,
        expiresAt: new Date("2026-08-30T10:00:00.000Z"),
      });

      await deleteSession(db, signedOut);
      expect(
        await findAccountBySessionToken(db, signedOut, NOW),
      ).toBeUndefined();
      // Reported rather than silent, so a scheduled sweep can say what it did.
      expect(await deleteExpiredSessions(db, NOW)).toBeGreaterThanOrEqual(1);
    });
  });

  describe("organisations", () => {
    it("creates an organisation with its creator as first member", async () => {
      const founder = await makeAccount(db);

      const created = await makeOrganisation(db, founder.id);

      // Scenario 3: the creator becomes the first member, in one transaction, because an
      // organisation with no members is the state the spec calls orphaned.
      expect(
        await isOrganisationMember(db, {
          organisationId: created.id,
          accountId: founder.id,
        }),
      ).toBe(true);
      expect(
        (await listMemberships(db, founder.id)).map(
          (row) => row.organisationId,
        ),
      ).toEqual([created.id]);
    });

    it("treats a repeated invitation as already done", async () => {
      const founder = await makeAccount(db);
      const invitee = await makeAccount(db);
      const org = await makeOrganisation(db, founder.id);

      const added = await addOrganisationMember(db, {
        organisationId: org.id,
        accountId: invitee.id,
      });
      const again = await addOrganisationMember(db, {
        organisationId: org.id,
        accountId: invitee.id,
      });

      expect(added).toBeDefined();
      expect(again).toBeUndefined();
    });

    it("lets the last member leave, orphaning the organisation", async () => {
      const founder = await makeAccount(db);
      const org = await makeOrganisation(db, founder.id);
      const system = await makeSystem(db, org.id);

      expect(
        await removeOrganisationMember(db, {
          organisationId: org.id,
          accountId: founder.id,
        }),
      ).toBe(true);

      // The edge case: the systems stay, and the organisation becomes unmanageable until
      // an admin reassigns it. Losing the entries mid-event would be worse.
      expect(
        await removeOrganisationMember(db, {
          organisationId: org.id,
          accountId: founder.id,
        }),
      ).toBe(false);
      expect(
        (await listSystemsForOrganisation(db, org.id)).map((row) => row.id),
      ).toEqual([system.id]);
      expect(await listOrganisationMembers(db, org.id)).toEqual([]);
    });

    it("reads its members' contact details", async () => {
      const founder = await makeAccount(db, { displayName: "Jo Chen" });
      const org = await makeOrganisation(db, founder.id);

      const contacts = await listOrganisationMembers(db, org.id);

      expect(contacts).toHaveLength(1);
      expect(contacts[0]?.email).toBe(founder.email);
      expect(contacts[0]?.displayName).toBe("Jo Chen");
      expect(contacts[0]?.joinedAt).toBeInstanceOf(Date);
    });

    it("attributes organisations to several accounts in one query", async () => {
      const one = await makeAccount(db);
      const two = await makeAccount(db);
      const orgOne = await makeOrganisation(db, one.id);
      const orgTwo = await makeOrganisation(db, two.id);

      const rows = await listOrganisationsForAccounts(db, [one.id, two.id]);

      expect(rows).toEqual(
        expect.arrayContaining([
          {
            accountId: one.id,
            organisationId: orgOne.id,
            organisationName: orgOne.name,
          },
          {
            accountId: two.id,
            organisationId: orgTwo.id,
            organisationName: orgTwo.name,
          },
        ]),
      );
      // Asked with nothing to look up, it asks the database nothing.
      expect(await listOrganisationsForAccounts(db, [])).toEqual([]);
    });
  });

  describe("systems", () => {
    it("refuses a system that is neither a server nor a client", async () => {
      const founder = await makeAccount(db);
      const org = await makeOrganisation(db, founder.id);

      // The check constraint, not a route's validation. A row nobody can pair with would
      // otherwise become reachable the day a new route forgot to look.
      await expect(
        insertSystem(db, {
          organisationId: org.id,
          system: {
            name: "Neither",
            description: "",
            serverProfile: null,
            clientProfile: null,
          },
        }),
      ).rejects.toThrow();
    });

    it("stores both profiles, and replaces them wholesale on edit", async () => {
      const founder = await makeAccount(db);
      const org = await makeOrganisation(db, founder.id);
      const created = await makeSystem(db, org.id, {
        name: "Beda EMR",
        clientProfile: clientProfileFixture(),
      });

      expect(created.serverProfile?.fhirBaseUrl).toBe(
        "https://fhir.muster.test/r4",
      );
      expect(created.clientProfile?.redirectUris).toEqual([
        "https://app.muster.test/callback",
      ]);

      const edited = await updateSystem(db, {
        systemId: created.id,
        now: NOW,
        system: {
          name: "Beda EMR",
          description: "Now a server only",
          serverProfile: serverProfileFixture({
            registrationMode: "trustedDcr",
            registrationEndpoint: "https://fhir.muster.test/register",
          }),
          clientProfile: null,
        },
      });

      // A whole-record write: the client profile the edit omitted is gone rather than
      // silently retained, which is what the console's form means when it submits.
      expect(edited?.clientProfile).toBeNull();
      expect(edited?.serverProfile?.registrationMode).toBe("trustedDcr");
      expect((await findSystemById(db, created.id))?.description).toBe(
        "Now a server only",
      );
    });

    it("lets two organisations hold systems with the same name", async () => {
      const one = await makeAccount(db);
      const two = await makeAccount(db);
      const orgOne = await makeOrganisation(db, one.id);
      const orgTwo = await makeOrganisation(db, two.id);
      const shared = `Beda EMR ${uniqueSuffix()}`;

      const first = await makeSystem(db, orgOne.id, { name: shared });
      const second = await makeSystem(db, orgTwo.id, { name: shared });

      // The edge case: names are not unique, identity is the record, and the event view
      // shows the owning organisation.
      expect(first.id).not.toBe(second.id);
      expect(first.name).toBe(second.name);
    });
  });

  describe("events", () => {
    it("refuses a second event with the same slug", async () => {
      const slug = `sparked-${uniqueSuffix()}`;
      await makeEvent(db, { slug });

      // Every public address for an event is built from its slug, so two events cannot
      // share one.
      await expect(makeEvent(db, { slug })).rejects.toThrow();
    });

    it("refuses an event that ends before it starts", async () => {
      // Statement and ticket expiry derive from `endsOn` plus a grace period, so a
      // reversed range would mint credentials that expired before the event opened.
      await expect(
        makeEvent(db, { startsOn: "2026-09-19", endsOn: "2026-09-15" }),
      ).rejects.toThrow();
    });

    it("applies only the fields a patch names", async () => {
      const created = await makeEvent(db, {
        capabilityTags: ["smart-app-host", "form-renderer-host"],
      });

      const opened = await updateEvent(db, {
        slug: created.slug,
        patch: { status: "open" },
        now: NOW,
      });

      // The failure this prevents: an admin opening an event and finding its capability
      // tags blanked because the patch did not mention them.
      expect(opened?.status).toBe("open");
      expect(opened?.capabilityTags).toEqual([
        "smart-app-host",
        "form-renderer-host",
      ]);
      expect(opened?.name).toBe(created.name);
    });

    it("reads an event by slug and lists it among the rest", async () => {
      const created = await makeEvent(db);

      expect((await findEventBySlug(db, created.slug))?.id).toBe(created.id);
      expect((await listEvents(db)).map((row) => row.id)).toContain(created.id);
      expect(
        await findEventBySlug(db, `absent-${uniqueSuffix()}`),
      ).toBeUndefined();
    });
  });

  describe("enrolments", () => {
    /** An open event, an organisation and a system in it. */
    async function openEventWithSystem() {
      const member = await makeAccount(db);
      const org = await makeOrganisation(db, member.id);
      const system = await makeSystem(db, org.id);
      const draft = await makeEvent(db, {
        capabilityTags: ["smart-app-host", "smart-app"],
      });
      const opened = await updateEvent(db, {
        slug: draft.slug,
        patch: { status: "open" },
        now: NOW,
      });
      return { member, org, system, event: opened! };
    }

    it("records the confirmation the enrolment exists for", async () => {
      const { member, system, event } = await openEventWithSystem();

      const written = await upsertEnrolment(db, {
        event,
        systemId: system.id,
        tags: ["smart-app-host"],
        confirmedBy: member.id,
        confirmedAt: NOW,
      });

      expect(written.ok).toBe(true);
      if (!written.ok) {
        return;
      }
      // FR-009: the enrolment is a participant saying "these details are current as of
      // now", which is what the Confluence table could never record.
      expect(written.enrolment.confirmedAt).toEqual(NOW);
      expect(written.enrolment.confirmedBy).toBe(member.id);
      expect(written.enrolment.tags).toEqual(["smart-app-host"]);
    });

    it("re-confirms rather than duplicating a second enrolment", async () => {
      const { member, system, event } = await openEventWithSystem();
      const first = await upsertEnrolment(db, {
        event,
        systemId: system.id,
        tags: ["smart-app-host"],
        confirmedBy: member.id,
        confirmedAt: NOW,
      });

      const later = new Date("2026-09-05T09:00:00.000Z");
      const second = await upsertEnrolment(db, {
        event,
        systemId: system.id,
        tags: ["smart-app"],
        confirmedBy: member.id,
        confirmedAt: later,
      });

      expect(first.ok && second.ok).toBe(true);
      if (!first.ok || !second.ok) {
        return;
      }
      // SC-008: re-enrolling is re-confirming. One row, moved forward.
      expect(second.enrolment.id).toBe(first.enrolment.id);
      expect(second.enrolment.confirmedAt).toEqual(later);
      expect(second.enrolment.tags).toEqual(["smart-app"]);
      expect(await listEventEnrolments(db, event.id)).toHaveLength(1);
    });

    it("refuses a tag the event does not define, naming it", async () => {
      const { member, system, event } = await openEventWithSystem();

      const written = await upsertEnrolment(db, {
        event,
        systemId: system.id,
        tags: ["smart-app-host", "ticket-issuer"],
        confirmedBy: member.id,
        confirmedAt: NOW,
      });

      // Named rather than counted: the participant has to know which of the tags they
      // chose was the wrong one.
      expect(written).toEqual({
        ok: false,
        reason: "unknown-tags",
        tags: ["ticket-issuer"],
      });
    });

    it("refuses enrolment into an event that is not open", async () => {
      const member = await makeAccount(db);
      const org = await makeOrganisation(db, member.id);
      const system = await makeSystem(db, org.id);
      const draft = await makeEvent(db);

      const intoDraft = await upsertEnrolment(db, {
        event: draft,
        systemId: system.id,
        tags: [],
        confirmedBy: member.id,
        confirmedAt: NOW,
      });

      const closed = (await updateEvent(db, {
        slug: draft.slug,
        patch: { status: "open" },
        now: NOW,
      }))!;
      const shut = (await updateEvent(db, {
        slug: closed.slug,
        patch: { status: "closed" },
        now: NOW,
      }))!;
      const intoClosed = await upsertEnrolment(db, {
        event: shut,
        systemId: system.id,
        tags: [],
        confirmedBy: member.id,
        confirmedAt: NOW,
      });

      // FR-011: a closed event keeps its records readable and takes nothing new. Enforced
      // here as well as in the route, so there is one place that decides it.
      expect(intoDraft).toEqual({ ok: false, reason: "event-not-open" });
      expect(intoClosed).toEqual({ ok: false, reason: "event-not-open" });
    });

    it("lists an event's enrolments with their owning organisation", async () => {
      const { member, org, system, event } = await openEventWithSystem();
      await upsertEnrolment(db, {
        event,
        systemId: system.id,
        tags: ["smart-app-host"],
        confirmedBy: member.id,
        confirmedAt: NOW,
      });

      const rows = await listEventEnrolments(db, event.id);

      expect(rows).toHaveLength(1);
      expect(rows[0]?.system.id).toBe(system.id);
      expect(rows[0]?.organisation.name).toBe(org.name);
      expect(
        (
          await findEventEnrolment(db, {
            eventId: event.id,
            systemId: system.id,
          })
        )?.organisation.id,
      ).toBe(org.id);
    });

    it("keeps a past event's enrolment out of the current event", async () => {
      const { member, system, event } = await openEventWithSystem();
      await upsertEnrolment(db, {
        event,
        systemId: system.id,
        tags: [],
        confirmedBy: member.id,
        confirmedAt: NOW,
      });

      const current = (await updateEvent(db, {
        slug: (
          await makeEvent(db, { startsOn: "2026-12-01", endsOn: "2026-12-05" })
        ).slug,
        patch: { status: "open" },
        now: NOW,
      }))!;

      // Scenario 7: a system enrolled in a past event and not the current one does not
      // appear in the current one.
      expect(await listEventEnrolments(db, current.id)).toEqual([]);
      expect(
        await findEventEnrolment(db, {
          eventId: current.id,
          systemId: system.id,
        }),
      ).toBeUndefined();
    });

    it("reports where an organisation's systems are enrolled", async () => {
      const { org, member, system, event } = await openEventWithSystem();
      await upsertEnrolment(db, {
        event,
        systemId: system.id,
        tags: [],
        confirmedBy: member.id,
        confirmedAt: NOW,
      });

      const rows = await listEnrolmentsForOrganisation(db, org.id);

      expect(rows).toHaveLength(1);
      expect(rows[0]?.event.slug).toBe(event.slug);
      expect(rows[0]?.enrolment.systemId).toBe(system.id);
    });
  });
});
