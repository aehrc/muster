import { sessionViewSchema } from "@muster/contracts";
import { useCallback, useEffect, useMemo, useState } from "react";

import { SessionContext } from "./sessionContext.ts";
import { muster } from "../api/muster.ts";
import { failed, idle, pending } from "../lib/operation.ts";

import type { Operation } from "../lib/operation.ts";
import type { SessionView } from "@muster/contracts";
import type { JSX, ReactNode } from "react";

/**
 * Establishes who is signed in, once, for every screen below it.
 *
 * `/api/auth/me` is read on mount and again whenever something changes the
 * account - a sign-in, a sign-out, an email verification, an approval arriving
 * while the tab is open. A 401 is not a failure: being anonymous is a normal
 * state of the console, and the directory is readable in it.
 *
 * @author John Grimes
 */

/** What the read of the session is called in its messages. */
const what = "Reading your session";

/**
 * Provides the session.
 *
 * @param props - the tree that reads the session
 * @returns the provider
 * @example
 * ```tsx
 * <SessionProvider>
 *   <Routes />
 * </SessionProvider>
 * ```
 */
export function SessionProvider({
  children,
}: Readonly<{
  /** the tree that reads the session */
  children: ReactNode;
}>): JSX.Element {
  const [state, setState] = useState<{
    /** the session, or null when anonymous */
    session: SessionView | null;
    /** the state of the read */
    operation: Operation;
  }>({ session: null, operation: pending(what) });

  const load = useCallback(async (): Promise<void> => {
    setState((previous) => ({
      session: previous.session,
      operation: pending(what),
    }));
    const result = await muster.get("/api/auth/me", sessionViewSchema);
    if (result.ok) {
      setState({ session: result.data, operation: idle });
      return;
    }
    // Anonymous is a state, not a fault: the event view is readable without an
    // account, so a 401 here is the answer and not an error to report.
    setState({
      session: null,
      operation:
        result.failure.status === 401 ? idle : failed(what, result.failure),
    });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const value = useMemo(
    () => ({
      session: state.session,
      operation: state.operation,
      refresh: () => {
        void load();
      },
      adopt: (session: SessionView | null) => {
        setState({ session, operation: idle });
      },
    }),
    [state.session, state.operation, load],
  );

  return (
    <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
  );
}
