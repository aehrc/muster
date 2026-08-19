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
  eventSlug,
  participantAddress,
  registerStubUrl,
  unique,
} from "./support/stack.ts";

import type { Account } from "./support/console.ts";
import type { Page } from "@playwright/test";

/**
 * Quickstart scenario 4: the conformance harness, and the badge that follows it.
 *
 * Two entries are enrolled against the same stub: one at its strict endpoint, one
 * at the endpoint that skips signature validation. The strict one passes every
 * check and earns the "DCR verified" badge on the event view; the broken one fails
 * the tampered-signature check and earns nothing, which is the whole point of the
 * badge being about evidence (FR-030).
 *
 * @author John Grimes
 */

/** The entry that implements the profile properly. */
const strictName = `Stub Auth strict ${unique("server")}`;

/** The entry that accepts a statement whose signature does not verify. */
const brokenName = `Stub Auth lax ${unique("server")}`;

let serverOwner: Account;

/**
 * How long a run may take.
 *
 * The harness mints four statements and presents five registration requests, each
 * through the guarded fetch with its own deadline, so a run is the slowest thing
 * a member can ask for. The file's timeout has to exceed what an assertion waits
 * for, or the test ends before the wait does.
 */
const runTimeout = 60_000;

test.use({ extraHTTPHeaders: { "x-forwarded-for": participantAddress() } });
test.describe.configure({ mode: "serial", timeout: runTimeout + 60_000 });

/**
 * Opens the harness screen for one of this file's entries.
 *
 * @param page - the page being driven
 * @param name - the system's name
 * @returns nothing
 */
const openHarness = async (page: Page, name: string): Promise<void> => {
  await page.goto(`/events/${eventSlug}`);
  await page.getByRole("link", { name, exact: true }).click();
  await panel(page, "Trusted registration conformance")
    .getByRole("link", { name: /conformance harness|Read the report/ })
    .click();
  await expect(
    page.getByRole("heading", { name: `Conformance of ${name}` }),
  ).toBeVisible();
};

test("enrols a strict entry and a deliberately broken one", async ({
  page,
}) => {
  serverOwner = await signUp(page, "serverowner");
  await signIn(page, admin.email, admin.password);
  await approve(page, serverOwner);

  await signIn(page, serverOwner.email);
  await createOrganisation(page, `Stub Vendor ${unique("org")}`);
  await addSystem(page, {
    name: strictName,
    server: {
      fhirBaseUrl: `${registerStubUrl}/fhir`,
      registrationMode: "Trusted dynamic client registration",
      registrationEndpoint: `${registerStubUrl}/register`,
    },
  });
  await enrol(page, strictName);

  // The same stub, at the endpoint where it skips signature validation.
  await addSystem(page, {
    name: brokenName,
    server: {
      fhirBaseUrl: `${registerStubUrl}/fhir`,
      registrationMode: "Trusted dynamic client registration",
      registrationEndpoint: `${registerStubUrl}/modes/skipSignature/register`,
    },
  });
  await enrol(page, brokenName);
});

test("passes every check against the strict endpoint", async ({ page }) => {
  await signIn(page, serverOwner.email);
  await openHarness(page, strictName);

  await panel(page, "Run the profile against this server")
    .getByRole("button", { name: "Run the checks" })
    .click();

  const report = page.getByRole("region", { name: /^Run of / });
  await expect(report).toBeVisible({ timeout: runTimeout });
  await expect(
    report.getByText("This entry carries the DCR verified badge."),
  ).toBeVisible();
  // Every check, and nothing reported as failed anywhere in the report.
  await expect(report.getByText("Failed")).toHaveCount(0);
  // Quickstart scenario 3's tamper check, named rather than implied: the stub
  // refused the statement Muster re-signed with the wrong key.
  await expect(
    report
      .getByRole("listitem")
      .filter({ hasText: "A tampered signature is" })
      .getByText("Passed"),
  ).toBeVisible();
});

test("shows the badge on the public event view", async ({ page }) => {
  // Anonymous, because the badge is a public claim about evidence (SC-006).
  await signOut(page);
  await page.goto(`/events/${eventSlug}`);
  const entry = page.locator("article").filter({ hasText: strictName });

  await expect(entry.getByRole("link", { name: /DCR verified/ })).toBeVisible();
});

test("fails the tampered-signature check against the broken endpoint", async ({
  page,
}) => {
  await signIn(page, serverOwner.email);
  await openHarness(page, brokenName);

  await panel(page, "Run the profile against this server")
    .getByRole("button", { name: "Run the checks" })
    .click();

  const report = page.getByRole("region", { name: /^Run of / });
  await expect(report).toBeVisible({ timeout: runTimeout });
  await expect(
    report.getByText(
      "This entry carries no verified badge until a run passes every check.",
    ),
  ).toBeVisible();
  // The check that names what went wrong, rather than a bare verdict: the server
  // accepted a statement whose signature does not verify.
  const tampered = report
    .getByRole("listitem")
    .filter({ hasText: "A tampered signature is" });
  await expect(tampered.getByText("Failed")).toBeVisible();
});

test("gives the broken entry no badge", async ({ page }) => {
  await signOut(page);
  await page.goto(`/events/${eventSlug}`);
  const entry = page.locator("article").filter({ hasText: brokenName });

  await expect(entry).toBeVisible();
  await expect(entry.getByRole("link", { name: /DCR verified/ })).toHaveCount(
    0,
  );
});
