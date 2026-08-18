import { createContext, useContext } from "react";

import { idle } from "../lib/operation.ts";

import type { Operation } from "../lib/operation.ts";
import type { SessionView } from "@muster/contracts";

/**
 * Who the console believes is signed in.
 *
 * The session is global, infrequently changing state read by nearly every
 * screen, which is what context is for. It carries its own operation state as
 * well as its value, because "we do not know yet" and "nobody is signed in" are
 * different things and a screen that conflates them shows a signed-in member the
 * anonymous view for a moment on every load.
 *
 * @author John Grimes
 */

/** The session, and what the console is doing about it. */
export type SessionState = {
  /** the signed-in account and its memberships, or null when anonymous */
  readonly session: SessionView | null;
  /** the state of the read that established it */
  readonly operation: Operation;
  /** reads it again from the server */
  readonly refresh: () => void;
  /** records the session a sign-in or sign-out just produced */
  readonly adopt: (session: SessionView | null) => void;
};

/** What a screen sees before any provider has established anything. */
const unknownSession: SessionState = {
  session: null,
  operation: idle,
  refresh: () => undefined,
  adopt: () => undefined,
};

/** The session every screen reads. */
export const SessionContext = createContext<SessionState>(unknownSession);

/**
 * Reads the session.
 *
 * @returns the session and the ways to change it
 * @example
 * ```ts
 * const { session, adopt } = useSession();
 * ```
 */
export const useSession = (): SessionState => useContext(SessionContext);
