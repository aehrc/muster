/*
 * Copyright © 2026 Commonwealth Scientific and Industrial Research Organisation
 * (CSIRO) ABN 41 687 119 230. Licensed under the Apache License, Version 2.0.
 */

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
  /**
   * whether the first read has settled. False only before it has, so a screen can
   * say "we do not know yet" instead of showing the anonymous view to somebody
   * who turns out to be signed in. A later refresh does not clear it: what is
   * known stays known while it is checked again.
   */
  readonly established: boolean;
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
  established: false,
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
