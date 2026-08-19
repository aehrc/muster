import {
  BookIcon,
  CalendarIcon,
  HomeIcon,
  LinkIcon,
  OrganizationIcon,
  PeopleIcon,
  PersonIcon,
} from "@primer/octicons-react";
import { BrowserRouter, Link, NavLink, Route, Routes } from "react-router";

import { navigationFor } from "./lib/navigation.ts";
import { Events } from "./pages/admin/Events.tsx";
import { Members } from "./pages/admin/Members.tsx";
import { DcrRun } from "./pages/DcrRun.tsx";
import { Docs } from "./pages/Docs.tsx";
import { EventView } from "./pages/EventView.tsx";
import { Harness } from "./pages/Harness.tsx";
import { Home } from "./pages/Home.tsx";
import { MyOrganisation } from "./pages/MyOrganisation.tsx";
import { NotFound } from "./pages/NotFound.tsx";
import { PairingDetail } from "./pages/PairingDetail.tsx";
import { Pairings } from "./pages/Pairings.tsx";
import { SignIn } from "./pages/SignIn.tsx";
import { SystemDetail } from "./pages/SystemDetail.tsx";
import { useSession } from "./session/sessionContext.ts";
import { SessionProvider } from "./session/SessionProvider.tsx";

import type { NavigationIcon } from "./lib/navigation.ts";
import type { JSX } from "react";

/**
 * The console shell: the router, and the layout every page sits inside.
 *
 * The theme follows the system preference - daisyUI's light theme by default and
 * its dark theme when the browser asks for dark, configured in `index.css` - so
 * there is no theme switch to get out of step with the operating system.
 *
 * The session is established once, above the router, because nearly every screen
 * asks who is signed in and a per-screen read would flicker the anonymous view on
 * every navigation.
 *
 * @author John Grimes
 */

/** The icon each navigation entry names. */
const icons: Record<NavigationIcon, JSX.Element> = {
  home: <HomeIcon size={16} />,
  docs: <BookIcon size={16} />,
  organisation: <OrganizationIcon size={16} />,
  pairing: <LinkIcon size={16} />,
  people: <PeopleIcon size={16} />,
  calendar: <CalendarIcon size={16} />,
  account: <PersonIcon size={16} />,
};

/**
 * The navigation, for whoever is reading.
 *
 * @returns the primary navigation
 */
function Navigation(): JSX.Element {
  const { session } = useSession();
  return (
    <nav aria-label="Primary" className="grow">
      <ul className="menu menu-horizontal menu-sm flex-wrap gap-1 p-0">
        {navigationFor(session).map((item) => (
          <li key={item.to}>
            <NavLink to={item.to} end className="gap-2">
              {icons[item.icon]}
              {item.label}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/**
 * Application shell.
 *
 * @returns the router, wrapped in the layout
 * @author John Grimes
 */
export function App(): JSX.Element {
  return (
    <BrowserRouter>
      <SessionProvider>
        <div className="flex min-h-screen flex-col bg-base-100 text-base-content">
          <header className="navbar min-h-0 flex-wrap gap-2 border-b border-base-300 bg-base-200 px-4 py-2">
            <Link to="/" className="flex items-center gap-2 text-lg font-bold">
              <OrganizationIcon size={20} />
              Muster
            </Link>
            <Navigation />
          </header>

          <main className="flex-1 px-4 py-6 sm:px-8 sm:py-10">
            <div className="mx-auto w-full max-w-5xl">
              <Routes>
                <Route path="/" element={<Home />} />
                <Route path="/events/:slug" element={<EventView />} />
                <Route
                  path="/events/:slug/systems/:systemId"
                  element={<SystemDetail />}
                />
                <Route
                  path="/enrolments/:enrolmentId/harness"
                  element={<Harness />}
                />
                <Route path="/my-organisation" element={<MyOrganisation />} />
                <Route path="/pairings" element={<Pairings />} />
                <Route
                  path="/pairings/:pairingId"
                  element={<PairingDetail />}
                />
                <Route
                  path="/pairings/:pairingId/register"
                  element={<DcrRun />}
                />
                <Route path="/docs" element={<Docs />} />
                <Route path="/docs/:slug" element={<Docs />} />
                <Route path="/admin/members" element={<Members />} />
                <Route path="/admin/events" element={<Events />} />
                {/* The verification email links to /verify with its token, and
                    spending it belongs to the account screen. */}
                <Route path="/sign-in" element={<SignIn />} />
                <Route path="/verify" element={<SignIn />} />
                <Route path="*" element={<NotFound />} />
              </Routes>
            </div>
          </main>
        </div>
      </SessionProvider>
    </BrowserRouter>
  );
}
