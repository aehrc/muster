/**
 * Verification status on the public read surfaces.
 *
 * A check result is a public read (constitution principle V): the event view's status
 * column and the system page's verification panel are the whole point of User Story 3, and
 * both are readable without an account. So the assertions here are about what an anonymous
 * caller receives - the badge, the time, the drift flags, the advertised document - and
 * about what they do not, which is any contact detail.
 *
 * Three properties beyond "the field is present" are asserted, because each is a
 * requirement rather than a rendering choice.
 *
 * `lastSuccessAt` beside a failing latest check, which is scenario 2's "showing the time of
 * the last successful check" - the one thing that separates a server that has been down for
 * ten minutes from one that never worked.
 *
 * The absence of a check rather than a manufactured one. A server nobody has looked at
 * reports `null`, because "unreachable" would be a claim.
 *
 * The documents on the detail route and not on the listing. Twenty servers' advertised
 * scopes and resource types would multiply the listing's size for a page that shows a badge.
 *
 * Author: John Grimes
 */

import {
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
import { createTestStack } from "../test/harness.js";

import type { TestStack } from "../test/harness.js";
import type {
  CapabilityHighlights,
  DiscoveryHighlights,
  EnrolledSystem,
  EnrolledSystemDetail,
  EventDetail,
} from "@muster/contracts";
import type { AccountRow, EnrolmentRow, EventRow, SystemRow } from "@muster/db";

/** What a fixture check found. */
const DISCOVERY: DiscoveryHighlights = {
  issuer: "https://fhir.muster.test",
  authorizationEndpoint: "https://fhir.muster.test/auth/authorize",
  tokenEndpoint: "https://fhir.muster.test/auth/token",
  registrationEndpoint: null,
  introspectionEndpoint: null,
  jwksUri: null,
  scopesSupported: ["launch", "openid", "fhirUser", "patient/*.rs"],
  capabilities: ["launch-standalone", "permission-v2"],
  grantTypesSupported: ["authorization_code"],
  permissionTicketTypesSupported: ["patient-self-access"],
};

/** What the same check read off the CapabilityStatement. */
const CAPABILITY: CapabilityHighlights = {
  fhirVersion: "4.0.1",
  softwareName: "Fixture FHIR",
  softwareVersion: "1.0.0",
  implementationUrl: "https://fhir.muster.test/r4",
  resourceTypes: ["Patient", "QuestionnaireResponse"],
  smartAuthorizationEndpoint: "https://fhir.muster.test/auth/authorize",
  smartTokenEndpoint: "https://fhir.muster.test/auth/token",
  smartRegisterEndpoint: null,
};

describe.skipIf(!hasTestDatabase())("check status on the public API", () => {
  let stack: TestStack;

  beforeAll(async () => {
    stack = await createTestStack();
  });

  afterAll(async () => {
    await stack.close();
  });

  /** An open event with one enrolled server, owned by a member with an address. */
  async function scene(): Promise<{
    readonly event: EventRow;
    readonly owner: AccountRow;
    readonly system: SystemRow;
    readonly enrolment: EnrolmentRow;
  }> {
    const owner = await stack.makeMember({ displayName: "Sam Patel" });
    const organisation = await makeOrganisation(
      stack.db,
      owner.id,
      `MediRecords ${uniqueSuffix()}`,
    );
    const event = await makeEvent(stack.db, { status: "open" });
    const system = await makeSystem(stack.db, organisation.id, {
      name: "MediRecords FHIR",
      serverProfile: serverProfileFixture({
        tokenEndpoint: "https://fhir.muster.test/oauth/token",
      }),
    });
    const enrolment = await makeEnrolment(stack.db, {
      event,
      systemId: system.id,
      accountId: owner.id,
    });
    return { event, owner, system, enrolment };
  }

  /** The event's systems, as an anonymous caller sees them. */
  async function listing(slug: string) {
    return await apiJson<{
      readonly event: EventDetail;
      readonly systems: readonly EnrolledSystem[];
    }>(stack, "GET", `/api/events/${slug}/systems`);
  }

  /** One system, as an anonymous caller sees it. */
  async function detail(slug: string, systemId: string) {
    return await apiJson<{
      readonly event: EventDetail;
      readonly system: EnrolledSystemDetail;
    }>(stack, "GET", `/api/events/${slug}/systems/${systemId}`);
  }

  it("reports a reachable server's latest check to an anonymous caller", async () => {
    const { event, system, enrolment } = await scene();
    await insertCheckResult(stack.db, {
      enrolmentId: enrolment.id,
      checkedAt: new Date("2026-09-15T12:04:00.000Z"),
      reachable: true,
      failureMode: null,
      detail: null,
      discovery: DISCOVERY,
      capability: CAPABILITY,
      driftFlags: [],
    });

    const { systems } = await listing(event.slug);
    const entry = systems.find((row) => row.systemId === system.id);

    expect(entry?.check).toEqual({
      checkedAt: "2026-09-15T12:04:00.000Z",
      reachable: true,
      failureMode: null,
      detail: null,
      driftFlags: [],
      lastSuccessAt: "2026-09-15T12:04:00.000Z",
    });
  });

  it("reports the drift flags with both values (FR-018)", async () => {
    const { event, system, enrolment } = await scene();
    await insertCheckResult(stack.db, {
      enrolmentId: enrolment.id,
      checkedAt: new Date("2026-09-15T12:04:00.000Z"),
      reachable: true,
      failureMode: null,
      detail: null,
      discovery: DISCOVERY,
      capability: CAPABILITY,
      driftFlags: [
        {
          field: "tokenEndpoint",
          declared: "https://fhir.muster.test/oauth/token",
          advertised: "https://fhir.muster.test/auth/token",
        },
      ],
    });

    const { systems } = await listing(event.slug);
    const entry = systems.find((row) => row.systemId === system.id);

    expect(entry?.check?.driftFlags).toEqual([
      {
        field: "tokenEndpoint",
        declared: "https://fhir.muster.test/oauth/token",
        advertised: "https://fhir.muster.test/auth/token",
      },
    ]);
  });

  it("reports an unreachable server with the last successful check (scenario 2)", async () => {
    const { event, system, enrolment } = await scene();
    await insertCheckResult(stack.db, {
      enrolmentId: enrolment.id,
      checkedAt: new Date("2026-09-15T09:31:00.000Z"),
      reachable: true,
      failureMode: null,
      detail: null,
      discovery: DISCOVERY,
      capability: CAPABILITY,
      driftFlags: [],
    });
    await insertCheckResult(stack.db, {
      enrolmentId: enrolment.id,
      checkedAt: new Date("2026-09-15T09:46:00.000Z"),
      reachable: false,
      failureMode: "refused",
      detail: "https://fhir.muster.test/r4 could not be reached",
      discovery: null,
      capability: null,
      driftFlags: [],
    });

    const { systems } = await listing(event.slug);
    const entry = systems.find((row) => row.systemId === system.id);

    expect(entry?.check?.reachable).toBe(false);
    expect(entry?.check?.failureMode).toBe("refused");
    expect(entry?.check?.checkedAt).toBe("2026-09-15T09:46:00.000Z");
    // The time the event view shows beside "Unreachable since".
    expect(entry?.check?.lastSuccessAt).toBe("2026-09-15T09:31:00.000Z");
  });

  it("names the guard's refusal rather than blaming the server (scenario 5)", async () => {
    const { event, system, enrolment } = await scene();
    await insertCheckResult(stack.db, {
      enrolmentId: enrolment.id,
      checkedAt: new Date("2026-09-15T12:04:00.000Z"),
      reachable: false,
      failureMode: "guarded",
      detail: "10.4.1.9 is not a publicly routable address",
      discovery: null,
      capability: null,
      driftFlags: [],
    });

    const { systems } = await listing(event.slug);
    const entry = systems.find((row) => row.systemId === system.id);

    expect(entry?.check?.failureMode).toBe("guarded");
    expect(entry?.check?.detail).toContain("publicly routable");
    expect(entry?.check?.lastSuccessAt).toBeNull();
  });

  it("reports no check at all for a server nobody has looked at", async () => {
    // Absence rather than a manufactured failure: "unreachable" for a server nobody has
    // checked would be a claim rather than an absence.
    const { event, system } = await scene();

    const { systems } = await listing(event.slug);

    expect(systems.find((row) => row.systemId === system.id)?.check).toBeNull();
  });

  it("carries the advertised documents on the system page, not the listing", async () => {
    const { event, system, enrolment } = await scene();
    await insertCheckResult(stack.db, {
      enrolmentId: enrolment.id,
      checkedAt: new Date("2026-09-15T12:04:00.000Z"),
      reachable: true,
      failureMode: null,
      detail: null,
      discovery: DISCOVERY,
      capability: CAPABILITY,
      driftFlags: [],
    });

    const listed = await listing(event.slug);
    const one = await detail(event.slug, system.id);

    expect(
      listed.systems.find((row) => row.systemId === system.id)?.check,
    ).not.toHaveProperty("discovery");
    expect(one.system.check?.discovery?.scopesSupported).toEqual([
      "launch",
      "openid",
      "fhirUser",
      "patient/*.rs",
    ]);
    expect(one.system.check?.capability?.softwareName).toBe("Fixture FHIR");
    expect(one.system.check?.discovery?.permissionTicketTypesSupported).toEqual(
      ["patient-self-access"],
    );
  });

  it("carries the check history on the system page", async () => {
    // The wireframe's verification panel shows the last check; the history is what lets a
    // reader tell a server that flaps from one that has been down since Tuesday.
    const { event, system, enrolment } = await scene();
    for (const at of [
      "2026-09-15T09:31:00.000Z",
      "2026-09-15T09:46:00.000Z",
      "2026-09-15T10:01:00.000Z",
    ]) {
      await insertCheckResult(stack.db, {
        enrolmentId: enrolment.id,
        checkedAt: new Date(at),
        reachable: at === "2026-09-15T09:31:00.000Z",
        failureMode: at === "2026-09-15T09:31:00.000Z" ? null : "timeout",
        detail: null,
        discovery: null,
        capability: null,
        driftFlags: [],
      });
    }

    const one = await detail(event.slug, system.id);

    expect(one.system.checkHistory.map((row) => row.checkedAt)).toEqual([
      "2026-09-15T10:01:00.000Z",
      "2026-09-15T09:46:00.000Z",
      "2026-09-15T09:31:00.000Z",
    ]);
  });

  it("reports an empty history for a system nobody has checked", async () => {
    const { event, system } = await scene();

    const one = await detail(event.slug, system.id);

    expect(one.system.check).toBeNull();
    expect(one.system.checkHistory).toEqual([]);
  });

  it("leaks no contact detail with the check (principle V)", async () => {
    // Asserted on the raw text rather than on parsed fields: a field nobody thought to
    // check is exactly how an address leaks, and the search finds it wherever it is.
    const { event, owner, system, enrolment } = await scene();
    await insertCheckResult(stack.db, {
      enrolmentId: enrolment.id,
      checkedAt: new Date("2026-09-15T12:04:00.000Z"),
      reachable: true,
      failureMode: null,
      detail: null,
      discovery: DISCOVERY,
      capability: CAPABILITY,
      driftFlags: [],
    });

    for (const path of [
      `/api/events/${event.slug}/systems`,
      `/api/events/${event.slug}/systems/${system.id}`,
    ]) {
      const response = await apiRequest(stack, "GET", path);
      const text = await response.text();
      expect(response.status).toBe(200);
      expect(text).not.toContain(owner.email);
    }
  });
});
