/*
 * Copyright © 2026 Commonwealth Scientific and Industrial Research Organisation
 * (CSIRO) ABN 41 687 119 230. Licensed under the Apache License, Version 2.0.
 */

import { updateAccountStatus } from "@muster/db";
import { describeDatabase, uniqueName } from "@muster/db/test/harness";
import { afterAll, beforeAll, expect, test } from "bun:test";

import { request, signUpAndSignIn, startTestServer } from "../test/support.ts";

import type { SignedIn, TestServer } from "../test/support.ts";

/**
 * The endpoint scheme rule, at the routes that record an endpoint.
 *
 * Two applications are driven: one configured as a deployment is, with an empty
 * outbound allowlist, and one configured as the compose stack is, naming the
 * stubs. The same request is refused by the first and accepted by the second,
 * which is the whole of the rule: an http endpoint is permitted only where the
 * operator has already said that host is one Muster may reach.
 *
 * The refusal is reported rather than silently dropped, and it names the field,
 * so a member sees what to change (FR-020's spirit, applied to input).
 *
 * @author John Grimes
 */

describeDatabase("the endpoint scheme rule", () => {
  /** As a deployment is configured: nothing is allowlisted. */
  let deployment: TestServer;
  /** As the compose stack is configured: the stubs are named. */
  let stack: TestServer;
  let deploymentMember: SignedIn;
  let stackMember: SignedIn;
  let deploymentAdmin: SignedIn;

  beforeAll(async () => {
    deployment = await startTestServer("endpointsdeny");
    stack = await startTestServer(
      "endpointsallow",
      {},
      {
        MUSTER_OUTBOUND_ALLOWLIST: "register-stub:9090,persona-source-stub",
      },
    );
    deploymentMember = await arrangeMember(deployment);
    stackMember = await arrangeMember(stack);
    deploymentAdmin = await arrangeMember(deployment, true);
  });

  afterAll(async () => {
    await Promise.all([deployment.close(), stack.close()]);
  });

  // Signs an account up, verifies it, approves it, and signs it in.
  async function arrangeMember(
    server: TestServer,
    isAdmin = false,
  ): Promise<SignedIn> {
    const member = await signUpAndSignIn(
      server,
      `${uniqueName(isAdmin ? "admin" : "member")}@example.org`,
    );
    await updateAccountStatus(server.database.sql, {
      accountId: member.id,
      status: "approved",
      decidedBy: member.id,
      decidedAt: new Date(),
    });
    if (isAdmin) {
      await server.database
        .sql`update account set is_admin = true where id = ${member.id}`;
    }
    return member;
  }

  // Creates an organisation and answers its identifier.
  const arrangeOrganisation = async (
    server: TestServer,
    member: SignedIn,
  ): Promise<string> => {
    const response = await request(server, "POST", "/api/organisations", {
      body: { name: uniqueName("org") },
      cookie: member.cookie,
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { organisation: { id: string } };
    return body.organisation.id;
  };

  /** A profile whose registration endpoint is the stack's stub, over http. */
  const stubProfile = {
    fhirBaseUrl: "http://register-stub:9090/fhir",
    authorizationMode: "smart",
    registrationMode: "trustedDcr",
    registrationEndpoint: "http://register-stub:9090/register",
    notes: "",
  };

  // A deployment allowlists nothing, so plaintext is refused with the reason.
  test("refuses an http server profile when nothing is allowlisted", async () => {
    const organisationId = await arrangeOrganisation(
      deployment,
      deploymentMember,
    );

    const response = await request(
      deployment,
      "POST",
      `/api/organisations/${organisationId}/systems`,
      {
        body: { name: "Stub Auth", serverProfile: stubProfile },
        cookie: deploymentMember.cookie,
      },
    );

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: "unprocessable",
      detail: expect.stringContaining("fhirBaseUrl"),
    });
  });

  // The compose stack names the stub, so the same entry is accepted there.
  test("accepts an http server profile whose host is allowlisted", async () => {
    const organisationId = await arrangeOrganisation(stack, stackMember);

    const response = await request(
      stack,
      "POST",
      `/api/organisations/${organisationId}/systems`,
      {
        body: { name: "Stub Auth", serverProfile: stubProfile },
        cookie: stackMember.cookie,
      },
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      system: {
        serverProfile: {
          registrationEndpoint: "http://register-stub:9090/register",
        },
      },
    });
  });

  // An https entry is unaffected: this is a relaxation, not a change of default.
  test("accepts an https server profile with nothing allowlisted", async () => {
    const organisationId = await arrangeOrganisation(
      deployment,
      deploymentMember,
    );

    const response = await request(
      deployment,
      "POST",
      `/api/organisations/${organisationId}/systems`,
      {
        body: {
          name: "MediRecords FHIR",
          serverProfile: {
            ...stubProfile,
            fhirBaseUrl: "https://fhir.example.org",
            registrationEndpoint: "https://auth.example.org/register",
          },
        },
        cookie: deploymentMember.cookie,
      },
    );

    expect(response.status).toBe(201);
  });

  // An edit is a recording too, so the same rule applies to it.
  test("refuses an edit that introduces an http endpoint", async () => {
    const organisationId = await arrangeOrganisation(
      deployment,
      deploymentMember,
    );
    const created = await request(
      deployment,
      "POST",
      `/api/organisations/${organisationId}/systems`,
      {
        body: {
          name: "Editable",
          serverProfile: {
            fhirBaseUrl: "https://fhir.example.org",
            authorizationMode: "smart",
            registrationMode: "manual",
            notes: "",
          },
        },
        cookie: deploymentMember.cookie,
      },
    );
    expect(created.status).toBe(201);
    const { system } = (await created.json()) as { system: { id: string } };

    const response = await request(
      deployment,
      "PATCH",
      `/api/systems/${system.id}`,
      {
        body: {
          serverProfile: {
            fhirBaseUrl: "http://fhir.example.org",
            authorizationMode: "smart",
            registrationMode: "manual",
            notes: "",
          },
        },
        cookie: deploymentMember.cookie,
      },
    );

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      detail: expect.stringContaining("MUSTER_OUTBOUND_ALLOWLIST"),
    });
  });

  // The persona source is fetched by Muster too, so an event carries the rule.
  test("refuses an http persona source on an event when nothing is allowlisted", async () => {
    const response = await request(deployment, "POST", "/api/admin/events", {
      body: {
        slug: uniqueName("event").replaceAll("_", "-"),
        name: "Local stack event",
        startsOn: "2026-09-01",
        endsOn: "2026-09-03",
        personaSourceUrl: "http://persona-source-stub:9092/fhir",
      },
      cookie: deploymentAdmin.cookie,
    });

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      detail: expect.stringContaining("personaSourceUrl"),
    });
  });

  test("accepts an http persona source whose host is allowlisted", async () => {
    const admin = await arrangeMember(stack, true);

    const response = await request(stack, "POST", "/api/admin/events", {
      body: {
        slug: uniqueName("event").replaceAll("_", "-"),
        name: "Local stack event",
        startsOn: "2026-09-01",
        endsOn: "2026-09-03",
        personaSourceUrl: "http://persona-source-stub:9092/fhir",
      },
      cookie: admin.cookie,
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      event: { personaSourceUrl: "http://persona-source-stub:9092/fhir" },
    });
  });
});
