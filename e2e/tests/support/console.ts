import { expect } from "@playwright/test";

import { eventSlug, password, unique, verificationToken } from "./stack.ts";

import type { Locator, Page } from "@playwright/test";

/**
 * Driving the console: the flows every scenario starts from.
 *
 * Each helper does what a person does - fills the form on the screen and waits
 * for the screen to say it worked - rather than posting to the API behind it. The
 * point of an end-to-end suite is that the console and the server agree, so an
 * arrangement made through the API would test less than it looks like it does.
 *
 * The one exception is verification, which needs the link Muster logged, because
 * the stack has no SMTP server and writes its mail to the log.
 *
 * @author John Grimes
 */

/** An account this suite created, and what it is called on screen. */
export type Account = {
  /** the address it signed up with */
  readonly email: string;
  /** the name it gave */
  readonly displayName: string;
};

/**
 * The panel with a given heading.
 *
 * Every panel names itself for a screen reader, so this is the accessible name
 * rather than a class name: a selector that survives restyling.
 *
 * @param page - the page being driven
 * @param name - the panel's heading
 * @returns the panel
 */
export const panel = (page: Page, name: string): Locator =>
  page.getByRole("region", { name });

/**
 * Chooses the option of a select whose label contains some text.
 *
 * Several selects in the console label an option with more than the name - a
 * server with its organisation, an event with its status - so the option is found
 * by what it contains and then chosen by its value.
 *
 * @param select - the select to choose in
 * @param text - text the option's label contains
 * @returns nothing
 * @throws {Error} when no option contains it
 * @example
 * ```ts
 * await choose(form.getByLabel("The server"), serverName);
 * ```
 */
export const choose = async (select: Locator, text: string): Promise<void> => {
  const option = select.locator("option").filter({ hasText: text }).first();
  const value = await option.getAttribute("value");
  if (value === null) {
    throw new Error(`No option contains ${text}`);
  }
  await select.selectOption(value);
};

/**
 * Signs an account up and verifies its address.
 *
 * @param page - the page being driven
 * @param role - what the account is for, which becomes part of its address
 * @returns the account
 * @example
 * ```ts
 * const appOwner = await signUp(page, "appowner");
 * ```
 */
export const signUp = async (page: Page, role: string): Promise<Account> => {
  const email = `${unique(role)}@example.org`;
  const displayName = `${role} ${email.split("@")[0] ?? ""}`;

  await page.goto("/sign-in");
  const form = panel(page, "Create an account");
  await form.getByLabel("Email address").fill(email);
  await form.getByLabel("Your name").fill(displayName);
  await form.getByLabel("Password").fill(password);
  await form.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByText(`Account created for ${email}`)).toBeVisible();

  // The link Muster logged, followed as a person follows it out of their inbox.
  await page.goto(`/verify?token=${verificationToken(email)}`);
  await expect(page.getByText("Your address is verified")).toBeVisible();

  return { email, displayName };
};

/**
 * Signs the current account out, if one is signed in.
 *
 * @param page - the page being driven
 * @returns nothing
 */
export const signOut = async (page: Page): Promise<void> => {
  await page.goto("/sign-in");
  const button = page.getByRole("button", { name: "Sign out" });
  const form = panel(page, "Sign in");
  // The screen shows one or the other, once the session has been read. Waiting
  // for either is what keeps this from racing the request that reads it.
  await expect(button.or(form).first()).toBeVisible();
  if (await button.isVisible()) {
    await button.click();
    await expect(form).toBeVisible();
  }
};

/**
 * Signs an account in.
 *
 * @param page - the page being driven
 * @param email - the address to sign in with
 * @param secret - the password, defaulting to the suite's
 * @returns nothing
 */
export const signIn = async (
  page: Page,
  email: string,
  secret: string = password,
): Promise<void> => {
  await signOut(page);
  const form = panel(page, "Sign in");
  await form.getByLabel("Email address").fill(email);
  await form.getByLabel("Password").fill(secret);
  await form.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
};

/**
 * Approves an account, as the signed-in track admin.
 *
 * @param page - the page being driven, signed in as an admin
 * @param account - the account to approve
 * @returns nothing
 */
export const approve = async (page: Page, account: Account): Promise<void> => {
  await page.goto("/admin/members");
  const row = page.getByRole("row").filter({ hasText: account.email });
  await row.getByRole("button", { name: "Approve" }).click();
  // The list shows pending accounts, so an approved one leaves it: the operation's
  // own report is what says it worked.
  await expect(
    page.getByText(`${account.displayName} is now approved`),
  ).toBeVisible();
};

/**
 * Creates an organisation, as the signed-in member.
 *
 * @param page - the page being driven
 * @param name - the organisation's name
 * @returns the name it was given
 */
export const createOrganisation = async (
  page: Page,
  name: string,
): Promise<string> => {
  await page.goto("/my-organisation");
  await page.getByLabel("Organisation name").fill(name);
  await page.getByRole("button", { name: "Create", exact: true }).click();
  // The members and systems panels appear for the organisation just created.
  await expect(panel(page, "Systems")).toBeVisible();
  return name;
};

/** A server system's details, as the form asks for them. */
export type ServerDetails = {
  /** the FHIR base URL */
  readonly fhirBaseUrl: string;
  /** how it authorises */
  readonly authorizationMode?: "SMART on FHIR" | "Open (no authorization)";
  /** how it registers clients */
  readonly registrationMode?:
    | "Manual, by the server's owner"
    | "Trusted dynamic client registration"
    | "None needed";
  /** where it says it authorises, which drift is detected against */
  readonly authorizationEndpoint?: string;
  /** where it says it issues tokens, which drift is detected against */
  readonly tokenEndpoint?: string;
  /** where a software statement is posted */
  readonly registrationEndpoint?: string;
};

/** A client system's details, as the form asks for them. */
export type ClientDetails = {
  /** where the app is launched */
  readonly launchUrl: string;
  /** the redirect URIs, one per line */
  readonly redirectUris: string;
  /** the scopes asked for */
  readonly scopes: string;
};

/**
 * Adds a system to the signed-in member's organisation.
 *
 * @param page - the page being driven, on the organisation screen
 * @param details - the name and the profiles to fill in
 * @returns the system's name
 * @example
 * ```ts
 * await addSystem(page, { name: "Smart Forms", client: { ... } });
 * ```
 */
export const addSystem = async (
  page: Page,
  details: Readonly<{
    /** the system's name */
    name: string;
    /** the server profile, when it is a server */
    server?: ServerDetails;
    /** the client profile, when it is a client */
    client?: ClientDetails;
  }>,
): Promise<string> => {
  await page.goto("/my-organisation");
  const systems = panel(page, "Systems");
  await systems.getByRole("button", { name: "Add a system" }).click();

  const form = systems.locator("form").filter({ hasText: "A new system" });
  await form.getByLabel("Name").fill(details.name);
  if (details.server !== undefined) {
    await form.getByLabel("A server").check();
    await form.getByLabel("FHIR base URL").fill(details.server.fhirBaseUrl);
    if (details.server.authorizationMode !== undefined) {
      await form
        .getByLabel("Authorization mode")
        .selectOption({ label: details.server.authorizationMode });
    }
    if (details.server.registrationMode !== undefined) {
      await form
        .getByLabel("Registration mode")
        .selectOption({ label: details.server.registrationMode });
    }
    if (details.server.authorizationEndpoint !== undefined) {
      await form
        .getByLabel("Authorization endpoint")
        .fill(details.server.authorizationEndpoint);
    }
    if (details.server.tokenEndpoint !== undefined) {
      await form
        .getByLabel("Token endpoint")
        .fill(details.server.tokenEndpoint);
    }
    if (details.server.registrationEndpoint !== undefined) {
      await form
        .getByLabel("Registration endpoint")
        .fill(details.server.registrationEndpoint);
    }
  }
  if (details.client !== undefined) {
    await form.getByLabel("A client").check();
    await form.getByLabel("Launch URL").fill(details.client.launchUrl);
    await form.getByLabel("Redirect URIs").fill(details.client.redirectUris);
    await form.getByLabel("Scopes").fill(details.client.scopes);
  }
  await form.getByRole("button", { name: "Add the system" }).click();

  await expect(
    systems.getByRole("heading", { name: details.name, exact: true }),
  ).toBeVisible();
  return details.name;
};

/**
 * Enrols a system into the seeded event, with the tags given.
 *
 * @param page - the page being driven, on the organisation screen
 * @param name - the system's name
 * @param tags - the capability tags to claim
 * @returns nothing
 */
export const enrol = async (
  page: Page,
  name: string,
  tags: readonly string[] = [],
): Promise<void> => {
  await page.goto("/my-organisation");
  const systems = panel(page, "Systems");
  await systems
    .getByLabel("Event to enrol into")
    .selectOption({ value: eventSlug });
  const entry = systems
    .getByRole("listitem")
    .filter({ has: page.getByRole("heading", { name, exact: true }) });
  for (const tag of tags) {
    await entry.getByLabel(tag).check();
  }
  await entry.getByRole("button", { name: /^Enrol in / }).click();
  await expect(
    entry.getByRole("button", { name: "Re-confirm the details" }),
  ).toBeVisible();
};
