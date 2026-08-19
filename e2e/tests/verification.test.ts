import { expect, test } from "@playwright/test";

import { panel } from "./support/console.ts";
import {
  participantAddress,
  password,
  unique,
  verificationToken,
} from "./support/stack.ts";

/**
 * The specification's edge case, both halves: a verification link fails when it
 * is used a second time or after it has lapsed, with a clear message and an offer
 * to resend - and the offer works.
 *
 * A token lives a day, so without a working offer an account whose link lapsed
 * would be stranded with no way to verify the address at all (FR-001). The
 * replacement supersedes the earlier link, which is why the earlier one is
 * refused here as already used rather than left live beside it.
 *
 * @author John Grimes
 */

/** The account this file creates, unverified on purpose. */
const email = `${unique("stranded")}@example.org`;

// One address for this file, so its attempts do not exhaust another's allowance.
test.use({ extraHTTPHeaders: { "x-forwarded-for": participantAddress() } });

// Each test builds on the last: one account, one link, one replacement.
test.describe.configure({ mode: "serial" });

/** The link Muster sent when the account signed up, left unspent. */
let firstToken: string;

test("signs up an account and leaves its link unspent", async ({ page }) => {
  await page.goto("/sign-in");
  const form = panel(page, "Create an account");
  await form.getByLabel("Email address").fill(email);
  await form.getByLabel("Your name").fill("Stranded Member");
  await form.getByLabel("Password").fill(password);
  await form.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByText(`Account created for ${email}`)).toBeVisible();

  firstToken = verificationToken(email);
});

test("sends a replacement link when one is asked for", async ({ page }) => {
  await page.goto("/sign-in");
  const form = panel(page, "Send a new verification link");
  await form.getByLabel("Email address").fill(email);
  await form.getByRole("button", { name: "Send a new link" }).click();

  // The answer says nothing about whether the address holds an account, which is
  // what keeps an anonymous caller from enumerating addresses with it.
  await expect(page.getByText("a new link is on its way")).toBeVisible();
  expect(verificationToken(email)).not.toBe(firstToken);
});

test("refuses the superseded link, and offers a replacement", async ({
  page,
}) => {
  await page.goto(`/verify?token=${firstToken}`);

  // Scoped to the alert: the resend panel's own description mentions a link that
  // has already been used, so an unscoped match finds both and says nothing about
  // which of them reported the refusal.
  await expect(
    page.getByRole("alert").filter({ hasText: "already been used" }),
  ).toBeVisible();
  // The refusal is not a dead end: the offer is on the same screen.
  await expect(panel(page, "Send a new verification link")).toBeVisible();
});

test("verifies the address with the replacement link", async ({ page }) => {
  await page.goto(`/verify?token=${verificationToken(email)}`);

  await expect(page.getByText("Your address is verified")).toBeVisible();
});
