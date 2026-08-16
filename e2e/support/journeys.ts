/**
 * The journeys more than one scenario walks.
 *
 * Signing up, verifying, approving, describing a system and enrolling it are the steps the
 * quickstart names once and every later scenario depends on. They are here so that a spec
 * reads as the scenario it is testing rather than as a re-statement of the ones before it.
 *
 * Everything drives the console the way a participant does: no API shortcuts, no writing to
 * the database. A helper that took a shortcut would leave the surface it skipped untested in
 * every scenario that used it.
 *
 * Author: John Grimes
 */

import { expect } from "@playwright/test";

import { awaitVerificationLink } from "./mail.js";
import { URLS } from "./stack.js";

import type { Browser, Page } from "@playwright/test";

/**
 * What a context opened by hand needs, which it does not inherit from the configuration.
 *
 * `browser.newContext` takes none of the `use` block, so a context opened for a second role
 * would have no base URL and would refuse the stubs' certificate.
 */
const CONTEXT_OPTIONS = {
  baseURL: URLS.muster,
  ignoreHTTPSErrors: true,
} as const;

/** An account the suite creates or signs in as. */
export interface Account {
  readonly email: string;
  readonly displayName: string;
  readonly password: string;
}

/** What a system entry declares. */
export interface SystemSpec {
  readonly name: string;
  /** Present for a server entry. */
  readonly fhirBaseUrl?: string;
  readonly tokenEndpoint?: string;
  /** Present for a server that accepts Muster-vouched registration. */
  readonly registrationEndpoint?: string;
  /** Present for a client entry. */
  readonly launchUrl?: string;
  readonly redirectUri?: string;
}

/**
 * Opens a page carrying a saved session.
 *
 * @param browser - The browser the test was given.
 * @param storageState - Where the session was saved.
 * @returns A page in a context of its own; close `page.context()` when finished.
 * @example
 * ```ts
 * const admin = await pageAs(browser, SESSIONS.admin);
 * ```
 */
export async function pageAs(
  browser: Browser,
  storageState: string,
): Promise<Page> {
  const context = await browser.newContext({
    ...CONTEXT_OPTIONS,
    storageState,
  });
  return await context.newPage();
}

/**
 * Opens a page with no session at all.
 *
 * A context of its own rather than the test's own page, because "readable without an
 * account" is only demonstrated by a browser that has never had one (constitution principle
 * V).
 *
 * @param browser - The browser the test was given.
 * @returns A page carrying no cookie; close `page.context()` when finished.
 * @example
 * ```ts
 * const visitor = await anonymousPage(browser);
 * ```
 */
export async function anonymousPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext(CONTEXT_OPTIONS);
  return await context.newPage();
}

/**
 * Creates an account and follows the verification link the server logged.
 *
 * @param page - A page with no session.
 * @param account - The account to create.
 * @example
 * ```ts
 * await signUpAndVerify(page, APP_OWNER);
 * ```
 */
export async function signUpAndVerify(
  page: Page,
  account: Account,
): Promise<void> {
  await page.goto("/sign-in");
  // The tab, not the submit button: both read "Create account", and only the tab carries
  // `aria-pressed`.
  await page
    .locator("button[aria-pressed]", { hasText: "Create account" })
    .click();
  await page.getByLabel("Email").fill(account.email);
  await page.getByLabel("Your name").fill(account.displayName);
  await page.getByLabel("Password").fill(account.password);
  await page
    .locator("form")
    .getByRole("button", { name: "Create account" })
    .click();
  await expect(page.locator("h1")).toContainText("Check your email");

  // The console mail transport writes the message to the server's log, which is where the
  // quickstart reads it from too.
  await page.goto(await awaitVerificationLink(account.email));
  await page.getByRole("button", { name: "Verify my address" }).click();
  await expect(page.locator("h1")).toContainText("Address verified");
}

/**
 * Signs in, and asserts the standing the account arrived with.
 *
 * @param page - A page with no session.
 * @param account - Whose credentials to present.
 * @param expectedHeading - What the page should say afterwards.
 * @example
 * ```ts
 * await signIn(page, ADMIN, `Signed in as ${ADMIN.displayName}`);
 * ```
 */
export async function signIn(
  page: Page,
  account: Pick<Account, "email" | "password">,
  expectedHeading: string,
): Promise<void> {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(account.email);
  await page.getByLabel("Password").fill(account.password);
  await page.locator("form").getByRole("button", { name: "Sign in" }).click();
  await expect(page.locator("h1")).toContainText(expectedHeading);
}

/**
 * Saves the session for later specs, then forgets it here.
 *
 * Deliberately *not* the console's own "Sign out" button. Signing out revokes the session
 * token on the server, which would make the file this has just written a record of a session
 * that no longer exists - and the failure surfaces two specs later as an unexplained sign-in
 * page. Dropping the cookie locally leaves the session valid for whoever loads the file.
 *
 * @param page - A signed-in page.
 * @param storageState - Where to write the session.
 * @example
 * ```ts
 * await keepSession(page, SESSIONS.admin);
 * ```
 */
export async function keepSession(
  page: Page,
  storageState: string,
): Promise<void> {
  await page.context().storageState({ path: storageState });
  await page.context().clearCookies();
}

/**
 * Approves a member awaiting a decision.
 *
 * @param page - A page signed in as a track admin.
 * @param email - The account to approve.
 * @example
 * ```ts
 * await approveMember(page, APP_OWNER.email);
 * ```
 */
export async function approveMember(page: Page, email: string): Promise<void> {
  await page.goto("/admin/members");
  await page
    .locator("tr")
    .filter({ hasText: email })
    .getByRole("button", { name: "Approve" })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "Decision recorded" }),
  ).toBeVisible();
}

/**
 * Creates an organisation, with the signed-in account as its first member.
 *
 * @param page - A page signed in as an approved member.
 * @param name - What to call it.
 * @example
 * ```ts
 * await createOrganisation(page, "CSIRO");
 * ```
 */
export async function createOrganisation(
  page: Page,
  name: string,
): Promise<void> {
  await page.goto("/my-organisation");
  await page.getByLabel("Organisation name").fill(name);
  await page.getByRole("button", { name: "Create organisation" }).click();
  await expect(page.getByRole("heading", { level: 2, name })).toBeVisible();
}

/** Opens the "Add a system" panel. */
async function openSystemForm(page: Page): Promise<void> {
  await page.goto("/my-organisation");
  await page.getByRole("button", { name: "Add system" }).click();
  await expect(
    page.getByRole("heading", { level: 2, name: "Add a system" }),
  ).toBeVisible();
}

/** Saves the open system form and waits for the card it produces. */
async function saveSystem(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: "Save system" }).click();
  await expect(page.getByRole("heading", { level: 2, name })).toBeVisible();
}

/**
 * Describes a server system, with its registration mode.
 *
 * @param page - A page signed in as an approved member with an organisation.
 * @param spec - What the entry declares.
 * @param registrationMode - `open`, `manual` or `trustedDcr`.
 * @example
 * ```ts
 * await addServerSystem(page, MEDIRECORDS, "manual");
 * ```
 */
export async function addServerSystem(
  page: Page,
  spec: SystemSpec,
  registrationMode: "open" | "manual" | "trustedDcr",
): Promise<void> {
  await openSystemForm(page);
  await page.getByLabel("Name", { exact: true }).fill(spec.name);
  await page.getByLabel("FHIR base URL").fill(spec.fhirBaseUrl ?? "");
  await page.getByLabel("Registration mode").selectOption(registrationMode);
  if (spec.registrationEndpoint !== undefined) {
    // The field appears only once the mode is trusted DCR, which is the point of it.
    await page
      .getByLabel("Registration endpoint")
      .fill(spec.registrationEndpoint);
  }
  if (spec.tokenEndpoint !== undefined) {
    await page.getByLabel("Token endpoint").fill(spec.tokenEndpoint);
  }
  await saveSystem(page, spec.name);
}

/**
 * Describes a client system.
 *
 * @param page - A page signed in as an approved member with an organisation.
 * @param spec - What the entry declares.
 * @example
 * ```ts
 * await addClientSystem(page, SMART_FORMS);
 * ```
 */
export async function addClientSystem(
  page: Page,
  spec: SystemSpec,
): Promise<void> {
  await openSystemForm(page);
  await page.getByLabel("Name", { exact: true }).fill(spec.name);
  // Checked by default: an entry is a server unless it is said not to be.
  await page.getByLabel("This system is a server").uncheck();
  await page.getByLabel("This system is a client").check();
  await page.getByLabel("Launch URL").fill(spec.launchUrl ?? "");
  await page.getByLabel("Redirect URIs").fill(spec.redirectUri ?? "");
  await saveSystem(page, spec.name);
}

/**
 * Enrols one of the organisation's systems in an event.
 *
 * @param page - A page signed in as an approved member with the system.
 * @param systemName - Which system.
 * @param eventSlug - Which event, by slug.
 * @param tags - Capability tags, from the event's own, separated by spaces.
 * @example
 * ```ts
 * await enrolSystem(page, "Smart Forms", "sparked-2026-09", "smart-app");
 * ```
 */
export async function enrolSystem(
  page: Page,
  systemName: string,
  eventSlug: string,
  tags: string,
): Promise<void> {
  await page.goto("/my-organisation");
  // The card is a region named by its own heading, which is how it is addressed here: a class
  // name would be a styling coupling (FR-008).
  const card = page.getByRole("region", { name: systemName });
  await card.getByLabel("Enrol in event").selectOption(eventSlug);
  await card.getByLabel("Capability tags").fill(tags);
  await card.getByRole("button", { name: "Enrol and confirm details" }).click();
  await expect(
    card.getByText("Enrolled, and the details are confirmed as current."),
  ).toBeVisible();
}

/**
 * Opens one enrolled system's page on the event view.
 *
 * @param page - Any page.
 * @param eventSlug - The event.
 * @param systemName - The system's name, as the event view lists it.
 * @example
 * ```ts
 * await openSystemPage(page, EVENT.slug, STUB_AUTH.name);
 * ```
 */
export async function openSystemPage(
  page: Page,
  eventSlug: string,
  systemName: string,
): Promise<void> {
  await page.goto(`/events/${eventSlug}`);
  await page.getByRole("link", { name: systemName, exact: true }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: systemName }),
  ).toBeVisible();
}
