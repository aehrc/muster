/*
 * Copyright © 2026 Commonwealth Scientific and Industrial Research Organisation
 * (CSIRO) ABN 41 687 119 230. Licensed under the Apache License, Version 2.0.
 */

import { describe, expect, test } from "bun:test";

import {
  applyStatusChange,
  authoriseAdmin,
  authoriseEventOpen,
  authoriseMembership,
  authoriseToken,
  authoriseVerificationResend,
  authoriseWrite,
  verificationTokenLifetimeMs,
} from "./rules.ts";

import type { AccountFacts, TokenFacts } from "./rules.ts";

/**
 * The account rules decide who may change anything in Muster, and they decide
 * it without a database, a clock or a request. Deny by default is the whole
 * point: a right is granted only when every condition is affirmatively true.
 */

const verified = new Date("2026-08-01T00:00:00Z");

// Builds an account, approved and verified unless a test says otherwise.
const account = (overrides: Partial<AccountFacts> = {}): AccountFacts => ({
  status: "approved",
  emailVerifiedAt: verified,
  isAdmin: false,
  ...overrides,
});

// Builds an unused, unexpired token.
const token = (overrides: Partial<TokenFacts> = {}): TokenFacts => ({
  expiresAt: new Date("2026-08-02T00:00:00Z"),
  usedAt: null,
  ...overrides,
});

describe("write rights", () => {
  // An approved account with a verified address is the only one that may write.
  test("grants an approved, verified account the right to write", () => {
    expect(authoriseWrite(account())).toEqual({ ok: true });
  });

  // FR-002: a new account is held with no create or edit rights until approved.
  test("refuses a pending account", () => {
    const decision = authoriseWrite(account({ status: "pending" }));

    expect(decision.ok).toBe(false);
    expect(decision.ok === false && decision.refusal.reason).toBe(
      "not_approved",
    );
    expect(decision.ok === false && decision.refusal.detail).toContain(
      "awaiting approval",
    );
  });

  // FR-002: revocation takes the rights away again.
  test("refuses a revoked account", () => {
    const decision = authoriseWrite(account({ status: "revoked" }));

    expect(decision.ok).toBe(false);
    expect(decision.ok === false && decision.refusal.reason).toBe("revoked");
  });

  // FR-001: control of the address must be proven before the account is usable,
  // so an approved account with an unverified address still cannot write.
  test("refuses an approved account whose address is unverified", () => {
    const decision = authoriseWrite(account({ emailVerifiedAt: null }));

    expect(decision.ok).toBe(false);
    expect(decision.ok === false && decision.refusal.reason).toBe(
      "not_verified",
    );
  });
});

describe("admin rights", () => {
  // FR-004: the admin role is distinct from ordinary membership.
  test("grants an approved, verified admin", () => {
    expect(authoriseAdmin(account({ isAdmin: true }))).toEqual({ ok: true });
  });

  test("refuses an approved member who is not an admin", () => {
    const decision = authoriseAdmin(account());

    expect(decision.ok).toBe(false);
    expect(decision.ok === false && decision.refusal.reason).toBe("not_admin");
  });

  // The admin flag does not substitute for approval or verification.
  test("refuses an admin whose account is revoked", () => {
    const decision = authoriseAdmin(
      account({ isAdmin: true, status: "revoked" }),
    );

    expect(decision.ok).toBe(false);
    expect(decision.ok === false && decision.refusal.reason).toBe("revoked");
  });

  test("refuses an admin whose address is unverified", () => {
    const decision = authoriseAdmin(
      account({ isAdmin: true, emailVerifiedAt: null }),
    );

    expect(decision.ok).toBe(false);
    expect(decision.ok === false && decision.refusal.reason).toBe(
      "not_verified",
    );
  });
});

describe("status transitions", () => {
  // The three transitions the data model states, and nothing else.
  test("approves a pending account", () => {
    expect(applyStatusChange("pending", "approve")).toEqual({
      ok: true,
      status: "approved",
    });
  });

  test("revokes an approved account", () => {
    expect(applyStatusChange("approved", "revoke")).toEqual({
      ok: true,
      status: "revoked",
    });
  });

  test("reinstates a revoked account", () => {
    expect(applyStatusChange("revoked", "approve")).toEqual({
      ok: true,
      status: "approved",
    });
  });

  // Approving twice is not a silent no-op: the admin is told the account is
  // already approved rather than being shown a second approval email.
  test("refuses to approve an already approved account", () => {
    const result = applyStatusChange("approved", "approve");

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.refusal.reason).toBe(
      "illegal_transition",
    );
    expect(result.ok === false && result.refusal.detail).toContain(
      "already approved",
    );
  });

  // A pending account has nothing to revoke; the admin leaves it pending.
  test("refuses to revoke a pending account", () => {
    const result = applyStatusChange("pending", "revoke");

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.refusal.reason).toBe(
      "illegal_transition",
    );
  });

  test("refuses to revoke an already revoked account", () => {
    const result = applyStatusChange("revoked", "revoke");

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.refusal.reason).toBe(
      "illegal_transition",
    );
  });
});

describe("verification tokens", () => {
  const now = new Date("2026-08-01T12:00:00Z");

  test("accepts an unused token before its expiry", () => {
    expect(authoriseToken(token(), now)).toEqual({ ok: true });
  });

  // Edge case in the spec: the link is used twice. The second use fails.
  test("refuses a token that has already been used", () => {
    const decision = authoriseToken(
      token({ usedAt: new Date("2026-08-01T11:00:00Z") }),
      now,
    );

    expect(decision.ok).toBe(false);
    expect(decision.ok === false && decision.refusal.reason).toBe("token_used");
    expect(decision.ok === false && decision.refusal.detail).toContain(
      "already been used",
    );
  });

  // Edge case in the spec: the link is used after expiry.
  test("refuses a token past its expiry", () => {
    const decision = authoriseToken(
      token({ expiresAt: new Date("2026-08-01T11:59:59Z") }),
      now,
    );

    expect(decision.ok).toBe(false);
    expect(decision.ok === false && decision.refusal.reason).toBe(
      "token_expired",
    );
  });

  // The boundary belongs to the holder: a token expiring exactly now is spent.
  test("refuses a token expiring at the current instant", () => {
    const decision = authoriseToken(token({ expiresAt: now }), now);

    expect(decision.ok).toBe(false);
    expect(decision.ok === false && decision.refusal.reason).toBe(
      "token_expired",
    );
  });

  // A used token is refused as used even when it has also expired, because that
  // is the more informative of the two answers.
  test("reports a used token as used even when it has also expired", () => {
    const decision = authoriseToken(
      token({
        usedAt: new Date("2026-07-31T00:00:00Z"),
        expiresAt: new Date("2026-07-31T01:00:00Z"),
      }),
      now,
    );

    expect(decision.ok === false && decision.refusal.reason).toBe("token_used");
  });

  // The lifetime is a rule, not a deployment knob: a verification link that
  // lives for a day is long enough to find in a mail client and short enough
  // that a leaked link is not a standing key.
  test("states a verification lifetime of one day", () => {
    expect(verificationTokenLifetimeMs).toBe(24 * 60 * 60 * 1000);
  });
});

describe("resending a verification link", () => {
  // The spec's edge case leaves an account whose link lapsed with an offer to
  // resend, and the token lives a day, so the offer has to work for an account
  // that is unverified whatever else is true of it - pending approval, or even
  // revoked, since a revocation can be reversed and the address is still theirs.
  test("permits a resend for an account whose address is unverified", () => {
    expect(
      authoriseVerificationResend(account({ emailVerifiedAt: null })).ok,
    ).toBe(true);
    expect(
      authoriseVerificationResend(
        account({ emailVerifiedAt: null, status: "pending" }),
      ).ok,
    ).toBe(true);
    expect(
      authoriseVerificationResend(
        account({ emailVerifiedAt: null, status: "revoked" }),
      ).ok,
    ).toBe(true);
  });

  // An address already proved needs no new link, and minting one anyway would
  // mail a live token to an account that has no use for it.
  test("refuses a resend for an address already verified", () => {
    const decision = authoriseVerificationResend(account());

    expect(decision.ok).toBe(false);
    expect(decision.ok === false && decision.refusal.reason).toBe(
      "already_verified",
    );
    expect(decision.ok === false && decision.refusal.detail).toContain(
      "already verified",
    );
  });
});

describe("organisation membership", () => {
  const organisation = "4f2b1c8e-0000-4000-8000-000000000001";
  const other = "4f2b1c8e-0000-4000-8000-000000000002";

  // FR-005: every member of an organisation manages its systems.
  test("grants a member of the organisation", () => {
    expect(
      authoriseMembership(account(), [other, organisation], organisation),
    ).toEqual({ ok: true });
  });

  // Belonging to some organisation is not belonging to this one.
  test("refuses an approved member of a different organisation", () => {
    const decision = authoriseMembership(account(), [other], organisation);

    expect(decision.ok).toBe(false);
    expect(decision.ok === false && decision.refusal.reason).toBe("not_member");
  });

  test("refuses an account belonging to no organisation", () => {
    const decision = authoriseMembership(account(), [], organisation);

    expect(decision.ok === false && decision.refusal.reason).toBe("not_member");
  });

  // Membership does not survive revocation: the write rights are checked first,
  // so a revoked member of the organisation is told why, not that they are a
  // stranger to it.
  test("refuses a revoked member of the organisation", () => {
    const decision = authoriseMembership(
      account({ status: "revoked" }),
      [organisation],
      organisation,
    );

    expect(decision.ok === false && decision.refusal.reason).toBe("revoked");
  });

  test("refuses a pending member of the organisation", () => {
    const decision = authoriseMembership(
      account({ status: "pending" }),
      [organisation],
      organisation,
    );

    expect(decision.ok === false && decision.refusal.reason).toBe(
      "not_approved",
    );
  });
});

describe("event openness", () => {
  // FR-009: enrolment happens in an open event.
  test("permits an open event", () => {
    expect(authoriseEventOpen("open")).toEqual({ ok: true });
  });

  // FR-011: a closed event keeps its records readable and accepts nothing new.
  test("refuses a closed event", () => {
    const decision = authoriseEventOpen("closed");

    expect(decision.ok).toBe(false);
    expect(decision.ok === false && decision.refusal.reason).toBe(
      "event_not_open",
    );
    expect(decision.ok === false && decision.refusal.detail).toContain(
      "closed",
    );
  });

  // A draft event is not yet accepting anything either: absent readiness is a
  // refusal, not a default.
  test("refuses a draft event", () => {
    const decision = authoriseEventOpen("draft");

    expect(decision.ok === false && decision.refusal.reason).toBe(
      "event_not_open",
    );
    expect(decision.ok === false && decision.refusal.detail).toContain("draft");
  });
});
