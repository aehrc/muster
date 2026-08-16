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
 * Below `lg` the seven destinations do not fit a 375 px row, so the nav collapses behind a menu
 * button and drops onto its own full-width row when opened (FR-007, and the narrow shell
 * wireframe). It is the same list in the same order either way - one `nav` element, moved by
 * layout rather than duplicated - because a destination that exists only in one of two copies is
 * a destination that will eventually exist in neither.
 *
 * Author: John Grimes
 */

import { ThreeBarsIcon, XIcon } from "@primer/octicons-react";
import { useId, useState } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router";

import { useCredentialAction, useMe } from "../api/queries.js";
import { isActivePath, NAVIGATION, ROUTES } from "../routes.js";

/** The navbar, the nav, who is signed in, and the region the router fills. */
export function AppLayout() {
  const { pathname } = useLocation();
  const me = useMe();
  const action = useCredentialAction();
  const account = me.data?.account ?? null;
  const navId = useId();
  // The menu carries the path it was opened on, so that arriving somewhere closes the menu that
  // was opened to reach it. Keyed on the path rather than on the click, so a destination reached
  // any other way - a link in the page, the back button - leaves the shell in the same state as
  // one reached from the menu. Adjusted while rendering rather than in an effect, which is
  // React's own advice for state that has to follow something it is given.
  const [menu, setMenu] = useState({ open: false, path: pathname });
  if (menu.path !== pathname) {
    setMenu({ open: false, path: pathname });
  }
  const menuOpen = menu.open;

  return (
    <div className="bg-base-100 text-base-content flex min-h-screen flex-col">
      <header className="navbar border-base-300 bg-base-200 flex-wrap gap-2 px-4">
        <Link className="btn btn-ghost px-2 text-xl font-bold" to={ROUTES.home}>
          Muster
        </Link>

        {/*
          Below `lg` this sits on its own row, last, and is shown only while the menu is open;
          from `lg` it is always shown and takes the space beside the brand.
        */}
        <nav
          aria-label="Main"
          className={`order-last w-full lg:order-none lg:block lg:w-auto lg:flex-1 ${
            menuOpen ? "block" : "hidden"
          }`}
          id={navId}
        >
          <ul className="menu menu-sm lg:menu-horizontal w-full gap-1 p-0 lg:w-auto lg:flex-nowrap">
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

        <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2">
          {account === null ? (
            <Link className="btn btn-sm btn-outline" to={ROUTES.signIn}>
              Sign in
            </Link>
          ) : (
            <>
              <Link
                className="link link-hover min-w-0 text-sm break-words"
                to={ROUTES.signIn}
              >
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
            </>
          )}

          {/*
            Icon-only, so it carries its own name (FR-005); `aria-expanded` says whether the
            list below it is showing, which is the one piece of state the button owns.
          */}
          <button
            type="button"
            aria-controls={navId}
            aria-expanded={menuOpen}
            aria-label="Main menu"
            className="btn btn-sm btn-square btn-ghost lg:hidden"
            onClick={() => {
              setMenu((current) => ({ open: !current.open, path: pathname }));
            }}
          >
            {menuOpen ? <XIcon aria-hidden /> : <ThreeBarsIcon aria-hidden />}
          </button>
        </div>
      </header>

      <main className="mx-auto w-full max-w-7xl flex-1 p-4 sm:p-6">
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
