/**
 * Waiting for the verification and coverage scheduler.
 *
 * The passes run on an in-process interval, so a spec that enrols a server and immediately
 * asks the event view what it found would be asking too early. Rather than sleeping for a
 * guessed period, these poll the public JSON API - which the constitution requires to be fed
 * by the same data as the views - until the answer is the one the scenario is about, and
 * leave the spec to assert what the *page* then says.
 *
 * Polling the API rather than the page is not a shortcut around the UI. It is the difference
 * between "reload this page thirty times and hope" and one assertion against a rendered page
 * that is known to have something to render.
 *
 * Every wait takes the condition it is waiting for rather than returning the first answer
 * that arrives. The scenarios change the stack underneath these - a stub is stopped, another
 * is recreated - so "there is a result" and "there is the result this scenario is about" are
 * different questions, and asking the first one produces a suite that passes or fails on
 * timing.
 *
 * Author: John Grimes
 */

import { expect } from "@playwright/test";

import { EVENT } from "./stack.js";

import type { APIRequestContext } from "@playwright/test";

/** One disagreement between what an entry declares and what its server advertises. */
export interface DriftFlag {
  readonly field: string;
  readonly declared: string;
  readonly advertised: string;
}

/** The latest check against one enrolled server, as the public API reports it. */
export interface CheckSummary {
  readonly checkedAt: string;
  readonly reachable: boolean;
  readonly failureMode: string | null;
  readonly detail: string | null;
  readonly driftFlags: readonly DriftFlag[];
  readonly lastSuccessAt: string | null;
  readonly permissionTicketTypesSupported: readonly string[];
}

/** One cell of the coverage grid. */
export interface CoverageCell {
  readonly enrolmentId: string;
  readonly outcome: "found" | "missing" | "unverifiable";
  readonly detail: string | null;
}

/** One enrolled system in the event listing. */
interface EnrolledSystem {
  readonly name: string;
  readonly check: CheckSummary | null;
}

/** The public persona document: the personas, the server columns, and the cells. */
interface PersonaGrid {
  readonly servers: readonly { enrolmentId: string; systemName: string }[];
  readonly coverage: readonly CoverageCell[];
}

/**
 * How long to keep asking.
 *
 * Long: the stack checks every minute and looks four times an interval, and an entry that has
 * to be checked *and then re-checked* after something changed waits for both.
 */
const SCHEDULER_TIMEOUT_MS = 240_000;

/**
 * Polls a reader until what it returns satisfies a condition.
 *
 * @param what - What is being waited for, for the failure message.
 * @param read - Fetches the current answer, or undefined when there is none yet.
 * @param settled - Whether that answer is the one to stop on.
 * @returns The answer that satisfied it.
 * @throws {Error} When nothing does in time.
 */
async function awaitSettled<T>(
  what: string,
  read: () => Promise<T | undefined>,
  settled: (answer: T | undefined) => boolean,
): Promise<T> {
  await expect
    .poll(async () => settled(await read()), {
      timeout: SCHEDULER_TIMEOUT_MS,
      intervals: [2000],
      message: `${what} never settled the way this scenario needs`,
    })
    .toBe(true);
  const answer = await read();
  if (answer === undefined) {
    throw new Error(`${what} disappeared between polls`);
  }
  return answer;
}

/**
 * Waits until the latest check against one enrolled server satisfies a condition.
 *
 * @param request - Playwright's request context, which needs no session: the listing is
 *   public.
 * @param systemName - The enrolled system, by the name the listing carries.
 * @param settled - What the check has to say for the wait to be over. It is given `undefined`
 *   until a check has run at all, because "not checked yet" and "checked and unreachable"
 *   are different answers.
 * @returns The check that satisfied it.
 * @throws {Error} When nothing satisfies it in time.
 * @example
 * ```ts
 * await awaitCheck(request, DRIFTING.name, (c) => (c?.driftFlags.length ?? 0) > 0);
 * ```
 */
export async function awaitCheck(
  request: APIRequestContext,
  systemName: string,
  settled: (check: CheckSummary | undefined) => boolean,
): Promise<CheckSummary> {
  return await awaitSettled(
    `The scheduler's latest check against ${systemName}`,
    async () => {
      const response = await request.get(`/api/events/${EVENT.slug}/systems`);
      const body = (await response.json()) as { systems: EnrolledSystem[] };
      const found = body.systems.find((system) => system.name === systemName);
      return found?.check ?? undefined;
    },
    settled,
  );
}

/**
 * Waits until the coverage pass says something about one server that satisfies a condition.
 *
 * @param request - Playwright's request context; the grid is public.
 * @param systemName - The enrolled server, by name.
 * @param settled - What the cell has to say for the wait to be over.
 * @returns The cell that satisfied it.
 * @throws {Error} When nothing satisfies it in time.
 * @example
 * ```ts
 * await awaitCoverage(request, MEDIRECORDS.name, (cell) => cell?.outcome === "found");
 * ```
 */
export async function awaitCoverage(
  request: APIRequestContext,
  systemName: string,
  settled: (cell: CoverageCell | undefined) => boolean,
): Promise<CoverageCell> {
  return await awaitSettled(
    `The coverage pass's verdict on ${systemName}`,
    async () => {
      const response = await request.get(`/api/events/${EVENT.slug}/personas`);
      const grid = (await response.json()) as PersonaGrid;
      const column = grid.servers.find(
        (server) => server.systemName === systemName,
      );
      return grid.coverage.find(
        (cell) => cell.enrolmentId === column?.enrolmentId,
      );
    },
    settled,
  );
}
