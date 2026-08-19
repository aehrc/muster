import { expect, test } from "@playwright/test";

import {
  addSystem,
  approve,
  choose,
  createOrganisation,
  enrol,
  panel,
  signIn,
  signUp,
} from "./support/console.ts";
import {
  admin,
  eventSlug,
  musterLog,
  participantAddress,
  unique,
} from "./support/stack.ts";

import type { Account } from "./support/console.ts";
import type { Page } from "@playwright/test";

/**
 * Quickstart scenario 2: a manual pairing, round trip.
 *
 * The app owner asks, with the fields prefilled from the client's own record; the
 * server owner is told and records the identifier it issued; both sides then see
 * the same state and the same history, which is the point of the tracker (FR-014,
 * FR-016). Asking twice is refused with a link to the pairing that already
 * exists, rather than with a second row nobody wanted.
 *
 * @author John Grimes
 */

/** The client identifier the server owner issues, as the quickstart names it. */
const clientId = "smart-forms-test-1";

/** The systems this file creates. */
const serverName = `MediRecords FHIR ${unique("server")}`;
const clientName = `Smart Forms ${unique("client")}`;

/** The launch URL the client's record carries, and the request should prefill. */
const launchUrl = "https://smartforms.example.org/launch";

let serverOwner: Account;
let appOwner: Account;

test.use({ extraHTTPHeaders: { "x-forwarded-for": participantAddress() } });
test.describe.configure({ mode: "serial" });

/**
 * Opens the pairing between these two systems.
 *
 * @param page - the page being driven
 * @returns nothing
 */
const openPairing = async (page: Page): Promise<void> => {
  await page.goto(`/pairings?event=${eventSlug}`);
  await panel(page, "Your pairings")
    .getByRole("link", { name: clientName })
    .click();
  await expect(
    page.getByRole("heading", { name: `${clientName} at ${serverName}` }),
  ).toBeVisible();
};

test("arranges an enrolled client and an enrolled server", async ({ page }) => {
  serverOwner = await signUp(page, "serverowner");
  appOwner = await signUp(page, "appowner");
  await signIn(page, admin.email, admin.password);
  await approve(page, serverOwner);
  await approve(page, appOwner);

  await signIn(page, serverOwner.email);
  await createOrganisation(page, `MediRecords ${unique("org")}`);
  await addSystem(page, {
    name: serverName,
    server: {
      fhirBaseUrl: "https://fhir.medirecords.example.org",
      registrationMode: "Manual, by the server's owner",
    },
  });
  await enrol(page, serverName);

  await signIn(page, appOwner.email);
  await createOrganisation(page, `CSIRO ${unique("org")}`);
  await addSystem(page, {
    name: clientName,
    client: {
      launchUrl,
      redirectUris: "https://smartforms.example.org/callback",
      scopes: "launch/patient patient/Observation.rs",
    },
  });
  await enrol(page, clientName);
});

test("requests a pairing with the fields prefilled from the client", async ({
  page,
}) => {
  await signIn(page, appOwner.email);
  await page.goto(`/pairings?event=${eventSlug}`);
  const form = panel(page, "Request a pairing");
  await choose(form.getByLabel("Your client"), clientName);

  // FR-016: choosing the client fills the field set in from its record, so the
  // app's owner is not retyping what Muster already holds.
  await expect(form.getByLabel("Client name")).toHaveValue(clientName);
  await expect(form.getByLabel("Launch URL")).toHaveValue(launchUrl);
  await expect(form.getByLabel("Redirect URIs")).toHaveValue(
    "https://smartforms.example.org/callback",
  );

  await choose(form.getByLabel("The server"), serverName);
  await form.getByRole("button", { name: "Request the pairing" }).click();

  // The pairing appears in the list, in the state a request leaves it in.
  const card = panel(page, "Your pairings")
    .getByRole("listitem")
    .filter({ hasText: clientName });
  await expect(card.getByText("Requested")).toBeVisible();
});

test("tells the server owner, who records the identifier it issued", async ({
  page,
}) => {
  // The notification, in the log because the stack sends no mail (FR-015).
  expect(musterLog()).toContain(`To: ${serverOwner.email}`);

  await signIn(page, serverOwner.email);
  await openPairing(page);
  // The panel appears only on the side that can act, and only in a state that
  // can be fulfilled (FR-014).
  await expect(panel(page, "Register the client")).toBeVisible();

  await panel(page, "Register the client")
    .getByLabel("Client identifier")
    .fill(clientId);
  await panel(page, "Register the client")
    .getByRole("button", { name: "Fulfil the request" })
    .click();

  await expect(page.getByText(`issued the client identifier`)).toBeVisible();
  await expect(page.getByText(clientId).first()).toBeVisible();
});

test("shows both sides the same state and the same history", async ({
  page,
}) => {
  const historyFor = async (email: string): Promise<string> => {
    await signIn(page, email);
    await openPairing(page);
    await expect(page.getByText(clientId).first()).toBeVisible();
    return (await panel(page, "History").innerText()).replaceAll(/\s+/g, " ");
  };

  const server = await historyFor(serverOwner.email);
  const client = await historyFor(appOwner.email);

  expect(client).toBe(server);
  expect(client).toContain("Fulfilled");
});

test("refuses a second request and links to the pairing that exists", async ({
  page,
}) => {
  await signIn(page, appOwner.email);
  await page.goto(`/pairings?event=${eventSlug}`);
  const form = panel(page, "Request a pairing");
  await choose(form.getByLabel("Your client"), clientName);
  await choose(form.getByLabel("The server"), serverName);
  await form.getByRole("button", { name: "Request the pairing" }).click();

  await expect(form.getByText("These two are already paired")).toBeVisible();
  await form.getByRole("link", { name: "Open the existing pairing" }).click();
  await expect(page.getByText(clientId).first()).toBeVisible();
});
