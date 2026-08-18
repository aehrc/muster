import { describe, expect, test } from "bun:test";

import { navigationFor } from "./navigation.ts";

import type { SessionView } from "@muster/contracts";

/**
 * What the shell offers each reader.
 *
 * The navigation is not a security boundary - the server refuses regardless - but
 * offering an admin queue to somebody who cannot open it is a lie the console
 * tells about itself, so the list is derived from standing and tested here.
 */

// Builds a session, defaulting to an approved ordinary member.
const session = (
  overrides: {
    readonly status?: "pending" | "approved" | "revoked";
    readonly emailVerified?: boolean;
    readonly isAdmin?: boolean;
  } = {},
): SessionView => ({
  account: {
    id: "05a3d5b4-3d4b-4f0e-8f2f-9e3f5b2a1c00",
    email: "member@example.org",
    displayName: "A Member",
    status: overrides.status ?? "approved",
    emailVerified: overrides.emailVerified ?? true,
    isAdmin: overrides.isAdmin ?? false,
  },
  memberships: [],
});

// The paths a list offers, in order.
const paths = (readers: SessionView | null): readonly string[] =>
  navigationFor(readers).map((item) => item.to);

describe("navigationFor", () => {
  // The directory is public, so an anonymous reader is offered the public pages
  // and a way to sign in - and nothing that would refuse them (SC-006).
  test("offers the public pages and sign-in to an anonymous reader", () => {
    expect(paths(null)).toEqual(["/", "/sign-in"]);
  });

  // A pending account has no write rights (FR-002), so neither its own
  // organisation page nor its pairings have anything for it yet.
  test("withholds the organisation and pairing pages from a pending account", () => {
    expect(paths(session({ status: "pending" }))).toEqual(["/", "/sign-in"]);
  });

  // An unverified address is the same refusal for a different reason (FR-001).
  test("withholds the organisation page until the address is verified", () => {
    expect(paths(session({ emailVerified: false }))).toEqual(["/", "/sign-in"]);
  });

  // Approval is what standing membership buys, so the organisation page appears.
  test("offers the organisation and pairing pages to an approved member", () => {
    expect(paths(session())).toEqual([
      "/",
      "/my-organisation",
      "/pairings",
      "/sign-in",
    ]);
  });

  // Revocation takes it away again (FR-002).
  test("withdraws the organisation page from a revoked account", () => {
    expect(paths(session({ status: "revoked" }))).toEqual(["/", "/sign-in"]);
  });

  // The admin role is distinct from membership (FR-004), so only it is offered the
  // approval queue and event management.
  test("offers the admin pages to a track admin", () => {
    expect(paths(session({ isAdmin: true }))).toEqual([
      "/",
      "/my-organisation",
      "/pairings",
      "/admin/members",
      "/admin/events",
      "/sign-in",
    ]);
  });

  // A revoked admin is refused like any other revoked account: the flag alone is
  // not authority (deny by default).
  test("withdraws the admin pages from a revoked admin", () => {
    expect(paths(session({ isAdmin: true, status: "revoked" }))).toEqual([
      "/",
      "/sign-in",
    ]);
  });

  // The account entry names who is signed in, because "am I signed in, and as
  // whom" is state the shell must show rather than hide (FR-037).
  test("labels the account entry with the signed-in name", () => {
    const account = navigationFor(session()).at(-1);
    expect(account?.label).toBe("A Member");
  });

  // Anonymously, the same entry is the invitation to sign in.
  test("labels the account entry as sign-in when anonymous", () => {
    expect(navigationFor(null).at(-1)?.label).toBe("Sign in");
  });
});
