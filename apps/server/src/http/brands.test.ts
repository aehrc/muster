/**
 * The brands bundle route: what an anonymous app gets, and what it does not.
 *
 * FR-022 publishes a brands bundle per event, and SC-006 makes it readable without an
 * account. The pure suite in `packages/core/src/brands/build.test.ts` decides the format;
 * this one decides the wiring, which is where the two requirements that are about the
 * database itself live.
 *
 * Scenario 3, twice over. A system enrolled in another event and a system enrolled in none
 * are both absent, which is the event scoping. A client-only system enrolled in *this* event
 * is absent too, which is the other half of "of the enrolled servers": a client has no FHIR
 * base URL to hand an app and nothing to discover.
 *
 * And the constitutional part: the request carries no cookie, and the owner's address does
 * not appear in the answer.
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
import { createTestStack, TEST_PUBLIC_URL } from "../test/harness.js";

import type { TestStack } from "../test/harness.js";
import type { CapabilityHighlights } from "@muster/contracts";
import type { AccountRow, EventRow, SystemRow } from "@muster/db";
import type { Bundle, Endpoint, Organization } from "fhir/r4";

/** What a check read off a server's CapabilityStatement. */
const CAPABILITY: CapabilityHighlights = {
  fhirVersion: "4.3.0",
  softwareName: "Fixture FHIR",
  softwareVersion: "1.0.0",
  implementationUrl: null,
  resourceTypes: ["Patient"],
  smartAuthorizationEndpoint: null,
  smartTokenEndpoint: null,
  smartRegisterEndpoint: null,
};

/** An event with two enrolled servers, a client, and a server enrolled elsewhere. */
interface Scene {
  readonly event: EventRow;
  readonly owner: AccountRow;
  /** Enrolled, a server, and checked. */
  readonly medirecords: SystemRow;
  /** Enrolled, a server, never checked. */
  readonly signet: SystemRow;
  /** Enrolled in this event, but a client only. */
  readonly smartForms: SystemRow;
  /** A server, but enrolled in another event. */
  readonly elsewhere: SystemRow;
  /** A server owned by the same organisation and enrolled nowhere. */
  readonly unenrolled: SystemRow;
}

describe.skipIf(!hasTestDatabase())("the brands bundle route", () => {
  let stack: TestStack;

  beforeAll(async () => {
    stack = await createTestStack();
  });

  afterAll(async () => {
    await stack.close();
  });

  /** Arranges the scene above. */
  async function scene(): Promise<Scene> {
    const owner = await stack.makeMember({ displayName: "Sam Patel" });
    const organisation = await makeOrganisation(
      stack.db,
      owner.id,
      `MediRecords ${uniqueSuffix()}`,
    );
    const event = await makeEvent(stack.db, { status: "open" });
    const other = await makeEvent(stack.db, { status: "open" });

    const medirecords = await makeSystem(stack.db, organisation.id, {
      name: "MediRecords FHIR",
      serverProfile: serverProfileFixture({
        fhirBaseUrl: "https://fhir.medirecords.test/r4",
      }),
    });
    const signet = await makeSystem(stack.db, organisation.id, {
      name: "Signet",
      serverProfile: serverProfileFixture({
        fhirBaseUrl: "https://signet.test/fhir",
      }),
    });
    const smartForms = await makeSystem(stack.db, organisation.id, {
      name: "Smart Forms",
      serverProfile: null,
      clientProfile: clientProfileFixture({
        launchUrl: "https://smartforms.test/launch",
      }),
    });
    const elsewhere = await makeSystem(stack.db, organisation.id, {
      name: "Enrolled Elsewhere",
      serverProfile: serverProfileFixture({
        fhirBaseUrl: "https://elsewhere.test/r4",
      }),
    });
    const unenrolled = await makeSystem(stack.db, organisation.id, {
      name: "Enrolled Nowhere",
      serverProfile: serverProfileFixture({
        fhirBaseUrl: "https://nowhere.test/r4",
      }),
    });

    for (const system of [medirecords, signet, smartForms]) {
      await makeEnrolment(stack.db, {
        event,
        systemId: system.id,
        accountId: owner.id,
      });
    }
    await makeEnrolment(stack.db, {
      event: other,
      systemId: elsewhere.id,
      accountId: owner.id,
    });

    return {
      event,
      owner,
      medirecords,
      signet,
      smartForms,
      elsewhere,
      unenrolled,
    };
  }

  /** The bundle, fetched with no cookie of any kind. */
  async function anonymousBundle(slug: string): Promise<Bundle> {
    return await apiJson<Bundle>(
      stack,
      "GET",
      `/api/events/${slug}/brands.json`,
    );
  }

  /** Every Organization in a bundle. */
  function organisations(bundle: Bundle): readonly Organization[] {
    return (bundle.entry ?? [])
      .map((entry) => entry.resource)
      .filter(
        (resource): resource is Organization =>
          resource?.resourceType === "Organization",
      );
  }

  /** Every Endpoint in a bundle. */
  function endpoints(bundle: Bundle): readonly Endpoint[] {
    return (bundle.entry ?? [])
      .map((entry) => entry.resource)
      .filter(
        (resource): resource is Endpoint =>
          resource?.resourceType === "Endpoint",
      );
  }

  it("answers an anonymous caller with a collection bundle", async () => {
    const { event } = await scene();

    const response = await apiRequest(
      stack,
      "GET",
      `/api/events/${event.slug}/brands.json`,
    );

    expect(response.status).toBe(200);
    // The media type the format is published under; a bare `application/json` would make an
    // app that content-negotiates work harder than it should.
    expect(response.headers.get("content-type")).toContain(
      "application/fhir+json",
    );
    // Read by a browser-based app from another origin, which is what the publication format
    // requires of a publisher.
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    const bundle = (await response.json()) as Bundle;
    expect(bundle.resourceType).toBe("Bundle");
    expect(bundle.type).toBe("collection");
  });

  it("carries every enrolled server, with its declared FHIR base URL", async () => {
    const { event } = await scene();

    const bundle = await anonymousBundle(event.slug);

    expect(
      organisations(bundle)
        .map((brand) => brand.name)
        .toSorted(),
    ).toEqual(["MediRecords FHIR", "Signet"]);
    expect(
      endpoints(bundle)
        .map((endpoint) => endpoint.address)
        .toSorted(),
    ).toEqual(["https://fhir.medirecords.test/r4", "https://signet.test/fhir"]);
  });

  /**
   * Scenario 3: a system not enrolled in the event appears in neither the API listing nor
   * the brands bundle. Both directions of "not enrolled" are checked - another event's
   * enrolment, and no enrolment at all - because they are different queries going wrong.
   */
  it("omits a server that is not enrolled in this event", async () => {
    const { event } = await scene();

    const serialised = JSON.stringify(await anonymousBundle(event.slug));

    expect(serialised).not.toContain("elsewhere.test");
    expect(serialised).not.toContain("nowhere.test");
    expect(serialised).not.toContain("Enrolled Elsewhere");
    expect(serialised).not.toContain("Enrolled Nowhere");
  });

  /** A client is enrolled and is not a brand: it has no endpoint for an app to discover. */
  it("omits a client-only system that is enrolled", async () => {
    const { event } = await scene();

    const serialised = JSON.stringify(await anonymousBundle(event.slug));

    expect(serialised).not.toContain("Smart Forms");
    expect(serialised).not.toContain("smartforms.test");
  });

  /** The same event scoping, read from the other event's bundle. */
  it("scopes each event's bundle to its own enrolments", async () => {
    const { elsewhere } = await scene();
    const other = await makeEvent(stack.db, { status: "open" });
    const owner = await stack.makeMember();
    const organisation = await makeOrganisation(stack.db, owner.id);
    const only = await makeSystem(stack.db, organisation.id, {
      name: "The Only Brand",
      serverProfile: serverProfileFixture({
        fhirBaseUrl: "https://only.test/r4",
      }),
    });
    await makeEnrolment(stack.db, {
      event: other,
      systemId: only.id,
      accountId: owner.id,
    });

    const bundle = await anonymousBundle(other.slug);

    expect(organisations(bundle).map((brand) => brand.name)).toEqual([
      "The Only Brand",
    ]);
    expect(JSON.stringify(bundle)).not.toContain(elsewhere.name);
  });

  /** No cookie is sent, and no address comes back (constitution principle V). */
  it("carries no contact detail", async () => {
    const { event, owner } = await scene();

    const serialised = JSON.stringify(await anonymousBundle(event.slug));

    expect(serialised).not.toContain(owner.email);
    expect(serialised).not.toContain("@");
  });

  /** Every public URL in the bundle derives from `MUSTER_PUBLIC_URL`. */
  it("builds its own URLs from the configured public URL", async () => {
    const { event } = await scene();

    const bundle = await anonymousBundle(event.slug);

    for (const brand of organisations(bundle)) {
      expect(brand.telecom?.[0]?.value).toStartWith(
        `${TEST_PUBLIC_URL}/events/${event.slug}/systems/`,
      );
    }
    for (const entry of bundle.entry ?? []) {
      expect(entry.fullUrl).toStartWith(
        `${TEST_PUBLIC_URL}/api/events/${event.slug}/`,
      );
    }
  });

  it("refuses an event that does not exist", async () => {
    const response = await apiRequest(
      stack,
      "GET",
      "/api/events/no-such-event/brands.json",
    );

    expect(response.status).toBe(404);
  });

  /**
   * A draft event's bundle is readable, for the same reason its event page is: a draft
   * carries no contact detail and no secret, and hiding it would be the first exception to
   * public by default.
   */
  it("publishes an empty bundle for an event with nothing enrolled", async () => {
    const event = await makeEvent(stack.db);

    const bundle = await anonymousBundle(event.slug);

    expect(bundle.type).toBe("collection");
    expect(bundle.entry ?? []).toEqual([]);
    expect(bundle.meta?.lastUpdated).toBe(event.updatedAt.toISOString());
  });

  /**
   * The published endpoint's FHIR version comes from the latest check, because the server
   * itself is the only authority on the question. A server nobody has checked is published
   * with the R4 assumption the pure suite pins; this case is the other branch, wired to a
   * real check row.
   */
  it("publishes the FHIR version the latest check read", async () => {
    const { event, medirecords } = await scene();
    const listing = await apiJson<{
      readonly systems: readonly {
        readonly systemId: string;
        readonly enrolmentId: string;
      }[];
    }>(stack, "GET", `/api/events/${event.slug}/systems`);
    const enrolmentId = listing.systems.find(
      (system) => system.systemId === medirecords.id,
    )?.enrolmentId;
    expect(enrolmentId).toBeDefined();
    await insertCheckResult(stack.db, {
      enrolmentId: enrolmentId ?? "",
      checkedAt: new Date("2026-09-15T12:00:00.000Z"),
      reachable: true,
      failureMode: null,
      detail: null,
      discovery: null,
      capability: CAPABILITY,
      driftFlags: [],
    });

    const bundle = await anonymousBundle(event.slug);
    const endpoint = endpoints(bundle).find(
      (candidate) => candidate.id === medirecords.id,
    );

    expect(endpoint?.extension).toEqual([
      {
        url: "http://hl7.org/fhir/StructureDefinition/endpoint-fhir-version",
        valueCode: "4.3.0",
      },
    ]);
  });
});
