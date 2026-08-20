/*
 * Copyright © 2026 Commonwealth Scientific and Industrial Research Organisation
 * (CSIRO) ABN 41 687 119 230. Licensed under the Apache License, Version 2.0.
 */

import { expect, test } from "@playwright/test";

import {
  addSystem,
  approve,
  createOrganisation,
  enrol,
  signIn,
  signOut,
  signUp,
} from "./support/console.ts";
import {
  admin,
  dataHolderUrl,
  eventSlug,
  participantAddress,
  unique,
} from "./support/stack.ts";

import type { Account } from "./support/console.ts";
import type { APIRequestContext } from "@playwright/test";

/**
 * Quickstart scenario 5: liveness checks, drift, and a refused address.
 *
 * Three entries are enrolled at once and then left to the scheduler, because the
 * point of these checks is that nobody asks for them: the entry that declares a
 * token endpoint the server does not advertise is flagged as drifted with both
 * values named (FR-018), the entry nothing is listening on is flagged
 * unreachable, and the entry on a private address is refused by the guard with
 * its reason and no request made (FR-020).
 *
 * The scheduler ticks once a minute and an entry nothing has checked is due at
 * once, so the assertions poll rather than wait a fixed time. Stopping a stub
 * mid-run - the quickstart's way of showing "unreachable with the last successful
 * check time" - is left out deliberately: it would tie the suite to the container
 * runtime, and an entry that was never reachable exercises the same reporting.
 *
 * @author John Grimes
 */

/** Declares a token endpoint the stub does not advertise. */
const driftingName = `Drifting Server ${unique("server")}`;

/** A host that does not resolve, so the check cannot reach it. */
const silentName = `Unreachable Server ${unique("server")}`;

/** A private address, which the guard refuses without making a request. */
const guardedName = `Internal Server ${unique("server")}`;

/**
 * How long the assertions wait for the scheduler's next pass.
 *
 * A pass covers every entry that is due and probes them one at a time, and a tick
 * that arrives while a pass is running is dropped, so a stack carrying entries
 * from earlier runs of this suite can take more than one interval to reach the
 * entries this file just made. Four ticks is ample for a freshly seeded stack and
 * tolerant of one that is not.
 */
const schedulerTimeout = 240_000;

let serverOwner: Account;

test.use({ extraHTTPHeaders: { "x-forwarded-for": participantAddress() } });
// The scheduler's pass is on a one-minute interval, so these tests wait longer
// than a test that only drives the console.
test.describe.configure({ mode: "serial", timeout: schedulerTimeout + 30_000 });

/** One entry's latest check, as the public API reports it. */
type EntryCheck = {
  /** whether the last check reached it */
  readonly reachable: boolean;
  /** how it failed, when it did */
  readonly failureMode: string | null;
  /** the reason, in words */
  readonly detail: string | null;
  /** the disagreements found */
  readonly driftFlags: {
    /** the field that disagrees */
    readonly field: string;
    /** what the entry declares */
    readonly declared: string;
    /** what the server advertises */
    readonly advertised: string | null;
  }[];
};

/**
 * Reads one entry's latest check from the public event API.
 *
 * @param request - the request context to read with
 * @param name - the system's name
 * @returns the check, or null when nothing has checked it yet
 */
const checkOf = async (
  request: APIRequestContext,
  name: string,
): Promise<EntryCheck | null> => {
  const response = await request.get(`/api/events/${eventSlug}/systems`);
  // An answer that is not the event's systems is worth another attempt rather
  // than an immediate failure: this runs inside a poll, and throwing here would
  // turn a moment's trouble into a verdict about the scheduler.
  if (!response.ok()) {
    return null;
  }
  const body = (await response.json()) as {
    systems?: {
      system: { name: string };
      check: { latest: EntryCheck } | null;
    }[];
  };
  const entry = (body.systems ?? []).find((held) => held.system.name === name);
  return entry?.check?.latest ?? null;
};

test("enrols three servers the checks will have something to say about", async ({
  page,
}) => {
  serverOwner = await signUp(page, "serverowner");
  await signIn(page, admin.email, admin.password);
  await approve(page, serverOwner);

  await signIn(page, serverOwner.email);
  await createOrganisation(page, `Checked Vendor ${unique("org")}`);

  // The data holder stub advertises its own token endpoint; this entry declares
  // a different one, which is what drift is.
  await addSystem(page, {
    name: driftingName,
    server: {
      fhirBaseUrl: `${dataHolderUrl}/fhir`,
      tokenEndpoint: `${dataHolderUrl}/oauth2/token`,
    },
  });
  await enrol(page, driftingName);

  // A host that does not resolve. A silent port on an allowlisted host would do
  // as well, but only by naming a second port in the stack's allowlist for the
  // sake of a test; a name that goes nowhere is the same reporting path and is
  // also what a typo looks like.
  await addSystem(page, {
    name: silentName,
    server: { fhirBaseUrl: "https://nowhere.invalid/fhir" },
  });
  await enrol(page, silentName);

  // A private address: refused by the guard, with nothing sent.
  await addSystem(page, {
    name: guardedName,
    server: { fhirBaseUrl: "https://10.1.2.3/fhir" },
  });
  await enrol(page, guardedName);
});

test("flags the drifting entry, naming both values", async ({ request }) => {
  await expect
    .poll(
      async () => (await checkOf(request, driftingName))?.driftFlags ?? [],
      {
        timeout: schedulerTimeout,
        message: "the scheduler had not yet checked the drifting entry",
      },
    )
    .not.toHaveLength(0);

  const check = await checkOf(request, driftingName);
  expect(check?.reachable).toBe(true);
  const flag = check?.driftFlags.find((held) => held.field === "tokenEndpoint");
  expect(flag?.declared).toBe(`${dataHolderUrl}/oauth2/token`);
  // FR-018: the flag names what the server actually advertises, not just that
  // something differs.
  expect(flag?.advertised).toContain("/token");
  expect(flag?.advertised).not.toBe(flag?.declared);
});

test("shows the drift on the public event view", async ({ page }) => {
  await signOut(page);
  await page.goto(`/events/${eventSlug}`);
  const entry = page.locator("article").filter({ hasText: driftingName });

  // Exactly "Drift": the entry's own name contains the word too.
  await expect(entry.getByText("Drift", { exact: true })).toBeVisible();
  await expect(entry.getByText(/Declares the token endpoint as/)).toBeVisible();
});

test("flags the entry that cannot be reached", async ({ request }) => {
  await expect
    .poll(async () => (await checkOf(request, silentName))?.failureMode, {
      timeout: schedulerTimeout,
      message: "the scheduler had not yet checked the silent entry",
    })
    .not.toBeUndefined();

  const check = await checkOf(request, silentName);
  expect(check?.reachable).toBe(false);
  // The reason is recorded, so a reader is told what happened rather than shown
  // a blank (FR-017).
  expect(check?.detail).not.toBeNull();
});

test("refuses the private address and says so", async ({ request }) => {
  await expect
    .poll(async () => (await checkOf(request, guardedName))?.failureMode, {
      timeout: schedulerTimeout,
      message: "the scheduler had not yet checked the guarded entry",
    })
    .toBe("guarded");

  const check = await checkOf(request, guardedName);
  expect(check?.reachable).toBe(false);
  // Muster's own refusal, naming the address and why: never reported as the
  // server being down (FR-020).
  expect(check?.detail).toContain("10.1.2.3");
  expect(check?.detail).toContain("private");
});

test("shows the refusal on the public event view", async ({ page }) => {
  await signOut(page);
  await page.goto(`/events/${eventSlug}`);
  const entry = page.locator("article").filter({ hasText: guardedName });

  await expect(entry.getByText("Refused")).toBeVisible();
});
