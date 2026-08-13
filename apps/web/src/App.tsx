/**
 * The application root: providers, and the route table.
 *
 * The query defaults are deliberate. Nothing retries: an API refusal is an answer, and retrying a
 * 403 three times only delays telling the reader what happened. Refetching on focus is off for the
 * reason it is usually on - this is a directory rather than a live feed, and a page that silently
 * reloaded while a form was open would discard what was being typed. Freshness that matters (an
 * enrolment, a member's standing) is invalidated by the mutation that changed it.
 *
 * The event and system pages read their identifiers from the URL and pass them in as props, so the
 * pages themselves take no dependency on the router's shape.
 *
 * Author: John Grimes
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
  useParams,
} from "react-router";

import { AppLayout } from "./components/AppLayout.js";
import { AdminLayout } from "./pages/admin/AdminLayout.js";
import { AdminEvents } from "./pages/admin/Events.js";
import { AdminMembers } from "./pages/admin/Members.js";
import { DcrRun } from "./pages/DcrRun.js";
import { Docs } from "./pages/Docs.js";
import { Events } from "./pages/Events.js";
import { EventView } from "./pages/EventView.js";
import { Harness } from "./pages/Harness.js";
import { Home } from "./pages/Home.js";
import { MyOrganisation } from "./pages/MyOrganisation.js";
import { NotFound } from "./pages/NotFound.js";
import { PairingDetail } from "./pages/PairingDetail.js";
import { Pairings } from "./pages/Pairings.js";
import { SignIn } from "./pages/SignIn.js";
import { SystemDetail } from "./pages/SystemDetail.js";
import { Verify } from "./pages/Verify.js";
import { ROUTES } from "./routes.js";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, refetchOnWindowFocus: false, staleTime: 15_000 },
  },
});

/** Providers plus the route table. */
export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route element={<AppLayout />} path="/">
            <Route index element={<Home />} />
            <Route path="events" element={<Events />} />
            <Route path="events/:slug" element={<EventRoute />} />
            <Route
              path="events/:slug/systems/:systemId"
              element={<SystemRoute />}
            />
            <Route path="pairings" element={<Pairings />} />
            <Route path="pairings/:id" element={<PairingRoute />} />
            <Route path="pairings/:id/register" element={<DcrRunRoute />} />
            <Route path="docs" element={<Docs />} />
            <Route path="harness/:enrolmentId" element={<HarnessRoute />} />
            <Route path="my-organisation" element={<MyOrganisation />} />
            <Route path="sign-in" element={<SignIn />} />
            <Route path="verify" element={<Verify />} />
            <Route path="admin" element={<AdminLayout />}>
              <Route
                index
                element={<Navigate replace to={ROUTES.adminMembers} />}
              />
              <Route path="members" element={<AdminMembers />} />
              <Route path="events" element={<AdminEvents />} />
            </Route>
            {/* The persona page is mounted here by the user story that builds it. */}
            <Route path="*" element={<NotFound />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}

/** Reads the event's slug from the URL. */
function EventRoute() {
  const { slug } = useParams();
  return slug === undefined ? <NotFound /> : <EventView slug={slug} />;
}

/** Reads the pairing's identifier from the URL. */
function PairingRoute() {
  const { id } = useParams();
  return id === undefined ? <NotFound /> : <PairingDetail id={id} />;
}

/** Reads the pairing's identifier for the trusted-DCR run screen. */
function DcrRunRoute() {
  const { id } = useParams();
  return id === undefined ? <NotFound /> : <DcrRun id={id} />;
}

/** Reads the enrolment's identifier for the conformance harness screen. */
function HarnessRoute() {
  const { enrolmentId } = useParams();
  return enrolmentId === undefined ? (
    <NotFound />
  ) : (
    <Harness enrolmentId={enrolmentId} />
  );
}

/** Reads the event's slug and the system's identifier from the URL. */
function SystemRoute() {
  const { slug, systemId } = useParams();
  return slug === undefined || systemId === undefined ? (
    <NotFound />
  ) : (
    <SystemDetail slug={slug} systemId={systemId} />
  );
}
