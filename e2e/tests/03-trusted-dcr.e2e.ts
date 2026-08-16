/**
 * Quickstart scenario 3: trusted DCR against the stub registration server.
 *
 * The whole ceremony with no human on the server side: Muster mints a statement, presents it
 * to an endpoint a participant declared, and records what came back.
 *
 * Two of the assertions are about things that must *not* be somewhere. The client secret is
 * shown once and never stored (constitution principle IV), so it is looked for in the
 * pairing's own API representation and on the page after a reload. The statement's expiry is
 * capped at the event's end plus its grace period, so it is compared against that date rather
 * than merely being present.
 *
 * The tamper case belongs to scenario 4: the conformance harness presents a wrong-key
 * statement deliberately, and this stub refuses it there.
 *
 * Author: John Grimes
 */

import { expect, test } from "@playwright/test";

import {
  addServerSystem,
  enrolSystem,
  openSystemPage,
  pageAs,
} from "../support/journeys.js";
import {
  EVENT,
  SESSIONS,
  SMART_FORMS,
  STUB_AUTH,
  URLS,
} from "../support/stack.js";

import type { Page } from "@playwright/test";

/**
 * The last instant a statement minted for this event may vouch until.
 *
 * The event ends on the 19th and allows seven days of grace, so anything past the 27th is
 * the cap not being applied.
 */
const VOUCHING_CAP_SECONDS = Date.parse("2026-09-27T00:00:00Z") / 1000;

/**
 * The run's steps in one reported state.
 *
 * By the test identifier the page carries and the state it reports, rather than by the class
 * that paints it: a restyle must not be able to change what this suite asserts (FR-008).
 *
 * @param page - The page showing the run.
 * @param state - `done`, `failed`, `skipped`, `running` or `waiting`.
 * @returns The matching steps.
 */
function stepsInState(page: Page, state: string) {
  return page.locator(`[data-testid="dcr-step"][data-state="${state}"]`);
}

test("Scenario 3: trusted DCR against the stub registration server", async ({
  browser,
  request,
}) => {
  const serverOwner = await pageAs(browser, SESSIONS.serverOwner);
  const appOwner = await pageAs(browser, SESSIONS.appOwner);

  await test.step("the registration stub is listening", async () => {
    await expect
      .poll(
        async () =>
          (await request.get(`${URLS.registrationStub}/healthz`)).status(),
        { timeout: 60_000 },
      )
      .toBe(200);
  });

  await test.step("the server owner enrols a server that accepts vouched registration", async () => {
    await addServerSystem(serverOwner, STUB_AUTH, "trustedDcr");
    await enrolSystem(serverOwner, STUB_AUTH.name, EVENT.slug, STUB_AUTH.tags);
  });

  await test.step("the app owner requests the pairing and runs the registration", async () => {
    await openSystemPage(appOwner, EVENT.slug, STUB_AUTH.name);
    await appOwner
      .getByLabel("Your client")
      .selectOption({ label: SMART_FORMS.name });
    // Confidential, so that the server issues a secret and the one-time relay has something
    // to relay. A public client is registered without one, and there would be nothing to
    // show that Muster never stored it.
    await appOwner.getByLabel("Confidentiality").selectOption("confidential");
    await appOwner.getByRole("button", { name: "Request the pairing" }).click();
    await appOwner
      .getByRole("link", { name: "Watch it on the pairing's page" })
      .click();
    await appOwner
      .getByRole("link", { name: "Open the registration run" })
      .click();
    await appOwner
      .getByRole("button", { name: "Mint and present the statement" })
      .click();
    await expect(appOwner.locator("h1")).toContainText("Registered");
  });

  const pairingId = /\/pairings\/([^/]+)\/register/.exec(appOwner.url())?.[1];
  expect(pairingId).toBeDefined();

  await test.step("the server issued a client identifier, and Muster recorded it", async () => {
    await expect(
      appOwner.getByText("Registered. The issued client identifier is"),
    ).toBeVisible();
    await expect(appOwner.getByTestId("dcr-step")).toHaveCount(3);
    await expect(stepsInState(appOwner, "done")).toHaveCount(3);
    await expect(stepsInState(appOwner, "failed")).toHaveCount(0);
  });

  await test.step("the client secret is shown once and is nowhere else", async () => {
    const secret = await appOwner.locator("#client-secret").inputValue();
    expect(secret.length).toBeGreaterThan(0);

    // Never persisted (constitution principle IV). The pairing is the record the secret
    // would have been attached to, so that is where its absence has to be shown.
    const pairing = await appOwner.request.get(`/api/pairings/${pairingId}`);
    expect(await pairing.text()).not.toContain(secret);

    // And it is not recoverable from the page either: it lives in the component's memory.
    await appOwner.reload();
    await expect(
      appOwner.getByRole("heading", {
        level: 2,
        name: "One-time client secret",
      }),
    ).toHaveCount(0);
  });

  await test.step("the statement is downloadable and vouches no further than the event's grace", async () => {
    const claims: unknown = JSON.parse(
      await appOwner.getByTestId("statement-claims").innerText(),
    );
    const expiry = (claims as { exp?: number }).exp;
    expect(expiry).toBeDefined();
    expect(expiry ?? 0).toBeGreaterThan(Date.now() / 1000);
    expect(expiry ?? 0).toBeLessThanOrEqual(VOUCHING_CAP_SECONDS);

    const download = await appOwner.request.get(
      `/api/pairings/${pairingId}/statement`,
    );
    expect(download.ok()).toBe(true);
    // A compact JWS: header, payload, signature.
    expect((await download.text()).trim().split(".")).toHaveLength(3);
  });

  await serverOwner.context().close();
  await appOwner.context().close();
});
