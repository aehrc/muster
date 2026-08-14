/**
 * Quickstart scenario 1: from an empty database to a public event view.
 *
 * The whole of user story 1 in one journey, and the foundation of every scenario after it -
 * so it also saves the three sessions the later specs reuse rather than spending the sign-in
 * rate limit on repeating themselves.
 *
 * The assertion that matters most is the last one. Every read surface is public and contact
 * details are not (constitution principle V), and the only way to demonstrate that is with a
 * browser that has never held a session and an API request that carries no cookie.
 *
 * Author: John Grimes
 */

import { expect, test } from "@playwright/test";

import {
  addClientSystem,
  addServerSystem,
  anonymousPage,
  approveMember,
  createOrganisation,
  enrolSystem,
  openSystemPage,
  keepSession,
  signIn,
  signUpAndVerify,
} from "../support/journeys.js";
import {
  ADMIN,
  APP_OWNER,
  EVENT,
  MEDIRECORDS,
  SERVER_OWNER,
  SESSIONS,
  SMART_FORMS,
} from "../support/stack.js";

test("Scenario 1: from an empty database to a public event view", async ({
  browser,
  page,
  request,
}) => {
  await test.step("two accounts sign up and verify their addresses", async () => {
    await signUpAndVerify(page, APP_OWNER);
    await signUpAndVerify(page, SERVER_OWNER);
  });

  await test.step("the seeded track admin approves both", async () => {
    await signIn(page, ADMIN, `Signed in as ${ADMIN.displayName}`);
    await approveMember(page, APP_OWNER.email);
    await approveMember(page, SERVER_OWNER.email);
    await keepSession(page, SESSIONS.admin);
  });

  await test.step("the server owner creates MediRecords and enrols its server", async () => {
    await signIn(
      page,
      SERVER_OWNER,
      `Signed in as ${SERVER_OWNER.displayName}`,
    );
    await createOrganisation(page, SERVER_OWNER.organisation);
    await addServerSystem(page, MEDIRECORDS, "manual");
    await enrolSystem(page, MEDIRECORDS.name, EVENT.slug, MEDIRECORDS.tags);
    await keepSession(page, SESSIONS.serverOwner);
  });

  await test.step("the app owner creates CSIRO and enrols its client", async () => {
    await signIn(page, APP_OWNER, `Signed in as ${APP_OWNER.displayName}`);
    await createOrganisation(page, APP_OWNER.organisation);
    await addClientSystem(page, SMART_FORMS);
    await enrolSystem(page, SMART_FORMS.name, EVENT.slug, SMART_FORMS.tags);
    await page.context().storageState({ path: SESSIONS.appOwner });
    // Not `keepSession`: the last two steps read the same pages as this account, so the
    // cookie stays where it is.
  });

  await test.step("the JSON API lists both systems and no contact detail", async () => {
    const response = await request.get(`/api/events/${EVENT.slug}/systems`);
    expect(response.ok()).toBe(true);
    const body = await response.text();
    expect(body).toContain(MEDIRECORDS.name);
    expect(body).toContain(SMART_FORMS.name);
    // Not "no email address that happens to be there": these two, by name.
    expect(body).not.toContain(SERVER_OWNER.email);
    expect(body).not.toContain(APP_OWNER.email);
  });

  await test.step("a visitor with no account reads the event and is refused the contacts", async () => {
    const visitor = await anonymousPage(browser);
    await visitor.goto(`/events/${EVENT.slug}`);
    await expect(
      visitor.getByRole("link", { name: MEDIRECORDS.name, exact: true }),
    ).toBeVisible();
    await expect(
      visitor.getByRole("link", { name: SMART_FORMS.name, exact: true }),
    ).toBeVisible();

    await openSystemPage(visitor, EVENT.slug, MEDIRECORDS.name);
    await expect(
      visitor.getByText(
        "Locked. Sign in as an approved member to see who to talk to about this system.",
      ),
    ).toBeVisible();
    await expect(visitor.getByText(SERVER_OWNER.email)).toHaveCount(0);
    await visitor.context().close();
  });

  await test.step("signed in, the same page shows who to talk to", async () => {
    await openSystemPage(page, EVENT.slug, MEDIRECORDS.name);
    await expect(
      page.getByText(`${SERVER_OWNER.displayName} - ${SERVER_OWNER.email}`),
    ).toBeVisible();
  });
});
