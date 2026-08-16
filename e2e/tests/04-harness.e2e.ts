/**
 * Quickstart scenario 4: the conformance harness and the DCR verified badge.
 *
 * The badge is driven by the latest run rather than the best one, so both halves of that are
 * asserted: a passing run puts it on the entry an anonymous visitor reads, and a failing run
 * takes it off.
 *
 * The failing run is produced by turning one of the stub's rules off rather than by
 * pretending: `STUB_BROKEN_MODE=skip-signature` makes it accept a statement whose signature
 * does not verify, which is exactly the case the "tampered signature rejected" check exists
 * to catch. A harness that could not be shown to fail would be evidence of nothing.
 *
 * Author: John Grimes
 */

import { expect, test } from "@playwright/test";

import { setRegistrationStubMode } from "../support/compose.js";
import { anonymousPage, openSystemPage, pageAs } from "../support/journeys.js";
import { EVENT, SESSIONS, STUB_AUTH, URLS } from "../support/stack.js";

import type { Browser, Locator, Page } from "@playwright/test";

/** The row of one named check in the results table. */
function checkRow(page: Page, check: string) {
  return page.locator("tr").filter({ hasText: check });
}

/**
 * The check results in one outcome, anywhere on the page or within a row.
 *
 * By the test identifier the results table carries and the outcome it reports, rather than by
 * the class that paints it: a restyle must not be able to change what this suite asserts
 * (FR-008).
 *
 * @param scope - The page, or one row of it.
 * @param outcome - `passed` or `failed`.
 * @returns The matching result marks.
 */
function checkResults(scope: Page | Locator, outcome: "passed" | "failed") {
  return scope.locator(`[data-testid="check-result"][data-state="${outcome}"]`);
}

/**
 * What the entry's row on the event view says, to somebody with no account.
 *
 * A fresh context each time rather than a reload: the badge is a public claim, and the
 * reader who matters is the one who never signed in.
 */
async function entryAsSeenByAnyone(browser: Browser): Promise<string> {
  const visitor = await anonymousPage(browser);
  try {
    await visitor.goto(`/events/${EVENT.slug}`);
    return await visitor
      .locator("tr")
      .filter({ hasText: STUB_AUTH.name })
      .innerText();
  } finally {
    await visitor.context().close();
  }
}

// However this run ends, the stack goes back to a conformant stub: the specs after this one
// enrol against it and are not about its broken modes.
test.afterAll(async () => {
  await setRegistrationStubMode("");
});

test("Scenario 4: the conformance harness and the DCR verified badge", async ({
  browser,
  request,
}) => {
  const serverOwner = await pageAs(browser, SESSIONS.serverOwner);

  await test.step("the entry owner runs the harness and every check passes", async () => {
    await openSystemPage(serverOwner, EVENT.slug, STUB_AUTH.name);
    await serverOwner
      .getByRole("link", { name: "Conformance harness and its evidence" })
      .click();
    await expect(serverOwner.getByText("No run yet.")).toBeVisible();

    await serverOwner
      .getByRole("button", { name: "Run checks", exact: true })
      .click();
    await expect(
      serverOwner.getByText("All checks passed - DCR verified badge applied"),
    ).toBeVisible({ timeout: 60_000 });
    await expect(checkResults(serverOwner, "passed")).toHaveCount(6);
    await expect(checkResults(serverOwner, "failed")).toHaveCount(0);
  });

  await test.step("the badge appears on the entry, for anyone", async () => {
    expect(await entryAsSeenByAnyone(browser)).toContain("DCR verified");
  });

  await test.step("with the stub's signature validation turned off, the tamper check fails", async () => {
    await setRegistrationStubMode("skip-signature");
    await expect
      .poll(
        async () =>
          (await request.get(`${URLS.registrationStub}/healthz`)).status(),
        { timeout: 60_000 },
      )
      .toBe(200);

    await serverOwner.reload();
    await serverOwner.getByRole("button", { name: "Run checks again" }).click();
    await expect(
      serverOwner.getByText("checks failed - no badge is shown"),
    ).toBeVisible({ timeout: 60_000 });
    await expect(
      checkResults(
        checkRow(serverOwner, "Tampered signature rejected"),
        "failed",
      ),
    ).toBeVisible();
    // The rest of the profile is untouched, so the valid case still passes: the harness
    // names the rule that broke rather than reporting a blanket failure.
    await expect(
      checkResults(checkRow(serverOwner, "Valid statement accepted"), "passed"),
    ).toBeVisible();
  });

  await test.step("and the badge goes, because the latest run decides it", async () => {
    expect(await entryAsSeenByAnyone(browser)).not.toContain("DCR verified");
  });

  await serverOwner.context().close();
});
