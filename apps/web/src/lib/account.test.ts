/*
 * Copyright © 2026 Commonwealth Scientific and Industrial Research Organisation
 * (CSIRO) ABN 41 687 119 230. Licensed under the Apache License, Version 2.0.
 */

import { describe, expect, test } from "bun:test";

import { mayActFor, standingFor } from "./account.ts";

import type { AccountView, SessionView } from "@muster/contracts";

/**
 * What the console tells a member about where they stand, and what it lets them
 * try.
 *
 * The rules themselves live in `@muster/core` and are tested there; what is
 * tested here is that the console asks them rather than guessing, so a pending
 * account is told it is pending (acceptance scenario 1) instead of being shown
 * forms that the server will refuse.
 */

const account = (partial: Partial<AccountView> = {}): AccountView => ({
  id: "acc-1",
  email: "member@example.org",
  displayName: "A Member",
  status: "approved",
  emailVerified: true,
  isAdmin: false,
  ...partial,
});

const session = (
  partial: Partial<AccountView> = {},
  memberships: SessionView["memberships"] = [],
): SessionView => ({ account: account(partial), memberships });

describe("standingFor", () => {
  // The directory is readable without an account, and the console says so
  // rather than presenting an anonymous visitor with a refusal.
  test("invites an anonymous visitor to sign in without calling it a problem", () => {
    const standing = standingFor(null);

    expect(standing.canWrite).toBe(false);
    expect(standing.canAdminister).toBe(false);
    expect(standing.tone).toBe("info");
    expect(standing.detail).toMatch(/without an account/i);
  });

  // Acceptance scenario 1: verified but not yet approved, and the account has
  // to be able to see that this is where it is.
  test("tells a pending account that it is awaiting approval", () => {
    const standing = standingFor(session({ status: "pending" }));

    expect(standing.canWrite).toBe(false);
    expect(standing.tone).toBe("warning");
    expect(standing.headline).toMatch(/awaiting approval/i);
    expect(standing.detail).toMatch(/track admin/i);
  });

  test("tells an unverified account to use its verification link", () => {
    const standing = standingFor(
      session({ status: "approved", emailVerified: false }),
    );

    expect(standing.canWrite).toBe(false);
    expect(standing.tone).toBe("warning");
    expect(standing.headline).toMatch(/not verified/i);
    expect(standing.detail).toMatch(/verification link/i);
  });

  // Acceptance scenario 8: a revoked account can still read, and is told why it
  // can no longer write.
  test("tells a revoked account that its membership was revoked", () => {
    const standing = standingFor(session({ status: "revoked" }));

    expect(standing.canWrite).toBe(false);
    expect(standing.canAdminister).toBe(false);
    expect(standing.tone).toBe("error");
    expect(standing.headline).toMatch(/revoked/i);
  });

  test("grants an approved, verified member its standing membership", () => {
    const standing = standingFor(session());

    expect(standing.canWrite).toBe(true);
    expect(standing.canAdminister).toBe(false);
    expect(standing.tone).toBe("success");
    expect(standing.headline).toMatch(/approved/i);
  });

  // FR-004: the admin role is distinct from ordinary membership.
  test("distinguishes a track admin from an ordinary member", () => {
    const standing = standingFor(session({ isAdmin: true }));

    expect(standing.canWrite).toBe(true);
    expect(standing.canAdminister).toBe(true);
    expect(standing.headline).toMatch(/admin/i);
  });

  // A revoked admin is not an admin: the flag does not substitute for approval.
  test("refuses administration to a revoked account that holds the flag", () => {
    expect(
      standingFor(session({ isAdmin: true, status: "revoked" })).canAdminister,
    ).toBe(false);
  });
});

describe("mayActFor", () => {
  const memberships = [{ organisationId: "org-1", name: "MediRecords" }];

  // FR-005: every member of an organisation manages its systems, and nobody
  // else does.
  test("permits a member to act for its own organisation only", () => {
    const signedIn = session({}, memberships);

    expect(mayActFor(signedIn, "org-1")).toBe(true);
    expect(mayActFor(signedIn, "org-2")).toBe(false);
  });

  test("refuses an account that may not write at all", () => {
    expect(
      mayActFor(session({ status: "pending" }, memberships), "org-1"),
    ).toBe(false);
  });

  test("refuses an anonymous visitor", () => {
    expect(mayActFor(null, "org-1")).toBe(false);
  });
});
