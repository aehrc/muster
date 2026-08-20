/*
 * Copyright © 2026 Commonwealth Scientific and Industrial Research Organisation
 * (CSIRO) ABN 41 687 119 230. Licensed under the Apache License, Version 2.0.
 */

import { describe, expect, test } from "bun:test";

import { describeAge, formatDateRange, formatDay } from "./format.ts";

/**
 * Dates and ages, as a reader sees them.
 *
 * The clock arrives as an argument, so these are ordinary deterministic tests
 * rather than tests that pass only on the day they were written.
 */

describe("formatDay", () => {
  test("spells the month out", () => {
    expect(formatDay("2026-09-01")).toBe("1 September 2026");
    expect(formatDay("2026-12-31")).toBe("31 December 2026");
  });

  // Whatever the server sends reaches the screen; a day that is not a day is
  // shown as it arrived rather than as "Invalid Date".
  test("passes anything that is not a day straight through", () => {
    expect(formatDay("sometime")).toBe("sometime");
    expect(formatDay("2026-13-01")).toBe("2026-13-01");
  });
});

describe("formatDateRange", () => {
  test("shortens a range inside one month", () => {
    expect(formatDateRange("2026-09-01", "2026-09-03")).toBe(
      "1 to 3 September 2026",
    );
  });

  test("spells both ends when the range crosses a month", () => {
    expect(formatDateRange("2026-08-30", "2026-09-02")).toBe(
      "30 August 2026 to 2 September 2026",
    );
  });

  test("shows one day once", () => {
    expect(formatDateRange("2026-09-01", "2026-09-01")).toBe(
      "1 September 2026",
    );
  });
});

describe("describeAge", () => {
  const now = new Date("2026-08-18T12:00:00.000Z");

  // How stale an entry is, which is the whole point of recording a confirmation.
  test("counts back in the largest unit that fits", () => {
    expect(describeAge("2026-08-18T11:59:30.000Z", now)).toBe("just now");
    expect(describeAge("2026-08-18T11:55:00.000Z", now)).toBe("5 minutes ago");
    expect(describeAge("2026-08-18T11:00:00.000Z", now)).toBe("an hour ago");
    expect(describeAge("2026-08-18T09:00:00.000Z", now)).toBe("3 hours ago");
    expect(describeAge("2026-08-17T12:00:00.000Z", now)).toBe("yesterday");
    expect(describeAge("2026-08-14T12:00:00.000Z", now)).toBe("4 days ago");
  });

  // Past a month, the age stops being useful and the date starts being useful.
  test("gives the date once the age stops meaning anything", () => {
    expect(describeAge("2026-06-01T12:00:00.000Z", now)).toBe("on 1 June 2026");
  });

  test("says so when the instant cannot be read", () => {
    expect(describeAge("not an instant", now)).toBe("at an unknown time");
  });
});
