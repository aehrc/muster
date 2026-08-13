/**
 * The application root: providers, and the route table.
 *
 * The query defaults are deliberate. Nothing retries: an API refusal is an answer, and
 * retrying a 403 three times only delays telling the reader what happened. Refetching on
 * focus is off for the reason it is usually on - this is a directory rather than a live
 * feed, and a page that silently reloaded while a form was open would discard what was
 * being typed. Freshness that matters (a check result, a pairing state) is invalidated by
 * the mutation that changed it.
 *
 * Author: John Grimes
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes } from "react-router";

import { AppLayout } from "./components/AppLayout.js";
import { Home } from "./pages/Home.js";
import { NotFound } from "./pages/NotFound.js";

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
            {/* The event, persona, docs, pairing, organisation and admin pages
                are mounted here by the user stories that build them. */}
            <Route path="*" element={<NotFound />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
