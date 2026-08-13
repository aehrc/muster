/**
 * The rules that decide whether an account may do anything at all.
 *
 * These are the deny-by-default rules, so the tests are mostly about refusals. Three
 * of them are the ones that would be found in production rather than here: an account
 * that verified its address but was never approved must not be able to create content
 * (FR-002); a revoked account must lose that ability again (scenario 8); and a
 * verification token must work exactly once and not after its expiry (spec edge case).
 *
 * Author: John Grimes
 */

import { describe, expect, it } from "bun:test";

import {
  accountTokenRefusal,
  canChangeAccountStatus,
  canWrite,
  foldEmail,
  VERIFICATION_TOKEN_TTL_MS,
  verificationExpiry,
  writeRefusal,
} from "./rules.js";

import type { AccountStatus } from "./rules.js";

const VERIFIED = new Date("2026-08-13T00:00:00.000Z");

/** An account standing, with the parts a test cares about named. */
function standing(status: AccountStatus, verified: boolean) {
  return { status, emailVerifiedAt: verified ? VERIFIED : null };
}

describe("writeRefusal", () => {
  it("admits an approved account that has verified its address", () => {
    expect(writeRefusal(standing("approved", true))).toBeUndefined();
    expect(canWrite(standing("approved", true))).toBe(true);
  });

  it("refuses an approved account that has not verified its address", () => {
    // FR-001: control of the address is proven before the account can be used, so
    // approval alone is not enough.
    expect(writeRefusal(standing("approved", false))).toBe("email_unverified");
    expect(canWrite(standing("approved", false))).toBe(false);
  });

  it("refuses a verified account that is still awaiting approval", () => {
    // Scenario 1: the account remains unable to create or edit content until an admin
    // approves it.
    expect(writeRefusal(standing("pending", true))).toBe("awaiting_approval");
    expect(canWrite(standing("pending", true))).toBe(false);
  });

  it("refuses a revoked account", () => {
    // Scenario 8: revocation stops content edits and every vouching action.
    expect(writeRefusal(standing("revoked", true))).toBe("revoked_member");
    expect(canWrite(standing("revoked", true))).toBe(false);
  });

  it("reports revocation ahead of an unverified address", () => {
    // A revoked account is not one verification away from writing, and telling its
    // holder to check their email would be misdirection.
    expect(writeRefusal(standing("revoked", false))).toBe("revoked_member");
  });

  it("reports an unverified address ahead of pending approval", () => {
    // Both are true of a fresh sign-up. Verification is the half the holder can act
    // on, so it is the half they are told about.
    expect(writeRefusal(standing("pending", false))).toBe("email_unverified");
  });
});

describe("canChangeAccountStatus", () => {
  it("admits the transitions the data model names", () => {
    expect(canChangeAccountStatus("pending", "approved")).toBe(true);
    expect(canChangeAccountStatus("approved", "revoked")).toBe(true);
    // Re-instatement: approval is standing, and a revocation can be undone.
    expect(canChangeAccountStatus("revoked", "approved")).toBe(true);
  });

  it("refuses a transition to the status the account already holds", () => {
    // An approve on an already-approved account would otherwise overwrite the
    // approval audit and send a second notification.
    for (const status of ["pending", "approved", "revoked"] as const) {
      expect(canChangeAccountStatus(status, status)).toBe(false);
    }
  });

  it("refuses every transition the data model does not name", () => {
    // Notably pending -> revoked: the data model has no such transition, so there is
    // no "reject" action. A bogus sign-up is left pending rather than revoked.
    expect(canChangeAccountStatus("pending", "revoked")).toBe(false);
    expect(canChangeAccountStatus("approved", "pending")).toBe(false);
    expect(canChangeAccountStatus("revoked", "pending")).toBe(false);
  });
});

describe("accountTokenRefusal", () => {
  const issuedAt = new Date("2026-08-13T09:00:00.000Z");
  const expiresAt = verificationExpiry(issuedAt);

  it("admits an unused token inside its validity", () => {
    expect(
      accountTokenRefusal(
        { expiresAt, usedAt: null },
        new Date("2026-08-13T10:00:00.000Z"),
      ),
    ).toBeUndefined();
  });

  it("refuses a token that has already been redeemed", () => {
    // The edge case: a verification link used twice. The second use fails, and the
    // route turns this into an offer to resend.
    expect(
      accountTokenRefusal(
        { expiresAt, usedAt: new Date("2026-08-13T09:30:00.000Z") },
        new Date("2026-08-13T10:00:00.000Z"),
      ),
    ).toBe("token_used");
  });

  it("refuses a token past its expiry", () => {
    expect(
      accountTokenRefusal(
        { expiresAt, usedAt: null },
        new Date("2026-08-14T09:00:01.000Z"),
      ),
    ).toBe("token_expired");
  });

  it("refuses a token at the instant it expires", () => {
    // The boundary is closed against the holder: a token whose expiry is now has no
    // validity left, and admitting it would make the stated lifetime an approximation.
    expect(accountTokenRefusal({ expiresAt, usedAt: null }, expiresAt)).toBe(
      "token_expired",
    );
  });

  it("reports redemption ahead of expiry", () => {
    // A used token that has also expired is a used token: "resend" is the right offer
    // either way, but "already used" is the accurate description.
    expect(
      accountTokenRefusal(
        { expiresAt, usedAt: new Date("2026-08-13T09:30:00.000Z") },
        new Date("2026-08-20T00:00:00.000Z"),
      ),
    ).toBe("token_used");
  });
});

describe("verificationExpiry", () => {
  it("expires a verification link twenty-four hours after it was issued", () => {
    // The sign-in wireframe tells the reader links expire after 24 hours, so the
    // constant and the message have to agree.
    expect(VERIFICATION_TOKEN_TTL_MS).toBe(24 * 60 * 60 * 1000);
    expect(verificationExpiry(new Date("2026-08-13T09:00:00.000Z"))).toEqual(
      new Date("2026-08-14T09:00:00.000Z"),
    );
  });
});

describe("foldEmail", () => {
  it("folds case and trims surrounding whitespace", () => {
    // The account table's uniqueness is on the folded form, so two sign-ups differing
    // only in case are one account rather than two.
    expect(foldEmail("  Jo.Chen@CSIRO.AU ")).toBe("jo.chen@csiro.au");
  });

  it("leaves an already-folded address alone", () => {
    expect(foldEmail("jo.chen@csiro.au")).toBe("jo.chen@csiro.au");
  });

  it("folds the case of non-ASCII addresses too", () => {
    // `toLowerCase` rather than a locale-sensitive fold: the comparison has to be the
    // same in every process that performs it, and Postgres is one of them.
    expect(foldEmail("JOSÉ@Example.ORG")).toBe("josé@example.org");
  });
});
