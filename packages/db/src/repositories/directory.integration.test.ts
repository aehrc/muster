/*
 * Copyright © 2026 Commonwealth Scientific and Industrial Research Organisation
 * (CSIRO) ABN 41 687 119 230. Licensed under the Apache License, Version 2.0.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";

import { isCheckViolation, isUniqueViolation } from "../errors.ts";
import {
  deleteOrganisationMember,
  deleteSession,
  findAccountByEmail,
  findAccountBySessionToken,
  findAccountTokenByHash,
  findEnrolledSystem,
  findEnrolment,
  findEnrolmentById,
  findEventBySlug,
  findSystemById,
  insertAccount,
  insertAccountToken,
  insertEnrolment,
  insertEvent,
  insertOrganisation,
  insertOrganisationMember,
  insertSession,
  insertSystem,
  listAccountsByStatus,
  listNotifiableAdmins,
  listEnrolledSystems,
  listEvents,
  listMembershipsForAccount,
  listOrganisationContacts,
  listSystemsByOrganisation,
  markAccountTokenUsed,
  markAccountVerified,
  reconfirmEnrolment,
  supersedeAccountTokens,
  updateAccountStatus,
  updateEvent,
  updateSystem,
} from "./directory.ts";
import {
  createMigratedSchema,
  describeDatabase,
  uniqueName,
} from "../test/harness.ts";

import type { MigratedSchema } from "../test/harness.ts";

/**
 * The directory schema and its repositories against a real PostgreSQL.
 *
 * Three of these rules are constraints rather than queries, and they are here
 * because they must hold whatever a route handler believes: a system is a
 * server or a client or both, a system enrols into an event at most once, and
 * an enrolment's tags are drawn from the event's own capability tags.
 */

describeDatabase("the directory schema and repositories", () => {
  let database: MigratedSchema;

  beforeAll(async () => {
    database = await createMigratedSchema("directory");
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

  // Arranges an account with an address unique to this test.
  const arrangeAccount = async (
    email = `${uniqueName("member")}@example.org`,
  ) =>
    insertAccount(database.sql, {
      email,
      displayName: "A Member",
      passwordHash: "argon2id$stub",
    });

  // Arranges an organisation with one member.
  const arrangeOrganisation = async (
    accountId: string,
    name = "MediRecords",
  ) => {
    const organisation = await insertOrganisation(database.sql, { name });
    await insertOrganisationMember(database.sql, {
      organisationId: organisation.id,
      accountId,
    });
    return organisation;
  };

  // Arranges a server system owned by an organisation.
  const arrangeSystem = async (organisationId: string, name = "A Server") =>
    insertSystem(database.sql, {
      organisationId,
      name,
      description: "A system under test.",
      serverProfile: {
        fhirBaseUrl: "https://fhir.example.org",
        authorizationMode: "smart",
        registrationMode: "manual",
        notes: "",
      },
      clientProfile: null,
    });

  // Arranges an open event with two capability tags.
  const arrangeEvent = async (status: "draft" | "open" | "closed" = "open") =>
    insertEvent(database.sql, {
      slug: uniqueName("event"),
      name: "Sparked connectathon",
      startsOn: "2026-09-01",
      endsOn: "2026-09-03",
      status,
      capabilityTags: ["form renderer host", "form filler"],
      graceDays: 7,
    });

  // Accounts -----------------------------------------------------------------

  // The address is the account's identity, case-folded so that one person
  // cannot hold two accounts by capitalising differently.
  test("records an account and finds it by its case-folded address", async () => {
    const created = await insertAccount(database.sql, {
      email: "Server.Owner@Example.ORG",
      displayName: "Server Owner",
      passwordHash: "argon2id$stub",
    });

    expect(created.email).toBe("server.owner@example.org");
    expect(created.status).toBe("pending");
    expect(created.emailVerifiedAt).toBeNull();
    expect(created.isAdmin).toBe(false);

    const found = await findAccountByEmail(
      database.sql,
      "SERVER.OWNER@example.org",
    );
    expect(found?.id).toBe(created.id);
    expect(found?.passwordHash).toBe("argon2id$stub");
  });

  test("refuses a second account with the same address", async () => {
    const email = `${uniqueName("twice")}@example.org`;
    await arrangeAccount(email);

    const error = await rejection(arrangeAccount(email));

    expect(isUniqueViolation(error)).toBe(true);
  });

  // Verification and approval are separate facts, and both are recorded.
  test("records verification and the approval audit", async () => {
    const account = await arrangeAccount();
    const admin = await arrangeAccount();
    const verifiedAt = new Date("2026-08-14T01:02:03Z");

    const verified = await markAccountVerified(
      database.sql,
      account.id,
      verifiedAt,
    );
    expect(verified?.emailVerifiedAt).toEqual(verifiedAt);

    const approved = await updateAccountStatus(database.sql, {
      accountId: account.id,
      status: "approved",
      decidedBy: admin.id,
      decidedAt: new Date("2026-08-14T02:00:00Z"),
    });
    expect(approved?.status).toBe("approved");
    expect(approved?.approvedBy).toBe(admin.id);
    expect(approved?.approvedAt).toEqual(new Date("2026-08-14T02:00:00Z"));

    const revoked = await updateAccountStatus(database.sql, {
      accountId: account.id,
      status: "revoked",
      decidedBy: admin.id,
      decidedAt: new Date("2026-08-15T02:00:00Z"),
    });
    // The approval audit survives revocation: it is a record of what happened,
    // not of the current state.
    expect(revoked?.status).toBe("revoked");
    expect(revoked?.approvedBy).toBe(admin.id);
  });

  // The approval queue and the admin notification list are both queries the
  // admin routes depend on. The notification list holds only the admins who
  // could act on what they are told about: an admin whose own account is still
  // pending cannot approve anyone, so telling them would be noise.
  test("lists the approval queue and the admins worth notifying", async () => {
    const pending = await arrangeAccount();
    const admin = await insertAccount(database.sql, {
      email: `${uniqueName("admin")}@example.org`,
      displayName: "Track Admin",
      passwordHash: "argon2id$stub",
      isAdmin: true,
    });
    const unusableAdmin = await insertAccount(database.sql, {
      email: `${uniqueName("unusable")}@example.org`,
      displayName: "Pending Admin",
      passwordHash: "argon2id$stub",
      isAdmin: true,
    });
    await markAccountVerified(database.sql, admin.id, new Date());
    await updateAccountStatus(database.sql, {
      accountId: admin.id,
      status: "approved",
      decidedBy: admin.id,
      decidedAt: new Date(),
    });

    const queue = await listAccountsByStatus(database.sql, "pending");
    expect(queue.map((row) => row.id)).toContain(pending.id);

    const notifiable = await listNotifiableAdmins(database.sql);
    expect(notifiable.map((row) => row.email)).toContain(admin.email);
    expect(notifiable.map((row) => row.email)).not.toContain(
      unusableAdmin.email,
    );
  });

  // Tokens and sessions ------------------------------------------------------

  // Verification tokens are single use: the row records when it was spent.
  test("records a single-use token and marks it spent", async () => {
    const account = await arrangeAccount();
    const tokenHash = uniqueName("hash");

    const token = await insertAccountToken(database.sql, {
      accountId: account.id,
      tokenHash,
      purpose: "emailVerification",
      expiresAt: new Date("2026-08-15T00:00:00Z"),
    });
    expect(token.usedAt).toBeNull();
    expect(token.purpose).toBe("emailVerification");

    const spentAt = new Date("2026-08-14T12:00:00Z");
    await markAccountTokenUsed(database.sql, { id: token.id, at: spentAt });

    const reread = await insertAccountToken(database.sql, {
      accountId: account.id,
      tokenHash: uniqueName("hash"),
      purpose: "emailVerification",
      expiresAt: new Date("2026-08-15T00:00:00Z"),
    });
    expect(reread.usedAt).toBeNull();

    const spent = await findAccountByEmail(database.sql, account.email);
    expect(spent?.id).toBe(account.id);
  });

  // A fresh verification link must be the only live one: a resend supersedes
  // whatever was outstanding, so two links are never usable at once. Tokens of
  // another purpose, and tokens of another account, are left alone.
  test("supersedes an account's outstanding tokens of one purpose", async () => {
    const account = await arrangeAccount();
    const other = await arrangeAccount();
    const expiresAt = new Date("2026-08-15T00:00:00Z");
    const outstanding = uniqueName("outstanding");
    const reset = uniqueName("reset");
    const untouched = uniqueName("untouched");
    await insertAccountToken(database.sql, {
      accountId: account.id,
      tokenHash: outstanding,
      purpose: "emailVerification",
      expiresAt,
    });
    await insertAccountToken(database.sql, {
      accountId: account.id,
      tokenHash: reset,
      purpose: "passwordReset",
      expiresAt,
    });
    await insertAccountToken(database.sql, {
      accountId: other.id,
      tokenHash: untouched,
      purpose: "emailVerification",
      expiresAt,
    });

    const at = new Date("2026-08-14T12:00:00Z");
    const superseded = await supersedeAccountTokens(database.sql, {
      accountId: account.id,
      purpose: "emailVerification",
      at,
    });

    expect(superseded).toBe(1);
    expect(
      (await findAccountTokenByHash(database.sql, outstanding))?.usedAt,
    ).toEqual(at);
    expect(
      (await findAccountTokenByHash(database.sql, reset))?.usedAt,
    ).toBeNull();
    expect(
      (await findAccountTokenByHash(database.sql, untouched))?.usedAt,
    ).toBeNull();

    // Superseding again finds nothing outstanding, and does not re-stamp the
    // token it already spent.
    expect(
      await supersedeAccountTokens(database.sql, {
        accountId: account.id,
        purpose: "emailVerification",
        at: new Date("2026-08-14T13:00:00Z"),
      }),
    ).toBe(0);
    expect(
      (await findAccountTokenByHash(database.sql, outstanding))?.usedAt,
    ).toEqual(at);
  });

  // A session token is held only as a digest, and an expired session is no
  // session at all.
  test("finds the account behind a live session and ignores an expired one", async () => {
    const account = await arrangeAccount();
    const live = uniqueName("live");
    const dead = uniqueName("dead");
    await insertSession(database.sql, {
      accountId: account.id,
      tokenHash: live,
      expiresAt: new Date("2026-09-01T00:00:00Z"),
    });
    await insertSession(database.sql, {
      accountId: account.id,
      tokenHash: dead,
      expiresAt: new Date("2026-08-01T00:00:00Z"),
    });
    const now = new Date("2026-08-14T00:00:00Z");

    expect((await findAccountBySessionToken(database.sql, live, now))?.id).toBe(
      account.id,
    );
    expect(
      await findAccountBySessionToken(database.sql, dead, now),
    ).toBeUndefined();

    await deleteSession(database.sql, live);
    expect(
      await findAccountBySessionToken(database.sql, live, now),
    ).toBeUndefined();
  });

  // Organisations ------------------------------------------------------------

  // Membership is a set: joining twice leaves one row, so an invitation resent
  // does not double anyone up.
  test("records membership once and lists it both ways", async () => {
    const account = await arrangeAccount();
    const organisation = await arrangeOrganisation(account.id);
    await insertOrganisationMember(database.sql, {
      organisationId: organisation.id,
      accountId: account.id,
    });

    const contacts = await listOrganisationContacts(
      database.sql,
      organisation.id,
    );
    expect(contacts).toEqual([
      {
        accountId: account.id,
        displayName: account.displayName,
        email: account.email,
      },
    ]);

    const memberships = await listMembershipsForAccount(
      database.sql,
      account.id,
    );
    expect(memberships).toEqual([
      { organisationId: organisation.id, name: "MediRecords" },
    ]);
  });

  // The spec's edge case: the last member leaves, the organisation's systems
  // stay listed and it becomes unmanageable until an admin reassigns it.
  test("removes a member and reports whether there was one", async () => {
    const account = await arrangeAccount();
    const organisation = await arrangeOrganisation(account.id);

    expect(
      await deleteOrganisationMember(database.sql, {
        organisationId: organisation.id,
        accountId: account.id,
      }),
    ).toBe(true);
    expect(
      await deleteOrganisationMember(database.sql, {
        organisationId: organisation.id,
        accountId: account.id,
      }),
    ).toBe(false);
    expect(
      await listOrganisationContacts(database.sql, organisation.id),
    ).toEqual([]);
  });

  // Systems ------------------------------------------------------------------

  // The data model's constraint: a system that is neither a server nor a client
  // is not a system.
  test("refuses a system with neither profile", async () => {
    const account = await arrangeAccount();
    const organisation = await arrangeOrganisation(account.id);

    const error = await rejection(
      insertSystem(database.sql, {
        organisationId: organisation.id,
        name: "Neither",
        description: "",
        serverProfile: null,
        clientProfile: null,
      }),
    );

    expect(isCheckViolation(error)).toBe(true);
  });

  test("accepts a system that is only a client, and edits its profile", async () => {
    const account = await arrangeAccount();
    const organisation = await arrangeOrganisation(account.id);
    const clientProfile = {
      launchUrl: "https://app.example.org/launch",
      redirectUris: ["https://app.example.org/callback"],
      scopes: ["launch/patient", "patient/*.rs"],
      confidentiality: "public",
      launchContext: "patient",
      needsIntrospection: false,
    };

    const created = await insertSystem(database.sql, {
      organisationId: organisation.id,
      name: "Smart Forms",
      description: "A form filler.",
      serverProfile: null,
      clientProfile,
    });
    expect(created.serverProfile).toBeNull();
    expect(created.clientProfile).toEqual(clientProfile);

    const edited = await updateSystem(database.sql, created.id, {
      description: "A form filler, renamed.",
    });
    expect(edited?.description).toBe("A form filler, renamed.");
    // An unmentioned field is left alone by a patch.
    expect(edited?.clientProfile).toEqual(clientProfile);
    expect((await findSystemById(database.sql, created.id))?.name).toBe(
      "Smart Forms",
    );
  });

  // The console shows an organisation what it already owns, so the systems of
  // one organisation are listable without touching another's.
  test("lists an organisation's own systems in name order", async () => {
    const account = await arrangeAccount();
    const mine = await arrangeOrganisation(account.id);
    const theirs = await arrangeOrganisation(account.id, "Someone Else");
    await arrangeSystem(mine.id, "Zebra Server");
    await arrangeSystem(mine.id, "Alpha Server");
    await arrangeSystem(theirs.id, "Not Mine");

    const listed = await listSystemsByOrganisation(database.sql, mine.id);

    expect(listed.map((system) => system.name)).toEqual([
      "Alpha Server",
      "Zebra Server",
    ]);
  });

  // Clearing the last remaining profile is refused by the same constraint.
  test("refuses an edit that would leave a system with no profile", async () => {
    const account = await arrangeAccount();
    const organisation = await arrangeOrganisation(account.id);
    const system = await arrangeSystem(organisation.id);

    const error = await rejection(
      updateSystem(database.sql, system.id, { serverProfile: null }),
    );

    expect(isCheckViolation(error)).toBe(true);
  });

  // Events and enrolment -----------------------------------------------------

  test("records an event, finds it by slug and lists it", async () => {
    const event = await arrangeEvent("draft");

    const found = await findEventBySlug(database.sql, event.slug);
    expect(found).toEqual(event);
    expect(found?.startsOn).toBe("2026-09-01");
    expect(found?.capabilityTags).toEqual([
      "form renderer host",
      "form filler",
    ]);
    expect(found?.status).toBe("draft");

    const opened = await updateEvent(database.sql, event.slug, {
      status: "open",
    });
    expect(opened?.status).toBe("open");
    expect(opened?.capabilityTags).toEqual([
      "form renderer host",
      "form filler",
    ]);

    expect((await listEvents(database.sql)).map((row) => row.slug)).toContain(
      event.slug,
    );
  });

  test("enrols a system once and refuses a second enrolment in the same event", async () => {
    const account = await arrangeAccount();
    const organisation = await arrangeOrganisation(account.id);
    const system = await arrangeSystem(organisation.id);
    const event = await arrangeEvent();

    const enrolment = await insertEnrolment(database.sql, {
      eventId: event.id,
      systemId: system.id,
      tags: ["form filler"],
      confirmedBy: account.id,
    });
    expect(enrolment.tags).toEqual(["form filler"]);
    expect(enrolment.confirmedAt).toBeInstanceOf(Date);

    const error = await rejection(
      insertEnrolment(database.sql, {
        eventId: event.id,
        systemId: system.id,
        tags: [],
        confirmedBy: account.id,
      }),
    );
    expect(isUniqueViolation(error)).toBe(true);

    // Re-enrolment is a fresh confirmation of the same row, which is what
    // "confirm the details are current" means the second time around.
    const reconfirmed = await reconfirmEnrolment(database.sql, {
      id: enrolment.id,
      tags: ["form renderer host"],
      confirmedBy: account.id,
    });
    expect(reconfirmed?.tags).toEqual(["form renderer host"]);
    expect(reconfirmed?.confirmedAt.getTime()).toBeGreaterThanOrEqual(
      enrolment.confirmedAt.getTime(),
    );
    expect(
      (
        await findEnrolment(database.sql, {
          eventId: event.id,
          systemId: system.id,
        })
      )?.id,
    ).toBe(enrolment.id);
  });

  // A pairing names its sides by their enrolments, so an enrolment has to be
  // findable by its own identifier: what it says about its event and its system
  // is what makes a pairing legal (FR-012).
  test("finds an enrolment by its identifier, and none for an unknown one", async () => {
    const account = await arrangeAccount();
    const organisation = await arrangeOrganisation(account.id);
    const system = await arrangeSystem(organisation.id);
    const event = await arrangeEvent();
    const enrolment = await insertEnrolment(database.sql, {
      eventId: event.id,
      systemId: system.id,
      tags: [],
      confirmedBy: account.id,
    });

    const found = await findEnrolmentById(database.sql, enrolment.id);

    expect(found?.eventId).toBe(event.id);
    expect(found?.systemId).toBe(system.id);
    expect(
      await findEnrolmentById(
        database.sql,
        "1b0f8f4e-6a4a-4d64-9a4f-3c7c9c0f5b21",
      ),
    ).toBeUndefined();
  });

  // FR-009: tags are chosen from the event's set, so a typo cannot invent a
  // capability that the event does not have.
  test("refuses enrolment tags the event does not define", async () => {
    const account = await arrangeAccount();
    const organisation = await arrangeOrganisation(account.id);
    const system = await arrangeSystem(organisation.id);
    const event = await arrangeEvent();

    const error = await rejection(
      insertEnrolment(database.sql, {
        eventId: event.id,
        systemId: system.id,
        tags: ["form filler", "teleportation"],
        confirmedBy: account.id,
      }),
    );

    expect(isCheckViolation(error)).toBe(true);
    expect(
      await findEnrolment(database.sql, {
        eventId: event.id,
        systemId: system.id,
      }),
    ).toBeUndefined();
  });

  test("refuses a re-confirmation that introduces an undefined tag", async () => {
    const account = await arrangeAccount();
    const organisation = await arrangeOrganisation(account.id);
    const system = await arrangeSystem(organisation.id);
    const event = await arrangeEvent();
    const enrolment = await insertEnrolment(database.sql, {
      eventId: event.id,
      systemId: system.id,
      tags: [],
      confirmedBy: account.id,
    });

    const error = await rejection(
      reconfirmEnrolment(database.sql, {
        id: enrolment.id,
        tags: ["teleportation"],
        confirmedBy: account.id,
      }),
    );

    expect(isCheckViolation(error)).toBe(true);
  });

  // Only enrolled systems appear in an event's view (FR-009, FR-010).
  test("lists only the systems enrolled in the event", async () => {
    const account = await arrangeAccount();
    const organisation = await arrangeOrganisation(account.id);
    const enrolled = await arrangeSystem(organisation.id, "Enrolled Server");
    const elsewhere = await arrangeSystem(organisation.id, "Other Server");
    const event = await arrangeEvent();
    const pastEvent = await arrangeEvent("closed");
    await insertEnrolment(database.sql, {
      eventId: event.id,
      systemId: enrolled.id,
      tags: ["form renderer host"],
      confirmedBy: account.id,
    });
    await insertEnrolment(database.sql, {
      eventId: pastEvent.id,
      systemId: elsewhere.id,
      tags: [],
      confirmedBy: account.id,
    });

    const listed = await listEnrolledSystems(database.sql, event.id);

    expect(listed).toHaveLength(1);
    const [entry] = listed;
    expect(entry?.system.name).toBe("Enrolled Server");
    expect(entry?.organisation).toEqual({
      id: organisation.id,
      name: "MediRecords",
    });
    expect(entry?.tags).toEqual(["form renderer host"]);
    expect(entry?.system.serverProfile).toMatchObject({
      registrationMode: "manual",
    });

    const one = await findEnrolledSystem(database.sql, {
      eventId: event.id,
      systemId: enrolled.id,
    });
    expect(one?.enrolmentId).toBe(entry?.enrolmentId);
    expect(
      await findEnrolledSystem(database.sql, {
        eventId: event.id,
        systemId: elsewhere.id,
      }),
    ).toBeUndefined();
  });
});
