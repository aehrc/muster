/**
 * The frame every page is rendered inside.
 *
 * A daisyUI navbar carrying the product name, the nav and who is signed in, a main region the
 * router fills, and a footer. The nav is the console's answer to "where am I": the current
 * destination is marked, and the member-only destinations are labelled rather than hidden, so a
 * visitor can see what signing in would give them.
 *
 * The signed-in state is in the navbar for the same reason. FR-037 asks every operation to report
 * its state, and "which account am I acting as" is the state every other operation depends on -
 * particularly for a member whose account is pending, whose refusals otherwise look like faults.
 *
 * Desktop layout only: the nav is laid out horizontally at every width for now, and collapsing it
 * behind a menu control at narrow widths is its own piece of work.
 *
 * Author: John Grimes
 */

import { Link, NavLink, Outlet, useLocation } from "react-router";

import { useCredentialAction, useMe } from "../api/queries.js";
import { isActivePath, NAVIGATION, ROUTES } from "../routes.js";

/** The navbar, the nav, who is signed in, and the region the router fills. */
export function AppLayout() {
  const { pathname } = useLocation();
  const me = useMe();
  const action = useCredentialAction();
  const account = me.data?.account ?? null;

  return (
    <div className="bg-base-100 text-base-content flex min-h-screen flex-col">
      <header className="navbar border-base-300 bg-base-200 gap-2 border-b px-4">
        <Link className="btn btn-ghost text-xl font-bold" to={ROUTES.home}>
          Muster
        </Link>
        <nav aria-label="Main" className="flex-1">
          <ul className="menu menu-horizontal flex-nowrap gap-1 p-0">
            {NAVIGATION.map((item) => {
              // `isActivePath` rather than NavLink's own `isActive`, because the rule for
              // nested pages is Muster's and is tested on its own.
              const active = isActivePath(item.path, pathname);
              return (
                <li key={item.path}>
                  <NavLink
                    to={item.path}
                    className={active ? "menu-active font-semibold" : ""}
                    {...(active ? { "aria-current": "page" as const } : {})}
                  >
                    {item.label}
                    {item.membersOnly ? (
                      <span className="text-xs opacity-60"> (members)</span>
                    ) : null}
                  </NavLink>
                </li>
              );
            })}
          </ul>
        </nav>

        {account === null ? (
          <Link className="btn btn-sm btn-outline" to={ROUTES.signIn}>
            Sign in
          </Link>
        ) : (
          <div className="flex items-center gap-2 text-sm">
            <Link className="link link-hover" to={ROUTES.signIn}>
              {account.displayName}
              {account.isAdmin ? " - track admin" : ""}
              {account.status === "approved" ? "" : ` (${account.status})`}
            </Link>
            <button
              type="button"
              className="btn btn-sm"
              disabled={action.isPending}
              onClick={() => {
                action.mutate({ kind: "sign-out" });
              }}
            >
              Sign out
            </button>
          </div>
        )}
      </header>

      <main className="mx-auto w-full max-w-7xl flex-1 p-6">
        <Outlet />
      </main>

      <footer className="footer footer-center border-base-300 bg-base-200 text-base-content/70 border-t p-4 text-sm">
        <p>
          Connectathon participant directory. Everything on the public pages is
          readable without an account; contact details are not.
        </p>
      </footer>
    </div>
  );
}
