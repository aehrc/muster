/*
 * Copyright © 2026 Commonwealth Scientific and Industrial Research Organisation
 * (CSIRO) ABN 41 687 119 230. Licensed under the Apache License, Version 2.0.
 */

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

import { request, signUpAndSignIn, startTestServer } from "../test/support.ts";

import type { SignedIn, TestServer } from "../test/support.ts";
import type { EventRow } from "@muster/db";
import type { Bundle, Endpoint, Organization } from "fhir/r4";

/**
 * The brands bundle route: the directory read by an app rather than a person.
 *
 * FR-022 asks for one bundle per event, and acceptance scenario 3 asks for the
 * property that makes it trustworthy - a system that is not enrolled in the
 * event is not in the event's bundle. Both are exercised here without an
 * account, because an app configuring endpoint discovery has none.
 *
 * The shape of the bundle is pinned by the pure suite in
 * `packages/core/src/brands/build.test.ts`, against a fixture the HL7 validator
 * has read. What this suite adds is everything the pure builder cannot know: who
 * is in the answer, who is not, and what the response says it is.
 */

describeDatabase("the brands bundle route", () => {
  let server: TestServer;
  let member: SignedIn;
  let organisationId: string;
  let event: EventRow;
  let otherEvent: EventRow;

  beforeAll(async () => {
    server = await startTestServer("brands");
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
    event = await arrangeEvent();
    otherEvent = await arrangeEvent();
  });

  afterAll(async () => {
    await server.close();
  });

  // Arranges an open event to enrol into.
  const arrangeEvent = () =>
    insertEvent(server.database.sql, {
      slug: uniqueName("event").replaceAll("_", "-"),
      name: "Sparked connectathon",
      startsOn: "2026-09-01",
      endsOn: "2026-09-03",
      status: "open",
      capabilityTags: [],
      graceDays: 7,
    });

  // Arranges a system, enrolled in the named event when one is given.
  const arrangeSystem = async (facts: {
    readonly name: string;
    readonly fhirBaseUrl?: string;
    readonly enrolIn?: EventRow;
  }) => {
    const system = await insertSystem(server.database.sql, {
      organisationId,
      name: facts.name,
      description: "An entry.",
      serverProfile:
        facts.fhirBaseUrl === undefined
          ? null
          : {
              fhirBaseUrl: facts.fhirBaseUrl,
              authorizationMode: "smart",
              registrationMode: "manual",
              notes: "",
            },
      clientProfile:
        facts.fhirBaseUrl === undefined
          ? {
              launchUrl: "https://smartforms.example.org/launch",
              redirectUris: ["https://smartforms.example.org/callback"],
              scopes: ["launch/patient"],
              confidentiality: "public",
              launchContext: "patient",
              needsIntrospection: false,
            }
          : null,
    });
    const enrolment =
      facts.enrolIn === undefined
        ? undefined
        : await insertEnrolment(server.database.sql, {
            eventId: facts.enrolIn.id,
            systemId: system.id,
            tags: [],
            confirmedBy: member.id,
          });
    return { systemId: system.id, enrolmentId: enrolment?.id };
  };

  // Fetches one event's bundle, anonymously unless a cookie is given.
  const fetchBundle = async (slug: string, cookie?: string) => {
    const response = await request(
      server,
      "GET",
      `/api/events/${slug}/brands.json`,
      cookie === undefined ? {} : { cookie },
    );
    expect(response.status).toBe(200);
    return { response, bundle: (await response.json()) as Bundle };
  };

  // Reads the resources of one type out of a bundle.
  const resourcesOf = <Resource extends Endpoint | Organization>(
    bundle: Bundle,
    resourceType: Resource["resourceType"],
  ): Resource[] =>
    (bundle.entry ?? [])
      .map((entry) => entry.resource)
      .filter(
        (resource): resource is Resource =>
          resource?.resourceType === resourceType,
      );

  // FR-022, SC-006: an app with no account gets the whole bundle, served as
  // FHIR JSON and readable from a browser page on another origin.
  test("serves an enrolled server's brand and endpoint to an anonymous caller", async () => {
    const enrolled = await arrangeSystem({
      name: "MediRecords FHIR",
      fhirBaseUrl: "https://fhir.medirecords.example.org/r4",
      enrolIn: event,
    });
    await insertCheckResult(server.database.sql, {
      enrolmentId: enrolled.enrolmentId!,
      checkedAt: new Date("2026-08-19T01:00:00.000Z"),
      reachable: true,
      failureMode: null,
      detail: null,
      discovery: null,
      capability: {
        fhirVersion: "4.0.1",
        software: "MediRecords FHIR 3.2.1",
        implementationUrl: "https://fhir.medirecords.example.org/r4",
        securityServices: ["SMART-on-FHIR"],
        resourceTypes: ["Patient"],
      },
      driftFlags: [],
    });

    const { response, bundle } = await fetchBundle(event.slug);

    expect(response.headers.get("content-type")).toContain(
      "application/fhir+json",
    );
    // The brands specification requires CORS on every GET of a published bundle.
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(bundle.resourceType).toBe("Bundle");
    expect(bundle.type).toBe("collection");
    const brands = resourcesOf<Organization>(bundle, "Organization");
    const endpoints = resourcesOf<Endpoint>(bundle, "Endpoint");
    expect(brands).toHaveLength(1);
    expect(brands[0]?.name).toBe("MediRecords");
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0]?.address).toBe(
      "https://fhir.medirecords.example.org/r4",
    );
    // The check has read a version, so the endpoint asserts one and the bundle
    // claims the profile it satisfies.
    expect(endpoints[0]?.extension).toEqual([
      {
        url: "http://hl7.org/fhir/StructureDefinition/endpoint-fhir-version",
        valueCode: "4.0.1",
      },
    ]);
    expect(bundle.meta?.profile).toEqual([
      "http://hl7.org/fhir/smart-app-launch/StructureDefinition/user-access-brands-bundle",
    ]);
    // Every entry names the event it was published for.
    expect(bundle.entry?.[0]?.fullUrl).toBe(
      `${server.config.publicUrl}/api/events/${event.slug}/Organization/${enrolled.systemId}`,
    );
  });

  // Acceptance scenario 3: not enrolled here is not published here, and a
  // client has no endpoint to publish at all.
  test("publishes only the servers enrolled in that event", async () => {
    const elsewhere = await arrangeSystem({
      name: "Elsewhere FHIR",
      fhirBaseUrl: "https://elsewhere.example.org/fhir",
      enrolIn: otherEvent,
    });
    const unenrolled = await arrangeSystem({
      name: "Unenrolled FHIR",
      fhirBaseUrl: "https://unenrolled.example.org/fhir",
    });
    const client = await arrangeSystem({
      name: "Smart Forms",
      enrolIn: event,
    });

    const { bundle } = await fetchBundle(event.slug);
    const serialised = JSON.stringify(bundle);

    expect(serialised).not.toContain("https://elsewhere.example.org/fhir");
    expect(serialised).not.toContain("https://unenrolled.example.org/fhir");
    expect(serialised).not.toContain(elsewhere.systemId);
    expect(serialised).not.toContain(unenrolled.systemId);
    expect(serialised).not.toContain(client.systemId);
    expect(serialised).not.toContain("Smart Forms");
    // The other event publishes the entry that is enrolled in it, and only that.
    const other = await fetchBundle(otherEvent.slug);
    expect(
      resourcesOf<Endpoint>(other.bundle, "Endpoint").map(
        (endpoint) => endpoint.address,
      ),
    ).toEqual(["https://elsewhere.example.org/fhir"]);
  });

  // FR-007: a bundle carries no contact detail, and signing in does not change
  // that - it is not a caller-dependent answer.
  test("carries no contact detail for any caller", async () => {
    await arrangeSystem({
      name: "Contactless FHIR",
      fhirBaseUrl: "https://contactless.example.org/fhir",
      enrolIn: event,
    });

    const anonymous = await fetchBundle(event.slug);
    const signedIn = await fetchBundle(event.slug, member.cookie);

    expect(JSON.stringify(signedIn.bundle)).not.toContain(member.email);
    expect(signedIn.bundle).toEqual(anonymous.bundle);
  });

  test("answers an unknown event with a 404 envelope", async () => {
    const response = await request(
      server,
      "GET",
      "/api/events/no-such-event/brands.json",
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: "not_found" });
  });
});
