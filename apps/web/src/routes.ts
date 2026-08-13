/**
 * The route table the nav and the router share.
 *
 * One list, so a header link cannot point at a path the router does not serve, and so
 * the paths appear as names rather than as strings scattered through components.
 *
 * `membersOnly` marks the destinations that need a signed-in approved account. The
 * public ones come first and are never hidden: every read surface is readable without an
 * account (constitution principle V), and a visitor should be able to see that the
 * member surfaces exist rather than discovering them after signing in.
 *
 * Author: John Grimes
 */

/** Where the console's pages live. */
export const ROUTES = {
  home: "/",
  events: "/events",
  personas: "/personas",
  docs: "/docs",
  pairings: "/pairings",
  myOrganisation: "/my-organisation",
  admin: "/admin",
  signIn: "/sign-in",
} as const;

/** One destination in the header. */
export interface NavigationItem {
  readonly path: string;
  readonly label: string;
  /** Needs a signed-in approved account. */
  readonly membersOnly: boolean;
}

/** The header's destinations, in the order they are shown. */
export const NAVIGATION: readonly NavigationItem[] = [
  { path: ROUTES.events, label: "Events", membersOnly: false },
  { path: ROUTES.personas, label: "Personas", membersOnly: false },
  { path: ROUTES.docs, label: "Docs", membersOnly: false },
  { path: ROUTES.pairings, label: "Pairings", membersOnly: true },
  { path: ROUTES.myOrganisation, label: "My organisation", membersOnly: true },
  { path: ROUTES.admin, label: "Admin", membersOnly: true },
];

/**
 * Whether a destination is the one the reader is currently on.
 *
 * A nested page counts - a system detail page is reached from the event view, and the
 * header should still say where the reader is - except for the home destination, which
 * every path is nested under and which therefore matches only itself.
 *
 * @param destination - The nav item's path.
 * @param current - The current location's path.
 * @returns `true` when the nav item should be marked as current.
 * @example
 * ```ts
 * isActivePath("/events", "/events/sparked-2026-09"); // true
 * ```
 */
export function isActivePath(destination: string, current: string): boolean {
  if (destination === ROUTES.home) {
    return current === ROUTES.home;
  }
  return current === destination || current.startsWith(`${destination}/`);
}
