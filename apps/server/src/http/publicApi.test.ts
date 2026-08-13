/**
 * The public read API, without an account.
 *
 * This is where constitution principle V is enforced rather than described. Every assertion
 * here is one of two kinds: that a reader with no account can see the directory, or that the
 * bytes they receive contain no contact detail. The second kind asserts on the raw response
 * text rather than on parsed fields, deliberately - a field nobody thought to check is exactly
 * how an address leaks, and the text search finds it wherever it is nested.
 *
 * Author: John Grimes
 */

import {
  clientProfileFixture,
  hasTestDatabase,
  makeEvent,
  serverProfileFixture,
  uniqueSuffix,
} from "@muster/db";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import { apiJson, apiRequest } from "../test/api.js";
import { createTestStack } from "../test/harness.js";

import type { TestStack } from "../test/harness.js";
import type {
  EnrolledSystem,
  EventDetail,
  EventSummary,
  MyOrganisation,
  OrganisationSystem,
} from "@muster/contracts";

describe.skipIf(!hasTestDatabase())("the public read API", () => {
  let stack: TestStack;

  beforeAll(async () => {
    stack = await createTestStack();
  });

  afterAll(async () => {
    await stack.close();
  });

  /** An open event with one enrolled server and one enrolled client, in two organisations. */
  async function populatedEvent() {
    const draft = await makeEvent(stack.db, {
      capabilityTags: ["smart-app-host", "smart-app"],
    });
    const { event } = await apiJson<{ event: EventDetail }>(
      stack,
      "PATCH",
      `/api/admin/events/${draft.slug}`,
      { cookie: stack.adminCookie, body: { status: "open" } },
    );

    const enrol = async (
      organisationName: string,
      systemName: string,
      profiles: Record<string, unknown>,
      tags: readonly string[],
    ) => {
      const account = await stack.makeMember({ displayName: "Owner" });
      const cookie = await stack.signIn(account.email);
      const { organisation } = await apiJson<{ organisation: MyOrganisation }>(
        stack,
        "POST",
        "/api/organisations",
        { cookie, body: { name: organisationName } },
        201,
      );
      const { system } = await apiJson<{ system: OrganisationSystem }>(
        stack,
        "POST",
        `/api/organisations/${organisation.id}/systems`,
        { cookie, body: { name: systemName, ...profiles } },
        201,
      );
      await apiJson(
        stack,
        "POST",
        `/api/events/${event.slug}/enrolments`,
        { cookie, body: { systemId: system.id, tags: [...tags] } },
        201,
      );
      return { account, cookie, organisation, system };
    };

    const server = await enrol(
      `MediRecords ${uniqueSuffix()}`,
      "MediRecords FHIR",
      { serverProfile: serverProfileFixture() },
      ["smart-app-host"],
    );
    const client = await enrol(
      `CSIRO ${uniqueSuffix()}`,
      "Smart Forms",
      { clientProfile: clientProfileFixture() },
      ["smart-app"],
    );
    return { event, server, client };
  }

  describe("events", () => {
    it("lists events without an account", async () => {
      const created = await makeEvent(stack.db);

      const body = await apiJson<{ events: EventSummary[] }>(
        stack,
        "GET",
        "/api/events",
      );

      expect(body.events.map((row) => row.slug)).toContain(created.slug);
    });

    it("answers one event with the tags its enrolments may choose from", async () => {
      const created = await makeEvent(stack.db, {
        capabilityTags: ["form-renderer-host"],
      });

      const body = await apiJson<{ event: EventDetail }>(
        stack,
        "GET",
        `/api/events/${created.slug}`,
      );

      expect(body.event.capabilityTags).toEqual(["form-renderer-host"]);
      expect(body.event.startsOn).toBe("2026-09-15");
    });

    it("answers an unknown slug with the error envelope", async () => {
      const response = await apiRequest(
        stack,
        "GET",
        `/api/events/absent-${uniqueSuffix()}`,
      );

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        error: "not_found",
        detail: "No event has that slug",
      });
    });
  });

  describe("the enrolled systems", () => {
    it("lists both systems with their kinds, tags and connection details", async () => {
      const { event, server, client } = await populatedEvent();

      const body = await apiJson<{ systems: EnrolledSystem[] }>(
        stack,
        "GET",
        `/api/events/${event.slug}/systems`,
      );

      // Scenario 5: an anonymous visitor sees all enrolled systems with their kinds,
      // capability tags and connection details.
      const names = body.systems.map((row) => row.name);
      expect(names).toContain("MediRecords FHIR");
      expect(names).toContain("Smart Forms");
      const found = body.systems.find(
        (row) => row.systemId === server.system.id,
      );
      expect(found?.kinds).toEqual(["server"]);
      expect(found?.tags).toEqual(["smart-app-host"]);
      expect(found?.serverProfile?.fhirBaseUrl).toBe(
        "https://fhir.muster.test/r4",
      );
      // The owning organisation is named, because two organisations may hold systems with
      // the same name.
      expect(found?.organisation.name).toBe(server.organisation.name);
      expect(
        body.systems.find((row) => row.systemId === client.system.id)
          ?.clientProfile?.launchUrl,
      ).toBe("https://app.muster.test/launch");
    });

    it("carries no contact detail at all", async () => {
      const { event, server, client } = await populatedEvent();

      const response = await apiRequest(
        stack,
        "GET",
        `/api/events/${event.slug}/systems`,
      );
      const text = await response.text();

      // Asserted on the bytes rather than on parsed fields: a field nobody thought to check
      // is exactly how an address leaks (FR-007).
      expect(text).not.toContain(server.account.email);
      expect(text).not.toContain(client.account.email);
      expect(text).not.toContain("@muster.test");
      expect(text).not.toContain("passwordHash");
    });

    it("shows the same list to a signed-in member, with contacts a request away", async () => {
      const { event, server } = await populatedEvent();

      const anonymous = await apiJson<{ systems: EnrolledSystem[] }>(
        stack,
        "GET",
        `/api/events/${event.slug}/systems`,
      );
      const signedIn = await apiJson<{ systems: EnrolledSystem[] }>(
        stack,
        "GET",
        `/api/events/${event.slug}/systems`,
        { cookie: server.cookie },
      );
      const contacts = await apiRequest(
        stack,
        "GET",
        `/api/organisations/${server.organisation.id}/contacts`,
        { cookie: server.cookie },
      );

      // The same data path feeds both (FR-021): signing in adds nothing to this response.
      expect(signedIn).toEqual(anonymous);
      // Scenario 6: the contacts are readable, from the members-only feed.
      expect(await contacts.text()).toContain(server.account.email);
    });

    it("keeps a system out of an event it is not enrolled in", async () => {
      const { server } = await populatedEvent();
      const other = await makeEvent(stack.db);

      const body = await apiJson<{ systems: EnrolledSystem[] }>(
        stack,
        "GET",
        `/api/events/${other.slug}/systems`,
      );
      const detail = await apiRequest(
        stack,
        "GET",
        `/api/events/${other.slug}/systems/${server.system.id}`,
      );

      // Scenario 7: a system enrolled in one event does not appear in another.
      expect(body.systems).toEqual([]);
      expect(detail.status).toBe(404);
    });

    it("answers one enrolled system on its own", async () => {
      const { event, server } = await populatedEvent();

      const body = await apiJson<{
        event: EventDetail;
        system: EnrolledSystem;
      }>(stack, "GET", `/api/events/${event.slug}/systems/${server.system.id}`);

      expect(body.system.systemId).toBe(server.system.id);
      expect(body.event.slug).toBe(event.slug);
    });
  });

  describe("a closed event", () => {
    it("stays readable and takes no new enrolment", async () => {
      const { event, server } = await populatedEvent();
      await apiJson(stack, "PATCH", `/api/admin/events/${event.slug}`, {
        cookie: stack.adminCookie,
        body: { status: "closed" },
      });

      const listing = await apiJson<{ systems: EnrolledSystem[] }>(
        stack,
        "GET",
        `/api/events/${event.slug}/systems`,
      );
      const enrolment = await apiRequest(
        stack,
        "POST",
        `/api/events/${event.slug}/enrolments`,
        {
          cookie: server.cookie,
          body: { systemId: server.system.id, tags: [] },
        },
      );

      // FR-011: nothing new can be enrolled, and the records remain readable.
      expect(listing.systems).toHaveLength(2);
      expect(enrolment.status).toBe(409);
      expect(((await enrolment.json()) as { error: string }).error).toBe(
        "event_not_open",
      );
    });
  });

  describe("a draft event", () => {
    it("is readable and takes no enrolment either", async () => {
      const draft = await makeEvent(stack.db);
      const owner = await stack.makeMember();
      const cookie = await stack.signIn(owner.email);
      const { organisation } = await apiJson<{ organisation: MyOrganisation }>(
        stack,
        "POST",
        "/api/organisations",
        { cookie, body: { name: `Early ${uniqueSuffix()}` } },
        201,
      );
      const { system } = await apiJson<{ system: OrganisationSystem }>(
        stack,
        "POST",
        `/api/organisations/${organisation.id}/systems`,
        {
          cookie,
          body: { name: "Too early", serverProfile: serverProfileFixture() },
        },
        201,
      );

      const response = await apiRequest(
        stack,
        "POST",
        `/api/events/${draft.slug}/enrolments`,
        { cookie, body: { systemId: system.id, tags: [] } },
      );

      expect(
        (
          await apiJson<{ event: EventDetail }>(
            stack,
            "GET",
            `/api/events/${draft.slug}`,
          )
        ).event.status,
      ).toBe("draft");
      expect(response.status).toBe(409);
    });
  });

  describe("an unmatched API path", () => {
    it("answers with the error envelope rather than the console shell", async () => {
      const response = await apiRequest(stack, "GET", "/api/nope");

      expect(response.status).toBe(404);
      expect(response.headers.get("content-type")).toContain(
        "application/json",
      );
      expect(((await response.json()) as { error: string }).error).toBe(
        "not_found",
      );
    });
  });
});
