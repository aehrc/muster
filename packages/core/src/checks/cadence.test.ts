import { describe, expect, test } from "bun:test";

import {
  checkDue,
  checkIntervalMs,
  checkJitterMs,
  idleEventCheckIntervalMs,
  openEventCheckIntervalMs,
} from "./cadence.ts";

import type { EventStatus } from "@muster/contracts";

/**
 * The check cadence.
 *
 * SC-004 is a promise with a number in it: an unreachable server is flagged
 * within one check interval, and that interval is 15 minutes or less while an
 * event is open. The tests below hold the promise to its number, including the
 * part that is easy to get wrong - a jitter that spread the load by delaying
 * checks would quietly break the 15 minutes, so the jitter only ever brings a
 * check forward.
 */

/** Fifteen minutes, in milliseconds. */
const fifteenMinutes = 15 * 60 * 1000;

describe("checkIntervalMs", () => {
  // SC-004: 15 minutes or less during an event, and no more.
  test("checks an open event's entries at least every fifteen minutes", () => {
    expect(checkIntervalMs("open")).toBeLessThanOrEqual(fifteenMinutes);
    expect(openEventCheckIntervalMs).toBe(fifteenMinutes);
  });

  // Outside an open event nobody is waiting on the answer, so daily is enough.
  test.each<EventStatus>(["draft", "closed"])(
    "checks a %s event's entries daily",
    (status) => {
      expect(checkIntervalMs(status)).toBe(idleEventCheckIntervalMs);
      expect(idleEventCheckIntervalMs).toBe(24 * 60 * 60 * 1000);
    },
  );
});

describe("checkJitterMs", () => {
  // Stable per target: a restart must not move a target to a new slot, or the
  // spread would be re-randomised every deployment.
  test("gives one target the same jitter every time", () => {
    const first = checkJitterMs("enrolment-a", openEventCheckIntervalMs);
    const second = checkJitterMs("enrolment-a", openEventCheckIntervalMs);

    expect(first).toBe(second);
  });

  // Different targets land in different slots, which is the point of it.
  test("spreads different targets across the window", () => {
    const jitters = new Set(
      Array.from({ length: 20 }, (_unused, index) =>
        checkJitterMs(`enrolment-${String(index)}`, openEventCheckIntervalMs),
      ),
    );

    expect(jitters.size).toBeGreaterThan(10);
  });

  // The bound that keeps SC-004 true: the jitter is a fraction of the interval,
  // and it is never negative, so it can only bring a check forward.
  test("stays within a fifth of the interval", () => {
    for (let index = 0; index < 100; index += 1) {
      const jitter = checkJitterMs(
        `enrolment-${String(index)}`,
        openEventCheckIntervalMs,
      );

      expect(jitter).toBeGreaterThanOrEqual(0);
      expect(jitter).toBeLessThan(openEventCheckIntervalMs / 5);
    }
  });
});

describe("checkDue", () => {
  /** An arbitrary instant to measure from. */
  const now = new Date("2026-08-19T02:00:00.000Z");

  // An entry with no check at all is the worst thing to show a reader, so it is
  // checked at the first opportunity rather than one interval from now.
  test("is due at once for a target nothing has ever checked", () => {
    expect(
      checkDue({
        key: "enrolment-a",
        eventStatus: "open",
        lastCheckedAt: null,
        now,
      }),
    ).toBe(true);
  });

  test("is not due a minute after a check", () => {
    expect(
      checkDue({
        key: "enrolment-a",
        eventStatus: "open",
        lastCheckedAt: new Date(now.getTime() - 60_000),
        now,
      }),
    ).toBe(false);
  });

  // SC-004 again, from the caller's side: whatever the target's jitter, fifteen
  // minutes after a check it is due.
  test("is due for every open-event target fifteen minutes after a check", () => {
    for (let index = 0; index < 100; index += 1) {
      expect(
        checkDue({
          key: `enrolment-${String(index)}`,
          eventStatus: "open",
          lastCheckedAt: new Date(now.getTime() - fifteenMinutes),
          now,
        }),
      ).toBe(true);
    }
  });

  // A closed event's entry waits a day, so a scheduler pass does not spend the
  // outbound budget re-checking last year's connectathon.
  test("is not due for a closed event's target after fifteen minutes", () => {
    const facts = {
      key: "enrolment-a",
      eventStatus: "closed",
      lastCheckedAt: new Date(now.getTime() - fifteenMinutes),
      now,
    } as const;

    expect(checkDue(facts)).toBe(false);
    expect(
      checkDue({
        ...facts,
        lastCheckedAt: new Date(now.getTime() - idleEventCheckIntervalMs),
      }),
    ).toBe(true);
  });
});
