import { eventSystemSchema, eventSystemsSchema } from "@muster/contracts";
import {
  insertCheckResult,
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
import type { NewCheckResult } from "@muster/db";

/**
 * How checks reach a reader: the event listing and the system detail.
 *
 * FR-017 asks for the results on both surfaces and SC-006 asks for them without
 * an account, so both are exercised anonymously here. The listing carries the
 * latest check because that is what a badge is drawn from; the detail carries the
 * history as well, because "when did this last work" is the question a stale
 * entry raises (acceptance scenario 2).
 *
 * A check response carries no contact detail, and the assertion for that is made
 * against the bytes rather than the parsed shape: a field that is not in the
 * contract could still be in the body.
 */

describeDatabase("the public read API's check surfaces", () => {
  let server: TestServer;
  let member: SignedIn;
  let organisationId: string;
  let eventSlug: string;
  let eventId: string;

  beforeAll(async () => {
    server = await startTestServer("publicchecks");
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
    const event = await insertEvent(server.database.sql, {
      slug: uniqueName("event").replaceAll("_", "-"),
      name: "Sparked connectathon",
      startsOn: "2026-09-01",
      endsOn: "2026-09-03",
      status: "open",
      capabilityTags: [],
      graceDays: 7,
    });
    eventSlug = event.slug;
    eventId = event.id;
  });

  afterAll(async () => {
    await server.close();
  });

  /** A server entry, as an owner declares it. */
  const serverProfile = {
    fhirBaseUrl: "https://fhir.example.org",
    authorizationMode: "smart",
    registrationMode: "manual",
    tokenEndpoint: "https://auth.example.org/token",
    notes: "",
  };

  /** A client entry, as an owner declares it. */
  const clientProfile = {
    launchUrl: "https://smartforms.example.org/launch",
    redirectUris: ["https://smartforms.example.org/callback"],
    scopes: ["launch", "patient/Patient.rs"],
    confidentiality: "public",
    launchContext: "patient",
    needsIntrospection: false,
  };

  /** An enrolled system: the identifiers a test needs to address it. */
  type Enrolled = {
    /** the system */
    readonly systemId: string;
    /** its enrolment in the suite's event */
    readonly enrolmentId: string;
  };

  // Arranges an enrolled system of either kind.
  const arrangeEnrolled = async (
    name: string,
    kind: "server" | "client",
  ): Promise<Enrolled> => {
    const system = await insertSystem(server.database.sql, {
      organisationId,
      name,
      description: "An entry.",
      serverProfile: kind === "server" ? serverProfile : null,
      clientProfile: kind === "client" ? clientProfile : null,
    });
    const enrolment = await insertEnrolment(server.database.sql, {
      eventId,
      systemId: system.id,
      tags: [],
      confirmedBy: member.id,
    });
    return { systemId: system.id, enrolmentId: enrolment.id };
  };

  // A reachable check, as the scheduler would record it.
  const reachable = (
    enrolmentId: string,
    checkedAt: string,
  ): NewCheckResult => ({
    enrolmentId,
    checkedAt: new Date(checkedAt),
    reachable: true,
    failureMode: null,
    detail: null,
    discovery: {
      issuer: "https://auth.example.org",
      authorizationEndpoint: "https://auth.example.org/authorize",
      tokenEndpoint: "https://auth.example.org/token",
      registrationEndpoint: null,
      scopesSupported: ["launch", "patient/Patient.rs"],
      capabilities: ["launch-standalone"],
    },
    capability: {
      fhirVersion: "4.0.1",
      software: "Example FHIR 3.2.1",
      implementationUrl: "https://fhir.example.org",
      securityServices: ["SMART-on-FHIR"],
      resourceTypes: ["Patient"],
    },
    driftFlags: [],
  });

  // Reads the event listing as an anonymous caller, and finds one system in it.
  const listedSystem = async (systemId: string) => {
    const response = await request(
      server,
      "GET",
      `/api/events/${eventSlug}/systems`,
    );
    expect(response.status).toBe(200);
    const body = await readJson(response, eventSystemsSchema);
    return body.systems.find((entry) => entry.system.id === systemId);
  };

  // FR-017: the check time, the highlights and a reachable status, on the event
  // view's own data, to a caller with no account at all.
  test("carries the latest check of each enrolled server to an anonymous reader", async () => {
    const enrolled = await arrangeEnrolled("Reachable Server", "server");
    await insertCheckResult(
      server.database.sql,
      reachable(enrolled.enrolmentId, "2026-08-19T01:00:00.000Z"),
    );

    const entry = await listedSystem(enrolled.systemId);

    expect(entry?.check?.latest).toMatchObject({
      checkedAt: "2026-08-19T01:00:00.000Z",
      reachable: true,
      failureMode: null,
      discovery: { tokenEndpoint: "https://auth.example.org/token" },
      capability: { fhirVersion: "4.0.1" },
    });
    expect(entry?.check?.lastSuccessAt).toBe("2026-08-19T01:00:00.000Z");
  });

  // Acceptance scenario 2: the failure is the badge, and the last successful
  // check is still there to say when the entry last worked.
  test("carries the last successful check beside a later failure", async () => {
    const enrolled = await arrangeEnrolled("Faltering Server", "server");
    await insertCheckResult(
      server.database.sql,
      reachable(enrolled.enrolmentId, "2026-08-19T01:00:00.000Z"),
    );
    await insertCheckResult(server.database.sql, {
      enrolmentId: enrolled.enrolmentId,
      checkedAt: new Date("2026-08-19T01:15:00.000Z"),
      reachable: false,
      failureMode: "timeout",
      detail: "fhir.example.org did not answer within 10000ms",
      discovery: null,
      capability: null,
      driftFlags: [],
    });

    const entry = await listedSystem(enrolled.systemId);

    expect(entry?.check?.latest.reachable).toBe(false);
    expect(entry?.check?.latest.failureMode).toBe("timeout");
    expect(entry?.check?.lastSuccessAt).toBe("2026-08-19T01:00:00.000Z");
  });

  // FR-020, as a reader sees it: a guarded target is a refusal with its reason
  // on the entry, not an entry that looks unverified.
  test("carries a guarded refusal with the reason it names", async () => {
    const enrolled = await arrangeEnrolled("Internal Server", "server");
    await insertCheckResult(server.database.sql, {
      enrolmentId: enrolled.enrolmentId,
      checkedAt: new Date("2026-08-19T01:00:00.000Z"),
      reachable: false,
      failureMode: "guarded",
      detail:
        "fhir.internal.example.org resolves to 10.1.2.3, which is a private address",
      discovery: null,
      capability: null,
      driftFlags: [],
    });

    const entry = await listedSystem(enrolled.systemId);

    expect(entry?.check?.latest.failureMode).toBe("guarded");
    expect(entry?.check?.latest.detail).toContain("private address");
    expect(entry?.check?.lastSuccessAt).toBeNull();
  });

  // Nothing to say is said as nothing: a client has no address to check, and an
  // unchecked server has no result yet. Neither may look like a pass.
  test("carries no check for a client entry or an unchecked server", async () => {
    const client = await arrangeEnrolled("Smart Forms", "client");
    const unchecked = await arrangeEnrolled("Unchecked Server", "server");

    expect((await listedSystem(client.systemId))?.check).toBeNull();
    expect((await listedSystem(unchecked.systemId))?.check).toBeNull();
  });

  // Acceptance scenario 3, on the surface a reader lands on from the badge: the
  // drift is named on the detail, with both values, alongside the history.
  test("carries the drift flags and the history on the system detail", async () => {
    const enrolled = await arrangeEnrolled("Drifted Server", "server");
    await insertCheckResult(
      server.database.sql,
      reachable(enrolled.enrolmentId, "2026-08-19T01:00:00.000Z"),
    );
    await insertCheckResult(server.database.sql, {
      ...reachable(enrolled.enrolmentId, "2026-08-19T01:15:00.000Z"),
      driftFlags: [
        {
          field: "tokenEndpoint",
          declared: "https://auth.example.org/token",
          advertised: "https://auth.example.org/v2/token",
        },
      ],
    });

    const response = await request(
      server,
      "GET",
      `/api/events/${eventSlug}/systems/${enrolled.systemId}`,
    );

    expect(response.status).toBe(200);
    const body = await readJson(response, eventSystemSchema);
    expect(body.system.check?.latest.driftFlags).toEqual([
      {
        field: "tokenEndpoint",
        declared: "https://auth.example.org/token",
        advertised: "https://auth.example.org/v2/token",
      },
    ]);
    // Newest first, and the older check is still there to be read.
    expect(body.system.checkHistory?.map((check) => check.checkedAt)).toEqual([
      "2026-08-19T01:15:00.000Z",
      "2026-08-19T01:00:00.000Z",
    ]);
  });

  // The listing carries the latest check and not a history: a page of results per
  // entry would be a different route's job.
  test("carries no history on the event listing", async () => {
    const enrolled = await arrangeEnrolled("Listed Server", "server");
    await insertCheckResult(
      server.database.sql,
      reachable(enrolled.enrolmentId, "2026-08-19T01:00:00.000Z"),
    );

    expect(
      (await listedSystem(enrolled.systemId))?.checkHistory,
    ).toBeUndefined();
  });

  // SC-006: checks are readable without an account and carry no contact detail.
  // Asserted against the bytes, because the parsed shape would drop a stray one.
  test("carries no contact detail in a check-bearing response", async () => {
    const enrolled = await arrangeEnrolled("Public Server", "server");
    await insertCheckResult(
      server.database.sql,
      reachable(enrolled.enrolmentId, "2026-08-19T01:00:00.000Z"),
    );

    const listing = await request(
      server,
      "GET",
      `/api/events/${eventSlug}/systems`,
    );
    const detail = await request(
      server,
      "GET",
      `/api/events/${eventSlug}/systems/${enrolled.systemId}`,
    );

    expect(await listing.text()).not.toContain(member.email);
    expect(await detail.text()).not.toContain(member.email);
  });
});
