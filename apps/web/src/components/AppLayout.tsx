/**
 * The frame every page is rendered inside.
 *
 * A header carrying the product name, the nav and who is signed in, and a main region the router
 * fills. The nav is the console's answer to "where am I": the current destination is marked, and
 * the member-only destinations are labelled rather than hidden, so a visitor can see what signing
 * in would give them.
 *
 * The signed-in state is in the header for the same reason. FR-037 asks every operation to report
 * its state, and "which account am I acting as" is the state every other operation depends on -
 * particularly for a member whose account is pending, whose refusals otherwise look like faults.
 *
 * Author: John Grimes
 */

import { Link, NavLink, Outlet, useLocation } from "react-router";

import { useCredentialAction, useMe } from "../api/queries.js";
import { isActivePath, NAVIGATION, ROUTES } from "../routes.js";

/** The header, the nav, who is signed in, and the region the router fills. */
export function AppLayout() {
  const { pathname } = useLocation();
  const me = useMe();
  const action = useCredentialAction();
  const account = me.data?.account ?? null;

  return (
    <div className="shell">
      <header className="shell-header">
        <Link className="shell-brand" to={ROUTES.home}>
          Muster
        </Link>
        <nav aria-label="Main">
          <ul className="shell-nav">
            {NAVIGATION.map((item) => {
              // `isActivePath` rather than NavLink's own `isActive`, because the rule for
              // nested pages is Muster's and is tested on its own.
              const active = isActivePath(item.path, pathname);
              return (
                <li key={item.path}>
                  <NavLink
                    to={item.path}
                    className={active ? "current" : ""}
                    {...(active ? { "aria-current": "page" as const } : {})}
                  >
                    {item.label}
                    {item.membersOnly ? (
                      <span className="shell-nav-note"> (members)</span>
                    ) : null}
                  </NavLink>
                </li>
              );
            })}
          </ul>
        </nav>

        {account === null ? (
          <Link className="shell-sign-in" to={ROUTES.signIn}>
            Sign in
          </Link>
        ) : (
          <div className="shell-account">
            <Link to={ROUTES.signIn}>
              {account.displayName}
              {account.isAdmin ? " - track admin" : ""}
              {account.status === "approved" ? "" : ` (${account.status})`}
            </Link>
            <button
              type="button"
              className="button"
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

      <main className="shell-main">
        <Outlet />
      </main>

      <footer className="shell-footer">
        <p>
          Connectathon participant directory. Everything on the public pages is
          readable without an account; contact details are not.
        </p>
      </footer>
    </div>
  );
}
