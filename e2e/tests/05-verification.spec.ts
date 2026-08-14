/**
 * Quickstart scenario 5: liveness checks, drift and the guard.
 *
 * Three ways an entry can stop being true, and the directory has to say which one happened.
 * A server that disagrees with itself is not a server that is down, and a private address
 * Muster refused to fetch is not a server that refused the connection - the check records
 * that distinction and this asserts the entry shows it.
 *
 * The unreachable case is produced by stopping a container. Nothing else produces it
 * honestly: "unreachable, and here is when it was last reachable" is a claim about a server
 * that used to answer.
 *
 * Author: John Grimes
 */

import { expect, test } from "@playwright/test";

import { awaitCheck } from "../support/checks.js";
import { startService, stopService } from "../support/compose.js";
import {
  addServerSystem,
  anonymousPage,
  enrolSystem,
  openSystemPage,
  pageAs,
} from "../support/journeys.js";
import {
  DRIFTING,
  EVENT,
  GUARDED,
  SESSIONS,
  STUB_AUTH,
} from "../support/stack.js";

// Whatever happens, the stub goes back up: the scenarios after this one read its coverage.
test.afterAll(async () => {
  await startService("stub-server");
});

test("Scenario 5: drift, unreachability and the outbound guard", async ({
  browser,
  request,
}) => {
  const serverOwner = await pageAs(browser, SESSIONS.serverOwner);
  const visitor = await anonymousPage(browser);

  await test.step("two more entries are enrolled: one that drifts, one on a private address", async () => {
    await addServerSystem(serverOwner, DRIFTING, "manual");
    await enrolSystem(serverOwner, DRIFTING.name, EVENT.slug, DRIFTING.tags);
    await addServerSystem(serverOwner, GUARDED, "manual");
    await enrolSystem(serverOwner, GUARDED.name, EVENT.slug, GUARDED.tags);
  });

  await test.step("the declared token endpoint is flagged against the advertised one", async () => {
    const check = await awaitCheck(
      request,
      DRIFTING.name,
      (latest) => (latest?.driftFlags.length ?? 0) > 0,
    );
    const flag = check.driftFlags[0];
    expect(flag?.declared).toBe(DRIFTING.tokenEndpoint);
    // The advertised value is the stub's own, which is what makes this a disagreement
    // rather than a missing value.
    expect(flag?.advertised).toContain("/token");

    await openSystemPage(visitor, EVENT.slug, DRIFTING.name);
    await expect(
      visitor.getByText(
        "Drift: declared token endpoint differs from advertised",
      ),
    ).toBeVisible();
    // Both values, named: an operator cannot act on "something disagrees".
    await expect(
      visitor.getByText(`Declared: ${DRIFTING.tokenEndpoint}`),
    ).toBeVisible();
    await expect(visitor.getByText("Advertised: https://")).toBeVisible();
  });

  await test.step("a private-range base URL is refused before anything is sent", async () => {
    const check = await awaitCheck(
      request,
      GUARDED.name,
      (latest) => latest?.failureMode === "guarded",
    );
    // The guard's own words, which say no request was made rather than that one failed.
    expect(check.detail).toContain("not a publicly routable address");
    expect(check.lastSuccessAt).toBeNull();

    await visitor.goto(`/events/${EVENT.slug}`);
    await expect(
      visitor.locator("tr").filter({ hasText: GUARDED.name }),
    ).toContainText("Address refused");
  });

  await test.step("stopping a server that was reachable marks it unreachable, with its last success", async () => {
    const before = await awaitCheck(
      request,
      STUB_AUTH.name,
      (latest) => latest?.reachable === true,
    );

    await stopService("stub-server");
    const after = await awaitCheck(
      request,
      STUB_AUTH.name,
      (latest) => latest?.reachable === false,
    );
    // The entry does not forget that it used to work, which is what makes the flag
    // actionable rather than a state it might always have been in.
    expect(after.lastSuccessAt).toBe(before.lastSuccessAt);

    await visitor.goto(`/events/${EVENT.slug}`);
    await expect(
      visitor.locator("tr").filter({ hasText: STUB_AUTH.name }),
    ).toContainText("since");
  });

  await visitor.context().close();
  await serverOwner.context().close();
});
