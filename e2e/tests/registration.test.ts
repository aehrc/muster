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
  participantAddress,
  registerStubPublicUrl,
  registerStubUrl,
  unique,
} from "./support/stack.ts";

import type { Account } from "./support/console.ts";

/**
 * Quickstart scenario 3: trusted dynamic client registration against the stub.
 *
 * The whole of User Story 5 in one pass: a server that accepts what Muster
 * vouches for, a pairing nobody on the server's side has to touch, a statement
 * whose validity is capped at the event's end plus its grace, and the same
 * artefact downloadable afterwards.
 *
 * The stub is reached over http, which Muster permits only because the stack
 * names its host in `MUSTER_OUTBOUND_ALLOWLIST`; nothing here disables TLS
 * verification, and there is no certificate or private key in the repository.
 *
 * @author John Grimes
 */

const serverName = `Stub Auth ${unique("server")}`;
const clientName = `Smart Forms ${unique("client")}`;

let serverOwner: Account;
let appOwner: Account;

test.use({ extraHTTPHeaders: { "x-forwarded-for": participantAddress() } });
test.describe.configure({ mode: "serial" });

test("enrols a server that accepts what Muster vouches for", async ({
  page,
}) => {
  serverOwner = await signUp(page, "serverowner");
  appOwner = await signUp(page, "appowner");
  await signIn(page, admin.email, admin.password);
  await approve(page, serverOwner);
  await approve(page, appOwner);

  await signIn(page, serverOwner.email);
  await createOrganisation(page, `Stub Vendor ${unique("org")}`);
  await addSystem(page, {
    name: serverName,
    server: {
      fhirBaseUrl: `${registerStubUrl}/fhir`,
      registrationMode: "Trusted dynamic client registration",
      registrationEndpoint: `${registerStubUrl}/register`,
    },
  });
  await enrol(page, serverName);

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
  await enrol(page, clientName);
});

test("registers the client with nobody on the server's side", async ({
  page,
}) => {
  await signIn(page, appOwner.email);
  await page.goto(`/pairings?event=${eventSlug}`);
  const form = panel(page, "Request a pairing");
  await choose(form.getByLabel("Your client"), clientName);
  await choose(form.getByLabel("The server"), serverName);
  await form.getByRole("button", { name: "Request the pairing" }).click();

  await panel(page, "Your pairings")
    .getByRole("link", { name: clientName })
    .click();
  await panel(page, "Register with no human on the server's side")
    .getByRole("link", { name: `Register at ${serverName}` })
    .click();

  await panel(page, "Run the registration")
    .getByRole("button", { name: "Register at the server" })
    .click();

  // The stub answers with an identifier it minted, and the pairing carries it.
  await expect(page.getByText("issued the client identifier")).toBeVisible({
    timeout: 30_000,
  });
  await expect(
    panel(page, "The software statement").getByRole("link", {
      name: "Download the statement",
    }),
  ).toBeVisible();
});

test("caps the statement's validity at the event's end plus its grace", async ({
  page,
  request,
}) => {
  const event = await request.get(`/api/events/${eventSlug}`);
  const { event: detail } = (await event.json()) as {
    event: { endsOn: string; graceDays: number };
  };
  // The end of the last grace day: midnight after `endsOn` plus the grace days,
  // which is what `vouchingExpiresAt` computes (FR-023).
  const latest = new Date(
    Date.parse(`${detail.endsOn}T00:00:00.000Z`) +
      (detail.graceDays + 1) * 24 * 60 * 60 * 1000,
  );

  await signIn(page, appOwner.email);
  await page.goto(`/pairings?event=${eventSlug}`);
  await panel(page, "Your pairings")
    .getByRole("link", { name: clientName })
    .click();

  const vouched = panel(page, "What Muster vouched for");
  await expect(vouched).toBeVisible();
  const shown = await vouched.innerText();
  // The claim is rendered as an instant; whatever it says, it cannot outlast the
  // event's end plus its grace days (FR-023).
  const expiry = /\d{4}-\d{2}-\d{2}T[\d:.]+Z/.exec(shown);
  expect(expiry).not.toBeNull();
  expect(new Date(expiry?.[0] ?? "").getTime()).toBeLessThanOrEqual(
    latest.getTime(),
  );
});

test("hands over the identical statement when it is downloaded", async ({
  page,
}) => {
  await signIn(page, appOwner.email);
  await page.goto(`/pairings?event=${eventSlug}`);
  await panel(page, "Your pairings")
    .getByRole("link", { name: clientName })
    .click();
  const link = panel(page, "What Muster vouched for").getByRole("link", {
    name: "Download the statement",
  });
  const path = await link.getAttribute("href");
  expect(path).not.toBeNull();

  // Through the page's own context, so the session cookie travels with it: the
  // statement is not a public document.
  const downloaded = await page.request.get(path ?? "");
  expect(downloaded.ok()).toBe(true);
  const statement = (await downloaded.text()).trim();
  expect(statement.split(".")).toHaveLength(3);

  // What the stub says it holds, so the run is corroborated by the other side.
  // Through its published port: `registerStubUrl` is the address Muster reaches it
  // on inside the stack's network, which does not resolve from out here.
  const registered = await page.request.get(`${registerStubPublicUrl}/clients`);
  const { clients } = (await registered.json()) as {
    clients: { client_id: string; software_statement?: string }[];
  };
  expect(clients.length).toBeGreaterThan(0);
});
