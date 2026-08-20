/*
 * Copyright © 2026 Commonwealth Scientific and Industrial Research Organisation
 * (CSIRO) ABN 41 687 119 230. Licensed under the Apache License, Version 2.0.
 */

import { expect, test } from "@playwright/test";

import {
  addSystem,
  approve,
  createOrganisation,
  enrol,
  signIn,
  signOut,
  signUp,
} from "./support/console.ts";
import {
  admin,
  eventSlug,
  participantAddress,
  unique,
} from "./support/stack.ts";

import type { Account } from "./support/console.ts";

/**
 * Quickstart scenario 1: from an empty database to a public event view.
 *
 * Two accounts sign up, are verified from the link Muster logged, and are
 * approved by the seeded track admin. Each describes an organisation and a
 * system, and enrols it into the open event. The event view then lists both, and
 * the contact details are the difference between a signed-in member and anybody
 * else (FR-007).
 *
 * @author John Grimes
 */

/** The systems this file creates, named uniquely so a re-run does not collide. */
const serverName = `MediRecords FHIR ${unique("server")}`;

/** The client system this file creates. */
const clientName = `Smart Forms ${unique("client")}`;

/** The two accounts, arranged once for the whole file. */
let serverOwner: Account;
let appOwner: Account;

// One address for this file, so its sign-ins do not exhaust another's allowance.
test.use({ extraHTTPHeaders: { "x-forwarded-for": participantAddress() } });

// Each test builds on the last, which is what a walk through the scenario is.
test.describe.configure({ mode: "serial" });

test("signs up two accounts and has the admin approve both", async ({
  page,
}) => {
  serverOwner = await signUp(page, "serverowner");
  appOwner = await signUp(page, "appowner");

  await signIn(page, admin.email, admin.password);
  await approve(page, serverOwner);
  await approve(page, appOwner);
});

test("describes a server, a client, and enrols both", async ({ page }) => {
  await signIn(page, serverOwner.email);
  await createOrganisation(page, `MediRecords ${unique("org")}`);
  await addSystem(page, {
    name: serverName,
    server: {
      fhirBaseUrl: "https://fhir.medirecords.example.org",
      authorizationMode: "SMART on FHIR",
      registrationMode: "Manual, by the server's owner",
    },
  });
  await enrol(page, serverName, ["data holder"]);

  await signIn(page, appOwner.email);
  await createOrganisation(page, `CSIRO ${unique("org")}`);
  await addSystem(page, {
    name: clientName,
    client: {
      launchUrl: "https://smartforms.example.org/launch",
      redirectUris: "https://smartforms.example.org/callback",
      scopes: "launch/patient patient/Observation.rs",
    },
  });
  await enrol(page, clientName, ["form filler"]);
});

test("lists both systems on the public event view", async ({ page }) => {
  // Signed out, which is how most readers arrive.
  await signOut(page);
  await page.goto(`/events/${eventSlug}`);

  await expect(page.getByText(serverName)).toBeVisible();
  await expect(page.getByText(clientName)).toBeVisible();
});

test("shows contact details to a member and to nobody else", async ({
  page,
  request,
}) => {
  // The JSON API is the same answer the page renders, and the easier one to
  // assert the absence of a field in (FR-007).
  const anonymous = await request.get(`/api/events/${eventSlug}/systems`);
  expect(anonymous.ok()).toBe(true);
  const body = (await anonymous.json()) as {
    systems: { system: { name: string }; contacts?: unknown }[];
  };
  const entries = body.systems.filter((entry) =>
    [serverName, clientName].includes(entry.system.name),
  );
  expect(entries).toHaveLength(2);
  for (const entry of entries) {
    expect(entry.contacts).toBeUndefined();
  }

  // Signed in, the same entry carries the contact of the member who owns it.
  await signIn(page, serverOwner.email);
  await page.goto(`/events/${eventSlug}`);
  const entry = page.locator("article").filter({ hasText: serverName });
  await expect(
    entry.getByRole("link", { name: serverOwner.email }),
  ).toBeVisible();
});
