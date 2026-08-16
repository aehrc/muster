/**
 * The frame the admin pages sit in.
 *
 * A sidebar with the two admin sections, as the wireframes have it, and the region the router
 * fills. Nothing here decides authority: the pages check whether the caller is an admin, and the
 * server refuses regardless - a sidebar that hid itself would be a UI courtesy mistaken for a
 * control.
 *
 * The sidebar is a daisyUI menu, beside the page when there is room and above it when there is
 * not, so both sections stay reachable at every width. `NavLink` marks the current section and
 * sets `aria-current` itself, which is what says where the reader is without relying on the fill.
 *
 * Author: John Grimes
 */

import { NavLink, Outlet } from "react-router";

import { ROUTES } from "../../routes.js";

/** How an entry of the sidebar paints itself when it is the section being read. */
function entryClass({ isActive }: { isActive: boolean }): string {
  return isActive ? "menu-active font-semibold" : "";
}

/** The admin sidebar and the region the router fills. */
export function AdminLayout() {
  return (
    <div className="flex flex-col gap-6 sm:flex-row">
      <nav aria-label="Admin sections" className="sm:w-48 sm:shrink-0">
        <ul className="menu bg-base-200 rounded-box w-full gap-1">
          <li>
            <NavLink to={ROUTES.adminMembers} className={entryClass}>
              Members
            </NavLink>
          </li>
          <li>
            <NavLink to={ROUTES.adminEvents} className={entryClass}>
              Events
            </NavLink>
          </li>
        </ul>
      </nav>
      <div className="min-w-0 flex-1">
        <Outlet />
      </div>
    </div>
  );
}
