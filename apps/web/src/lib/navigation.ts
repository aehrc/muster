/*
 * Copyright © 2026 Commonwealth Scientific and Industrial Research Organisation
 * (CSIRO) ABN 41 687 119 230. Licensed under the Apache License, Version 2.0.
 */

import { standingFor } from "./account.ts";

import type { SessionView } from "@muster/contracts";

/**
 * The navigation the shell offers a given reader.
 *
 * Deciding this in a pure function keeps it testable, and keeps the shell honest:
 * a console that offers an admin queue to an ordinary member misreports its own
 * state, even though the server refuses the call anyway. The rules are not
 * restated here - `standingFor` asks `@muster/core`, which is what the server
 * asks, so the two cannot disagree about who may do what.
 *
 * @author John Grimes
 */

/** The icons the navigation uses, named so the list stays free of markup. */
export type NavigationIcon =
  | "home"
  | "docs"
  | "organisation"
  | "pairing"
  | "people"
  | "calendar"
  | "account";

/** Where a navigation entry leads, and what it is called. */
export type NavigationTarget = {
  /** the route it leads to */
  readonly to: string;
  /** what it is called */
  readonly label: string;
  /** the icon to render beside the label, named rather than constructed */
  readonly icon: NavigationIcon;
};

/**
 * Builds the navigation for a reader.
 *
 * The public pages come first - the directory and the published profiles are
 * both readable without an account - the reader's own organisation and its pairings next when they may
 * manage one, the admin
 * queues only for a track admin, and the account entry last - it names who is
 * signed in, or invites signing in when nobody is.
 *
 * @param session - the signed-in session, or null when anonymous
 * @returns the entries to offer, in the order they are shown
 * @example
 * ```ts
 * const items = navigationFor(session);
 * // anonymous: [{ to: "/" }, { to: "/sign-in" }]
 * ```
 */
export const navigationFor = (
  session: SessionView | null,
): readonly NavigationTarget[] => {
  const standing = standingFor(session);

  const own: readonly NavigationTarget[] = standing.canWrite
    ? [
        {
          to: "/my-organisation",
          label: "My organisation",
          icon: "organisation",
        },
        { to: "/pairings", label: "Pairings", icon: "pairing" },
      ]
    : [];

  const administration: readonly NavigationTarget[] = standing.canAdminister
    ? [
        { to: "/admin/members", label: "Members", icon: "people" },
        { to: "/admin/events", label: "Events", icon: "calendar" },
      ]
    : [];

  return [
    { to: "/", label: "Home", icon: "home" },
    // Public, like the directory itself: the profiles and the key locations are
    // what a vendor implements against, and they have no account here (FR-028).
    { to: "/docs", label: "Profiles", icon: "docs" },
    ...own,
    ...administration,
    {
      to: "/sign-in",
      label: session === null ? "Sign in" : session.account.displayName,
      icon: "account",
    },
  ];
};
