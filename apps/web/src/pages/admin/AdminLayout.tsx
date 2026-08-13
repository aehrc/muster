/**
 * The frame the admin pages sit in.
 *
 * A sidebar with the two admin sections, as the wireframes have it, and the region the router
 * fills. Nothing here decides authority: the pages check whether the caller is an admin, and the
 * server refuses regardless - a sidebar that hid itself would be a UI courtesy mistaken for a
 * control.
 *
 * Author: John Grimes
 */

import { NavLink, Outlet } from "react-router";

import { ROUTES } from "../../routes.js";

/** The admin sidebar and the region the router fills. */
export function AdminLayout() {
  return (
    <div className="admin">
      <nav aria-label="Admin sections">
        <ul className="admin-nav">
          <li>
            <NavLink
              to={ROUTES.adminMembers}
              className={({ isActive }) => (isActive ? "current" : "")}
            >
              Members
            </NavLink>
          </li>
          <li>
            <NavLink
              to={ROUTES.adminEvents}
              className={({ isActive }) => (isActive ? "current" : "")}
            >
              Events
            </NavLink>
          </li>
        </ul>
      </nav>
      <div className="admin-main">
        <Outlet />
      </div>
    </div>
  );
}
