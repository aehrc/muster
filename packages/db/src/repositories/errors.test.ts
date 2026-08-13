/**
 * Recognising a Postgres error without a Postgres.
 *
 * These predicates decide whether a failed insert is a domain outcome - "that address is
 * already held" - or a fault. Getting them wrong in either direction is bad in a way a test
 * against a real database would not catch reliably: too loose, and an unrelated constraint
 * violation is reported to a participant as a taken address; too strict, and a duplicate
 * sign-up becomes a 500.
 *
 * The wrapping is the part worth exercising. Drizzle wraps the driver's error, and a pooling or
 * serialisation boundary may wrap that, so the predicates walk the `cause` chain - and a chain
 * they walked too far or not far enough would fail exactly here.
 *
 * Author: John Grimes
 */

import { describe, expect, it } from "bun:test";

import {
  CHECK_VIOLATION,
  isCheckViolation,
  isUniqueViolation,
  UNIQUE_VIOLATION,
} from "./errors.js";

/** An error shaped like the driver's, optionally wrapped the way Drizzle wraps one. */
function pgError(code: string, constraint: string, depth = 0): unknown {
  let error: unknown = Object.assign(new Error("boom"), {
    code,
    constraint_name: constraint,
  });
  for (let wrap = 0; wrap < depth; wrap += 1) {
    error = Object.assign(new Error("wrapped"), { cause: error });
  }
  return error;
}

describe("isUniqueViolation", () => {
  it("recognises a unique violation of the named constraint", () => {
    expect(
      isUniqueViolation(
        pgError(UNIQUE_VIOLATION, "account_email_unique"),
        "account_email_unique",
      ),
    ).toBe(true);
  });

  it("recognises one through the layers that wrap it", () => {
    // Drizzle wraps the driver's error; a pool or a serialisation boundary may wrap that.
    for (const depth of [1, 2, 3]) {
      expect(
        isUniqueViolation(
          pgError(UNIQUE_VIOLATION, "account_email_unique", depth),
          "account_email_unique",
        ),
      ).toBe(true);
    }
  });

  it("gives up rather than following an unbounded chain", () => {
    // A chain deeper than the layers that exist is more likely circular than informative.
    expect(
      isUniqueViolation(
        pgError(UNIQUE_VIOLATION, "account_email_unique", 5),
        "account_email_unique",
      ),
    ).toBe(false);
  });

  it("refuses a violation of a different constraint", () => {
    // The failure this prevents: a collision on something else reported to a participant as
    // a taken address.
    expect(
      isUniqueViolation(
        pgError(UNIQUE_VIOLATION, "enrolment_event_id_system_id_unique"),
        "account_email_unique",
      ),
    ).toBe(false);
  });

  it("accepts any constraint when none is named", () => {
    expect(isUniqueViolation(pgError(UNIQUE_VIOLATION, "anything"))).toBe(true);
  });

  it("refuses anything that is not a unique violation", () => {
    expect(
      isUniqueViolation(pgError(CHECK_VIOLATION, "system_has_a_profile")),
    ).toBe(false);
    expect(isUniqueViolation(new Error("plain"))).toBe(false);
    expect(isUniqueViolation("not an error")).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
  });
});

describe("isCheckViolation", () => {
  it("recognises a check violation of the named constraint", () => {
    expect(
      isCheckViolation(
        pgError(CHECK_VIOLATION, "system_has_a_profile", 1),
        "system_has_a_profile",
      ),
    ).toBe(true);
  });

  it("refuses a unique violation, and a different check", () => {
    expect(
      isCheckViolation(pgError(UNIQUE_VIOLATION, "system_has_a_profile")),
    ).toBe(false);
    expect(
      isCheckViolation(
        pgError(CHECK_VIOLATION, "event_dates_ordered"),
        "system_has_a_profile",
      ),
    ).toBe(false);
  });
});
