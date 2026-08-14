/**
 * Quickstart scenario 2: a manual pairing round trip.
 *
 * Two organisations, two browser contexts, one record. The point of the story is that both
 * sides read the same history and neither has a private view of it, so the timeline is
 * compared between the two sessions rather than merely asserted in one.
 *
 * The notification is read from Muster's log, because the stack has no relay: the console
 * transport writes the message that would have been sent, and "the server owner sees the
 * notification" is a claim about a message rather than about a page.
 *
 * Author: John Grimes
 */

import { expect, test } from "@playwright/test";

import { openSystemPage, pageAs } from "../support/journeys.js";
import { awaitMessageTo } from "../support/mail.js";
import {
  APP_OWNER,
  EVENT,
  MANUAL_CLIENT_ID,
  MEDIRECORDS,
  SERVER_OWNER,
  SESSIONS,
  SMART_FORMS,
} from "../support/stack.js";

import type { Page } from "@playwright/test";

/** The timeline as one of the parties reads it. */
async function timelineText(page: Page): Promise<string> {
  return await page
    .locator("section.panel")
    .filter({ has: page.getByRole("heading", { level: 2, name: "Timeline" }) })
    .locator("ul.plain-list")
    .innerText();
}

/** Fills the request form from the chosen client's own entry, and sends it. */
async function requestPairing(page: Page): Promise<void> {
  await page
    .getByLabel("Your client")
    .selectOption({ label: SMART_FORMS.name });
  await page.getByRole("button", { name: "Request the pairing" }).click();
}

test("Scenario 2: a manual pairing from request to credentials", async ({
  browser,
}) => {
  const appOwner = await pageAs(browser, SESSIONS.appOwner);
  const serverOwner = await pageAs(browser, SESSIONS.serverOwner);

  let pairingUrl = "";

  await test.step("the app owner requests a pairing, prefilled from the client's entry", async () => {
    await openSystemPage(appOwner, EVENT.slug, MEDIRECORDS.name);
    await appOwner
      .getByLabel("Your client")
      .selectOption({ label: SMART_FORMS.name });

    // Prefilled, not typed: the request carries what the client's own entry says, so the
    // server owner is answering the entry rather than a retyping of it.
    await expect(appOwner.getByLabel("Client name")).toHaveValue(
      SMART_FORMS.name,
    );
    await expect(appOwner.getByLabel("Launch URL")).toHaveValue(
      SMART_FORMS.launchUrl,
    );
    await expect(appOwner.getByLabel("Redirect URIs")).toHaveValue(
      SMART_FORMS.redirectUri,
    );

    await appOwner.getByRole("button", { name: "Request the pairing" }).click();
    await appOwner
      .getByRole("link", { name: "Watch it on the pairing's page" })
      .click();
    await expect(appOwner.locator("h1")).toContainText("Requested");
    pairingUrl = appOwner.url();
  });

  await test.step("the server owner is notified", async () => {
    // The console transport's log is where the message went, and it names the client that
    // wants to register.
    const message = await awaitMessageTo(SERVER_OWNER.email, SMART_FORMS.name);
    expect(message).toContain(MEDIRECORDS.name);
  });

  await test.step("the server owner fulfils it with the client identifier they issued", async () => {
    await serverOwner.goto("/pairings");
    await serverOwner
      .locator("tr")
      .filter({ hasText: SMART_FORMS.name })
      .getByRole("link", { name: "Respond" })
      .click();
    await serverOwner
      .getByLabel("Issued client identifier")
      .fill(MANUAL_CLIENT_ID);
    await serverOwner.getByRole("button", { name: "Mark fulfilled" }).click();
    await expect(serverOwner.locator("h1")).toContainText("Fulfilled");
    await expect(
      serverOwner.getByText(
        `Registered. The issued client identifier is ${MANUAL_CLIENT_ID}.`,
      ),
    ).toBeVisible();
  });

  await test.step("both sides see the same state and the same timeline", async () => {
    await appOwner.goto(pairingUrl);
    await expect(appOwner.locator("h1")).toContainText("Fulfilled");
    expect(await timelineText(appOwner)).toBe(await timelineText(serverOwner));
  });

  await test.step("a duplicate request is refused, with a link to the pairing that exists", async () => {
    await openSystemPage(appOwner, EVENT.slug, MEDIRECORDS.name);
    await requestPairing(appOwner);
    const existing = appOwner.getByRole("link", {
      name: "Open the pairing you already have",
    });
    await expect(existing).toBeVisible();
    await existing.click();
    expect(appOwner.url()).toBe(pairingUrl);
  });

  await test.step("the app owner's own listing shows it, and nobody else's does", async () => {
    // Both organisations are party to it; a third would not be. `APP_OWNER` is the reader
    // here, so the row carries their client's name.
    await appOwner.goto("/pairings");
    await expect(
      appOwner.locator("tr").filter({ hasText: SMART_FORMS.name }),
    ).toContainText(APP_OWNER.organisation);
  });

  await appOwner.context().close();
  await serverOwner.context().close();
});
