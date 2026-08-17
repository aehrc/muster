import { HomeIcon, OrganizationIcon } from "@primer/octicons-react";
import { BrowserRouter, Link, NavLink, Route, Routes } from "react-router";

import { Home } from "./pages/Home.tsx";
import { NotFound } from "./pages/NotFound.tsx";

import type { JSX } from "react";

/**
 * The console shell: the router, and the layout every page sits inside.
 *
 * The theme follows the system preference - daisyUI's light theme by default and
 * its dark theme when the browser asks for dark, configured in `index.css` - so
 * there is no theme switch to get out of step with the operating system.
 *
 * @author John Grimes
 */

/** An entry in the public navigation. */
type NavigationItem = {
  /** the route it leads to */
  readonly to: string;
  /** what it is called */
  readonly label: string;
  /** its icon */
  readonly icon: JSX.Element;
};

/**
 * The public navigation. Pages added by later phases join this list, which is
 * the only place the navigation is stated.
 */
const publicNavigation: readonly NavigationItem[] = [
  { to: "/", label: "Home", icon: <HomeIcon size={16} /> },
];

/**
 * Application shell.
 *
 * @returns the router, wrapped in the layout
 * @author John Grimes
 */
export function App(): JSX.Element {
  return (
    <BrowserRouter>
      <div className="flex min-h-screen flex-col bg-base-100 text-base-content">
        <header className="navbar min-h-0 flex-wrap gap-2 border-b border-base-300 bg-base-200 px-4 py-2">
          <Link to="/" className="flex items-center gap-2 text-lg font-bold">
            <OrganizationIcon size={20} />
            Muster
          </Link>
          <nav aria-label="Primary" className="grow">
            <ul className="menu menu-horizontal menu-sm gap-1 p-0">
              {publicNavigation.map((item) => (
                <li key={item.to}>
                  <NavLink to={item.to} end className="gap-2">
                    {item.icon}
                    {item.label}
                  </NavLink>
                </li>
              ))}
            </ul>
          </nav>
        </header>

        <main className="flex-1 px-4 py-6 sm:px-8 sm:py-10">
          <div className="mx-auto w-full max-w-5xl">
            <Routes>
              <Route path="/" element={<Home />} />
              <Route path="*" element={<NotFound />} />
            </Routes>
          </div>
        </main>
      </div>
    </BrowserRouter>
  );
}
