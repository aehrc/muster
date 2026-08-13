/**
 * Organisations, systems, enrolments and the admin decisions, end to end.
 *
 * What these assert is authority. Every route here can be reached by any signed-in member, so
 * what stops one participant editing another's entries is a predicate in a handler - and a
 * predicate is exactly the thing that gets omitted from the fifth route by somebody adding the
 * sixth. Each one is exercised from the wrong account as well as the right one.
 *
 * The other subject is the answers a participant needs to act on: which tag was not defined,
 * why an invitation was refused, why a closed event took nothing.
 *
 * Author: John Grimes
 */

import {
  clientProfileFixture,
  hasTestDatabase,
  makeAccount,
  makeEvent,
  serverProfileFixture,
  uniqueSuffix,
} from "@muster/db";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import { apiJson, apiRequest } from "../test/api.js";
import { createTestStack } from "../test/harness.js";

import type { TestStack } from "../test/harness.js";
import type {
  AdminAccount,
  EventDetail,
  MyOrganisation,
  OrganisationContacts,
  OrganisationSystem,
} from "@muster/contracts";

describe.skipIf(!hasTestDatabase())("the directory routes", () => {
  let stack: TestStack;

  beforeAll(async () => {
    stack = await createTestStack();
  });

  afterAll(async () => {
    await stack.close();
  });

  /** An approved member, signed in, with an organisation of their own. */
  async function member(name = "Jo Chen") {
    const account = await stack.makeMember({ displayName: name });
    const cookie = await stack.signIn(account.email);
    const created = await apiJson<{ organisation: MyOrganisation }>(
      stack,
      "POST",
      "/api/organisations",
      { cookie, body: { name: `Organisation ${uniqueSuffix()}` } },
      201,
    );
    return { account, cookie, organisation: created.organisation };
  }

  /** An event, open, with the two tags the wireframes use. */
  async function openEvent() {
    const draft = await makeEvent(stack.db, {
      capabilityTags: ["smart-app-host", "smart-app"],
    });
    const opened = await apiJson<{ event: EventDetail }>(
      stack,
      "PATCH",
      `/api/admin/events/${draft.slug}`,
      { cookie: stack.adminCookie, body: { status: "open" } },
    );
    return opened.event;
  }

  describe("creating an organisation", () => {
    it("makes the creator its first member", async () => {
      const { account, organisation } = await member();

      // Scenario 3: the creator becomes the first member and can then invite others.
      expect(organisation.members.map((row) => row.accountId)).toEqual([
        account.id,
      ]);
      expect(organisation.members[0]?.email).toBe(account.email);
      expect(organisation.systems).toEqual([]);
    });

    it("refuses an anonymous visitor", async () => {
      const response = await apiRequest(stack, "POST", "/api/organisations", {
        body: { name: "Nobody's" },
      });

      expect(response.status).toBe(401);
      expect(((await response.json()) as { error: string }).error).toBe(
        "not_signed_in",
      );
    });
  });

  describe("inviting a member", () => {
    it("adds an approved account and returns the new membership list", async () => {
      const host = await member();
      const guest = await stack.makeMember({ displayName: "Priya Nair" });

      const body = await apiJson<{ organisation: MyOrganisation }>(
        stack,
        "POST",
        `/api/organisations/${host.organisation.id}/members`,
        { cookie: host.cookie, body: { email: guest.email } },
      );

      expect(body.organisation.members.map((row) => row.accountId)).toContain(
        guest.id,
      );
      // Repeating an invitation is not an error: what matters is who belongs afterwards.
      const again = await apiRequest(
        stack,
        "POST",
        `/api/organisations/${host.organisation.id}/members`,
        { cookie: host.cookie, body: { email: guest.email } },
      );
      expect(again.status).toBe(200);
    });

    it("refuses an address no account holds", async () => {
      const host = await member();

      const response = await apiRequest(
        stack,
        "POST",
        `/api/organisations/${host.organisation.id}/members`,
        {
          cookie: host.cookie,
          body: { email: `stranger-${uniqueSuffix()}@muster.test` },
        },
      );

      // An invitation is not a way to create an account (FR-005).
      expect(response.status).toBe(404);
    });

    it("refuses an account that is not yet approved", async () => {
      const host = await member();
      const pending = await makeAccount(stack.db, {
        email: `pending-${uniqueSuffix()}@muster.test`,
        status: "pending",
      });

      const response = await apiRequest(
        stack,
        "POST",
        `/api/organisations/${host.organisation.id}/members`,
        { cookie: host.cookie, body: { email: pending.email } },
      );

      expect(response.status).toBe(409);
      expect(((await response.json()) as { error: string }).error).toBe(
        "invitee_not_approved",
      );
    });

    it("tells a non-member the organisation does not exist", async () => {
      const host = await member();
      const outsider = await member("Outsider");

      const response = await apiRequest(
        stack,
        "POST",
        `/api/organisations/${host.organisation.id}/members`,
        { cookie: outsider.cookie, body: { email: outsider.account.email } },
      );

      // 404 rather than 403: a 403 confirms the identifier names something, which is how a
      // directory of vendors gets enumerated by anybody with an account.
      expect(response.status).toBe(404);
    });
  });

  describe("leaving an organisation", () => {
    it("lets the last member leave, keeping the systems listed", async () => {
      const host = await member();
      const created = await apiJson<{ system: OrganisationSystem }>(
        stack,
        "POST",
        `/api/organisations/${host.organisation.id}/systems`,
        {
          cookie: host.cookie,
          body: {
            name: "Orphan FHIR",
            serverProfile: serverProfileFixture(),
          },
        },
        201,
      );

      const left = await apiRequest(
        stack,
        "DELETE",
        `/api/organisations/${host.organisation.id}/members/${host.account.id}`,
        { cookie: host.cookie },
      );

      expect(left.status).toBe(204);
      // The edge case: the systems stay and the organisation becomes unmanageable until an
      // admin reassigns it. Its former member can no longer reach it.
      const after = await apiRequest(
        stack,
        "GET",
        `/api/organisations/${host.organisation.id}/contacts`,
        { cookie: host.cookie },
      );
      expect(after.status).toBe(200);
      expect(
        ((await after.json()) as OrganisationContacts).members,
      ).toHaveLength(0);
      expect(created.system.name).toBe("Orphan FHIR");
    });

    it("lets an admin put a member back into an orphaned organisation", async () => {
      const host = await member();
      await apiRequest(
        stack,
        "DELETE",
        `/api/organisations/${host.organisation.id}/members/${host.account.id}`,
        { cookie: host.cookie },
      );
      const rescuer = await stack.makeMember({ displayName: "Rescuer" });

      const body = await apiJson<OrganisationContacts>(
        stack,
        "POST",
        `/api/admin/organisations/${host.organisation.id}/reassign`,
        { cookie: stack.adminCookie, body: { email: rescuer.email } },
      );

      expect(body.members.map((row) => row.accountId)).toEqual([rescuer.id]);
    });

    it("refuses reassignment by anybody but an admin", async () => {
      const host = await member();
      const other = await member("Other");

      const response = await apiRequest(
        stack,
        "POST",
        `/api/admin/organisations/${host.organisation.id}/reassign`,
        { cookie: other.cookie, body: { email: other.account.email } },
      );

      expect(response.status).toBe(403);
      expect(((await response.json()) as { error: string }).error).toBe(
        "not_an_admin",
      );
    });
  });

  describe("systems", () => {
    it("stores a system with both profiles and edits it wholesale", async () => {
      const host = await member();

      const created = await apiJson<{ system: OrganisationSystem }>(
        stack,
        "POST",
        `/api/organisations/${host.organisation.id}/systems`,
        {
          cookie: host.cookie,
          body: {
            name: "Beda EMR",
            description: "Server and client",
            serverProfile: serverProfileFixture(),
            clientProfile: clientProfileFixture(),
          },
        },
        201,
      );
      expect(created.system.kinds).toEqual(["server", "client"]);

      const edited = await apiJson<{ system: OrganisationSystem }>(
        stack,
        "PATCH",
        `/api/systems/${created.system.id}`,
        {
          cookie: host.cookie,
          body: { name: "Beda EMR", clientProfile: clientProfileFixture() },
        },
      );

      // The body carries the whole record, so a profile the edit omitted is gone rather
      // than silently retained.
      expect(edited.system.kinds).toEqual(["client"]);
      expect(edited.system.serverProfile).toBeNull();
    });

    it("refuses a system that is neither a server nor a client", async () => {
      const host = await member();

      const response = await apiRequest(
        stack,
        "POST",
        `/api/organisations/${host.organisation.id}/systems`,
        { cookie: host.cookie, body: { name: "Neither" } },
      );

      expect(response.status).toBe(400);
      expect(((await response.json()) as { detail: string }).detail).toContain(
        "server, a client, or both",
      );
    });

    it("refuses a trusted-DCR server with nowhere to present a statement", async () => {
      const host = await member();

      const response = await apiRequest(
        stack,
        "POST",
        `/api/organisations/${host.organisation.id}/systems`,
        {
          cookie: host.cookie,
          body: {
            name: "Half a promise",
            serverProfile: serverProfileFixture({
              registrationMode: "trustedDcr",
            }),
          },
        },
      );

      // An entry promising zero-touch registration and giving no endpoint is one no later
      // phase can use.
      expect(response.status).toBe(400);
      expect(((await response.json()) as { detail: string }).detail).toContain(
        "registrationEndpoint",
      );
    });

    it("refuses to let one organisation edit another's system", async () => {
      const owner = await member();
      const stranger = await member("Stranger");
      const created = await apiJson<{ system: OrganisationSystem }>(
        stack,
        "POST",
        `/api/organisations/${owner.organisation.id}/systems`,
        {
          cookie: owner.cookie,
          body: { name: "Not yours", serverProfile: serverProfileFixture() },
        },
        201,
      );

      const response = await apiRequest(
        stack,
        "PATCH",
        `/api/systems/${created.system.id}`,
        {
          cookie: stranger.cookie,
          body: { name: "Mine now", serverProfile: serverProfileFixture() },
        },
      );

      expect(response.status).toBe(404);
    });
  });

  describe("enrolling a system", () => {
    /** A member with a server system, and an open event. */
    async function readyToEnrol() {
      const host = await member();
      const event = await openEvent();
      const created = await apiJson<{ system: OrganisationSystem }>(
        stack,
        "POST",
        `/api/organisations/${host.organisation.id}/systems`,
        {
          cookie: host.cookie,
          body: {
            name: `MediRecords FHIR ${uniqueSuffix()}`,
            serverProfile: serverProfileFixture(),
          },
        },
        201,
      );
      return { host, event, system: created.system };
    }

    it("records a confirmation that the details are current", async () => {
      const { host, event, system } = await readyToEnrol();

      const body = await apiJson<{
        enrolment: { tags: string[]; confirmedAt: string };
      }>(
        stack,
        "POST",
        `/api/events/${event.slug}/enrolments`,
        {
          cookie: host.cookie,
          body: { systemId: system.id, tags: ["smart-app-host"] },
        },
        201,
      );

      // Scenario 4: the enrolment records a fresh confirmation.
      expect(body.enrolment.tags).toEqual(["smart-app-host"]);
      expect(body.enrolment.confirmedAt).toBe("2026-09-01T10:00:00.000Z");
    });

    it("names the tags the event does not define", async () => {
      const { host, event, system } = await readyToEnrol();

      const response = await apiRequest(
        stack,
        "POST",
        `/api/events/${event.slug}/enrolments`,
        {
          cookie: host.cookie,
          body: {
            systemId: system.id,
            tags: ["smart-app-host", "ticket-issuer"],
          },
        },
      );

      expect(response.status).toBe(422);
      const body = (await response.json()) as { error: string; detail: string };
      expect(body.error).toBe("unknown_tags");
      // Named, so the participant knows which of the ones they chose was wrong.
      expect(body.detail).toContain("ticket-issuer");
      expect(body.detail).not.toContain("smart-app-host");
    });

    it("refuses to enrol somebody else's system", async () => {
      const { event, system } = await readyToEnrol();
      const stranger = await member("Stranger");

      const response = await apiRequest(
        stack,
        "POST",
        `/api/events/${event.slug}/enrolments`,
        { cookie: stranger.cookie, body: { systemId: system.id, tags: [] } },
      );

      expect(response.status).toBe(404);
    });

    it("moves the confirmation forward when a system is enrolled again", async () => {
      const { host, event, system } = await readyToEnrol();
      const first = await apiJson<{ enrolment: { id: string } }>(
        stack,
        "POST",
        `/api/events/${event.slug}/enrolments`,
        { cookie: host.cookie, body: { systemId: system.id, tags: [] } },
        201,
      );

      stack.setNow(new Date("2026-09-05T09:00:00.000Z"));
      const second = await apiJson<{
        enrolment: { id: string; confirmedAt: string };
      }>(
        stack,
        "POST",
        `/api/events/${event.slug}/enrolments`,
        {
          cookie: host.cookie,
          body: { systemId: system.id, tags: ["smart-app"] },
        },
        201,
      );
      stack.setNow(new Date("2026-09-01T10:00:00.000Z"));

      // SC-008: re-enrolling is re-confirming, one row moved forward.
      expect(second.enrolment.id).toBe(first.enrolment.id);
      expect(second.enrolment.confirmedAt).toBe("2026-09-05T09:00:00.000Z");
    });
  });

  describe("administering events", () => {
    it("creates a draft and opens it", async () => {
      const slug = `sparked-${uniqueSuffix()}`;

      const created = await apiJson<{ event: EventDetail }>(
        stack,
        "POST",
        "/api/admin/events",
        {
          cookie: stack.adminCookie,
          body: {
            slug,
            name: "Sparked Connectathon September 2026",
            startsOn: "2026-09-15",
            endsOn: "2026-09-19",
            capabilityTags: ["smart-app-host"],
            graceDays: 7,
          },
        },
        201,
      );

      // FR-008: an event carries a name, a date range and its own capability tags, and it
      // starts as a draft.
      expect(created.event.status).toBe("draft");
      expect(created.event.capabilityTags).toEqual(["smart-app-host"]);

      const opened = await apiJson<{ event: EventDetail }>(
        stack,
        "PATCH",
        `/api/admin/events/${slug}`,
        { cookie: stack.adminCookie, body: { status: "open" } },
      );
      expect(opened.event.status).toBe("open");
      // The patch named only the status, so the tags are untouched.
      expect(opened.event.capabilityTags).toEqual(["smart-app-host"]);
    });

    it("refuses a second event with the same slug", async () => {
      const slug = `duplicate-${uniqueSuffix()}`;
      const body = {
        slug,
        name: "First",
        startsOn: "2026-09-15",
        endsOn: "2026-09-19",
      };
      await apiJson(
        stack,
        "POST",
        "/api/admin/events",
        { cookie: stack.adminCookie, body },
        201,
      );

      const second = await apiRequest(stack, "POST", "/api/admin/events", {
        cookie: stack.adminCookie,
        body: { ...body, name: "Second" },
      });

      expect(second.status).toBe(409);
      expect(((await second.json()) as { error: string }).error).toBe(
        "slug_taken",
      );
    });

    it("refuses to re-open a closed event", async () => {
      const event = await openEvent();
      await apiJson(stack, "PATCH", `/api/admin/events/${event.slug}`, {
        cookie: stack.adminCookie,
        body: { status: "closed" },
      });

      const response = await apiRequest(
        stack,
        "PATCH",
        `/api/admin/events/${event.slug}`,
        { cookie: stack.adminCookie, body: { status: "open" } },
      );

      expect(response.status).toBe(409);
      expect(((await response.json()) as { error: string }).error).toBe(
        "illegal_transition",
      );
    });

    it("refuses event administration by an ordinary member", async () => {
      const ordinary = await member("Ordinary");

      const response = await apiRequest(stack, "POST", "/api/admin/events", {
        cookie: ordinary.cookie,
        body: {
          slug: `nope-${uniqueSuffix()}`,
          name: "Nope",
          startsOn: "2026-09-15",
          endsOn: "2026-09-19",
        },
      });

      // FR-004: the admin role is distinct from ordinary membership.
      expect(response.status).toBe(403);
    });
  });

  describe("approving and revoking", () => {
    it("approves a pending account, emails it, and says it did", async () => {
      const pending = await makeAccount(stack.db, {
        email: `queued-${uniqueSuffix()}@muster.test`,
        displayName: "Alen Kim",
        status: "pending",
      });
      const before = stack.sent.length;

      const body = await apiJson<{ account: AdminAccount; notified: boolean }>(
        stack,
        "POST",
        `/api/admin/accounts/${pending.id}/approve`,
        { cookie: stack.adminCookie },
      );

      // Scenario 2: the member is notified and gains standing membership.
      expect(body.account.status).toBe("approved");
      expect(body.notified).toBe(true);
      expect(stack.sent.slice(before).map((message) => message.to)).toContain(
        pending.email,
      );
      expect(stack.sent.at(-1)?.subject).toContain("approved");
    });

    it("revokes a membership, emails it, and blocks the account's writes", async () => {
      const doomed = await member("Doomed");
      const before = stack.sent.length;

      const body = await apiJson<{ account: AdminAccount; notified: boolean }>(
        stack,
        "POST",
        `/api/admin/accounts/${doomed.account.id}/revoke`,
        { cookie: stack.adminCookie },
      );
      const write = await apiRequest(stack, "POST", "/api/organisations", {
        cookie: doomed.cookie,
        body: { name: "Too late" },
      });

      // Scenario 8: the account can no longer create or edit content.
      expect(body.account.status).toBe("revoked");
      expect(write.status).toBe(403);
      expect(((await write.json()) as { error: string }).error).toBe(
        "revoked_member",
      );
      expect(stack.sent.slice(before).map((message) => message.to)).toContain(
        doomed.account.email,
      );
    });

    it("refuses to reject a pending account, because there is no such transition", async () => {
      const pending = await makeAccount(stack.db, {
        email: `never-${uniqueSuffix()}@muster.test`,
        status: "pending",
      });

      const response = await apiRequest(
        stack,
        "POST",
        `/api/admin/accounts/${pending.id}/revoke`,
        { cookie: stack.adminCookie },
      );

      // `data-model.md` names pending -> approved, approved -> revoked and
      // revoked -> approved, and nothing else. A sign-up nobody wants stays pending.
      expect(response.status).toBe(409);
      expect(((await response.json()) as { error: string }).error).toBe(
        "illegal_transition",
      );
    });

    it("lists the approval queue with each account's organisations", async () => {
      const waiting = await makeAccount(stack.db, {
        email: `waiting-${uniqueSuffix()}@muster.test`,
        status: "pending",
      });
      const joined = await member("Joined");

      const queue = await apiJson<{ accounts: AdminAccount[] }>(
        stack,
        "GET",
        "/api/admin/accounts?status=pending",
        { cookie: stack.adminCookie },
      );
      const everybody = await apiJson<{ accounts: AdminAccount[] }>(
        stack,
        "GET",
        "/api/admin/accounts",
        { cookie: stack.adminCookie },
      );

      expect(queue.accounts.map((row) => row.id)).toContain(waiting.id);
      expect(queue.accounts.every((row) => row.status === "pending")).toBe(
        true,
      );
      expect(
        everybody.accounts
          .find((row) => row.id === joined.account.id)
          ?.organisations.map((org) => org.id),
      ).toEqual([joined.organisation.id]);
    });

    it("refuses an unrecognised status filter", async () => {
      const response = await apiRequest(
        stack,
        "GET",
        "/api/admin/accounts?status=banished",
        { cookie: stack.adminCookie },
      );

      expect(response.status).toBe(400);
    });

    it("reports a notification that could not be sent", async () => {
      const failing = await createTestStack({ mail: "failing" });
      try {
        const pending = await makeAccount(failing.db, {
          email: `unreachable-${uniqueSuffix()}@muster.test`,
          status: "pending",
        });

        const body = await apiJson<{ notified: boolean }>(
          failing,
          "POST",
          `/api/admin/accounts/${pending.id}/approve`,
          { cookie: failing.adminCookie },
        );

        // FR-037: the decision stands and the response says the member was not told, rather
        // than reporting plain success.
        expect(body.notified).toBe(false);
      } finally {
        await failing.close();
      }
    });
  });

  describe("contact details", () => {
    it("shows any approved member the contacts of any organisation", async () => {
      const owner = await member("Owner");
      const reader = await member("Reader");

      const body = await apiJson<OrganisationContacts>(
        stack,
        "GET",
        `/api/organisations/${owner.organisation.id}/contacts`,
        { cookie: reader.cookie },
      );

      // Scenario 6: a signed-in approved member viewing a system also sees the owning
      // organisation's contact details.
      expect(body.members.map((row) => row.email)).toContain(
        owner.account.email,
      );
    });

    it("refuses an anonymous visitor", async () => {
      const owner = await member("Owner");

      const response = await apiRequest(
        stack,
        "GET",
        `/api/organisations/${owner.organisation.id}/contacts`,
      );

      // FR-007: contact details are not published to anonymous readers.
      expect(response.status).toBe(401);
      expect(await response.text()).not.toContain(owner.account.email);
    });
  });
});
