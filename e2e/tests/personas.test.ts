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
  panel,
  signIn,
  signOut,
  signUp,
} from "./support/console.ts";
import {
  admin,
  charlotte,
  dataHolderUrl,
  eventSlug,
  jordan,
  participantAddress,
  personaSourceUrl,
  unique,
} from "./support/stack.ts";

import type { Account } from "./support/console.ts";

/**
 * Quickstart scenario 6: the shared persona set and the coverage grid.
 *
 * The admin searches the event's source, is offered the patient who carries an
 * IHI and told why the other one cannot be added (FR-031), and adds Charlotte
 * Morris. Two servers are then enrolled: the source itself, which holds her, and
 * the data holder, which will not answer a search without authorization. The grid
 * reports `found` for the first and `unverifiable` for the second - never
 * `missing`, because a server that refused to answer has said nothing about what
 * it holds (FR-032) - and it is readable with no account at all (SC-006).
 *
 * @author John Grimes
 */

/** The enrolled server that holds the persona: the source itself. */
const holdingName = `Persona Source ${unique("server")}`;

/** The enrolled server that will not answer a search: the data holder. */
const guardedName = `Authorised Holder ${unique("server")}`;

/**
 * How long the assertions wait for the scheduler's coverage pass.
 *
 * Coverage is one probe per persona and enrolled server, run after the liveness
 * checks in the same pass, so the wait is the same shape as in `checks.test.ts`:
 * ample for a freshly seeded stack, and tolerant of one carrying entries from
 * earlier runs.
 */
const schedulerTimeout = 240_000;

let serverOwner: Account;

test.use({ extraHTTPHeaders: { "x-forwarded-for": participantAddress() } });
test.describe.configure({ mode: "serial", timeout: schedulerTimeout + 30_000 });

test("curates a persona, and is told why the other patient cannot join", async ({
  page,
}) => {
  await signIn(page, admin.email, admin.password);
  await page.goto("/admin/events");
  const event = page
    .getByRole("listitem")
    .filter({ hasText: eventSlug })
    .first();
  await event.getByRole("button", { name: "Personas" }).click();

  // The source the seed put on the event, named on screen.
  await expect(page.getByText(personaSourceUrl)).toBeVisible();

  await page.getByLabel("Search the source").fill("Morris");
  await page.getByRole("button", { name: "Search" }).click();

  const candidate = page
    .getByRole("list", { name: "Search results" })
    .getByRole("listitem")
    .filter({ hasText: charlotte.name });
  await expect(candidate.getByText(charlotte.ihi)).toBeVisible();
  await candidate.getByRole("button", { name: "Add" }).click();

  // The set persists between runs of this suite, and the IHI is what a persona
  // is, so a second run is a duplicate rather than a second row. Either answer is
  // the rule working; both name the IHI.
  await expect(
    page.getByText(
      new RegExp(
        `(joined the set with IHI|already has a persona with IHI) ${charlotte.ihi}`,
      ),
    ),
  ).toBeVisible();
  await expect(
    page
      .getByRole("list", { name: "Curated personas" })
      .getByRole("listitem")
      .filter({ hasText: charlotte.ihi }),
  ).toBeVisible();

  // The patient with no IHI is reported with the reason, not dropped.
  await page.getByLabel("Search the source").fill("Vale");
  await page.getByRole("button", { name: "Search" }).click();
  const refused = page.getByRole("list", {
    name: "Found, and cannot be added",
  });
  await expect(
    refused.getByText(new RegExp(`Patient/${jordan.patientId} carries no`)),
  ).toBeVisible();
});

test("enrols a server that holds her and one that will not say", async ({
  page,
}) => {
  serverOwner = await signUp(page, "serverowner");
  await signIn(page, admin.email, admin.password);
  await approve(page, serverOwner);

  await signIn(page, serverOwner.email);
  await createOrganisation(page, `Source Vendor ${unique("org")}`);
  await addSystem(page, {
    name: holdingName,
    server: {
      fhirBaseUrl: personaSourceUrl,
      authorizationMode: "Open (no authorization)",
    },
  });
  await enrol(page, holdingName);

  await addSystem(page, {
    name: guardedName,
    server: { fhirBaseUrl: `${dataHolderUrl}/fhir` },
  });
  await enrol(page, guardedName);
});

test("reports found for the server that holds her", async ({ request }) => {
  const coverageFor = async (name: string): Promise<string | undefined> => {
    const response = await request.get(`/api/events/${eventSlug}/personas`);
    // Inside a poll, so an answer that is not the grid is another attempt rather
    // than a verdict.
    if (!response.ok()) {
      return undefined;
    }
    const body = (await response.json()) as {
      servers?: { enrolmentId: string; system: { name: string } }[];
      coverage?: { enrolmentId: string; outcome: string }[];
    };
    const server = (body.servers ?? []).find(
      (held) => held.system.name === name,
    );
    return (body.coverage ?? []).find(
      (cell) => cell.enrolmentId === server?.enrolmentId,
    )?.outcome;
  };

  await expect
    .poll(() => coverageFor(holdingName), {
      timeout: schedulerTimeout,
      message: "coverage had not been evaluated for the holding server",
    })
    .toBe("found");

  // The server that will not answer without authorization says nothing about
  // what it holds, so the cell is unverifiable rather than missing.
  await expect
    .poll(() => coverageFor(guardedName), {
      timeout: schedulerTimeout,
      message: "coverage had not been evaluated for the guarded server",
    })
    .toBe("unverifiable");
});

test("publishes the grid to a reader with no account", async ({ page }) => {
  await signOut(page);
  await page.goto(`/events/${eventSlug}/personas`);

  await expect(page.getByText(charlotte.ihi).first()).toBeVisible();
  const coverage = panel(page, "Coverage");
  await expect(coverage).toBeVisible();
  const row = coverage.getByRole("row").filter({ hasText: charlotte.name });
  await expect(row.getByText("Found").first()).toBeVisible();
  await expect(row.getByText("Unverifiable").first()).toBeVisible();
});
