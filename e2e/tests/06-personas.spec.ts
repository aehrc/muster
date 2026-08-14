/**
 * Quickstart scenario 6: shared personas and the coverage grid.
 *
 * The event's persona source in this stack is the stub data holder, which is a FHIR server
 * holding two patients: one carrying an IHI and one not. The second exists for the half of
 * this scenario that matters most - a patient without an IHI is refused, *and told why*,
 * rather than quietly vanishing from the search results.
 *
 * The grid's three values are the point of the coverage pass. A server that holds the patient
 * says so; a server that will not answer a patient search without a token has said nothing,
 * and recording that as an absence would send a vendor looking for data they had already
 * loaded. Both are asserted, against the two servers that produce them.
 *
 * Author: John Grimes
 */

import { expect, test } from "@playwright/test";

import { awaitCoverage } from "../support/checks.js";
import { anonymousPage, pageAs } from "../support/journeys.js";
import {
  EVENT,
  MEDIRECORDS,
  PERSONA,
  SESSIONS,
  STUB_AUTH,
  URLS,
} from "../support/stack.js";

test("Scenario 6: curating personas and reading the coverage grid", async ({
  browser,
  request,
}) => {
  await test.step("the registration stub, which scenario 5 stopped, is listening again", async () => {
    // Its coverage answer is the subject of a step below, and "could not be reached" is a
    // different answer from "will not say without a token" even though both are
    // unverifiable.
    await expect
      .poll(
        async () =>
          (await request.get(`${URLS.registrationStub}/healthz`)).status(),
        { timeout: 60_000 },
      )
      .toBe(200);
  });

  const admin = await pageAs(browser, SESSIONS.admin);
  await admin.goto("/admin/events");
  const search = admin.getByLabel("Search the source server");

  await test.step("a patient with no IHI is refused, and the reason is stated", async () => {
    await search.fill(PERSONA.ineligibleName);
    await admin.getByRole("button", { name: "Search", exact: true }).click();
    await expect(
      admin.getByText(
        `${PERSONA.ineligibleName} carries no identifier in ${PERSONA.ihiSystem}`,
      ),
    ).toBeVisible();
    // Refused rather than offered: there is nothing to press.
    await expect(
      admin.getByRole("button", { name: "Add persona" }),
    ).toHaveCount(0);
  });

  await test.step("the persona carrying an IHI is curated", async () => {
    await search.fill(PERSONA.name);
    await admin.getByRole("button", { name: "Search", exact: true }).click();
    await expect(admin.getByText(`IHI ${PERSONA.ihi}`)).toBeVisible();
    await admin.getByRole("button", { name: "Add persona" }).click();
    await expect(
      admin.getByText(`${PERSONA.name} added as a persona.`),
    ).toBeVisible();
  });

  await test.step("a server holding the patient reports found", async () => {
    const cell = await awaitCoverage(
      request,
      MEDIRECORDS.name,
      (latest) => latest?.outcome === "found",
    );
    expect(cell.detail).toBeNull();
  });

  await test.step("a server that will not answer without a token reports unverifiable", async () => {
    const cell = await awaitCoverage(
      request,
      STUB_AUTH.name,
      // The distinction FR-032 exists for: a server that will not answer has said nothing,
      // which is not the same as a server that could not be reached.
      (latest) =>
        latest?.detail?.includes(
          "requires authorization for patient searches",
        ) === true,
    );
    expect(cell.outcome).toBe("unverifiable");
  });

  await test.step("the grid is readable without an account", async () => {
    const visitor = await anonymousPage(browser);
    await visitor.goto(`/personas?event=${EVENT.slug}`);
    await expect(
      visitor.getByRole("heading", { level: 2, name: PERSONA.name }),
    ).toBeVisible();
    await expect(visitor.getByText(PERSONA.ihi).first()).toBeVisible();

    const grid = visitor.locator("section.panel").filter({
      has: visitor.getByRole("heading", { level: 2, name: "Coverage" }),
    });
    await expect(grid.locator("td.coverage-ok")).not.toHaveCount(0);
    await expect(grid.locator("td.coverage-unknown")).not.toHaveCount(0);
    await expect(grid).toContainText("✓ found");
    await expect(grid).toContainText("? unverifiable");
    await visitor.context().close();
  });

  await admin.context().close();
});
