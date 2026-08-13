/**
 * What may happen to a pairing, who may make it happen, and who has to be told.
 *
 * The tracker replaces an email thread, and the thing an email thread cannot do is refuse. So
 * every question the routes ask about a pairing is answered here, from a table of the five
 * transitions `data-model.md` names and nothing else:
 *
 * ```text
 * requested → fulfilled   the server's organisation records the issued client identifier
 * requested → declined    the server's organisation declines, with a reason
 * requested → failed      a trusted-DCR attempt was rejected by the server
 * failed    → requested   the app owner retries after fixing the metadata
 * requested → lapsed      the event closed
 * ```
 *
 * Three things fall out of that table rather than being decided separately, which is the
 * reason it is a table. **Who may act**: the identifier is the server's to issue and the
 * metadata is the client's to fix, so a transition carries the side that may ask for it and
 * `transitionRefusal` is the only authority check the routes need. **Who is told**: FR-014
 * requires the counterparty to be notified on every transition, and "the counterparty" is a
 * property of the transition rather than of the request that caused it. **What lapses**:
 * closing an event asks for `requested → lapsed`, so `lapsesOnEventClose` is derived from the
 * same table and cannot disagree with it.
 *
 * Requesting a pairing is not in the table, because it is not a transition between states -
 * it creates the row. Its refusals are {@link pairingRequestRefusal}, and the mode check lives
 * there and nowhere else: a server that switches from manual registration to trusted DCR while
 * pairings are open leaves those pairings following the workflow they were requested under
 * (spec edge case), which is exactly what checking the mode at request time and never again
 * means.
 *
 * Pure, per constitution principle II: no clock, no database, no randomness.
 *
 * Author: John Grimes
 */

/**
 * Where a pairing has got to (FR-013).
 *
 * The same vocabulary as `pairingStateSchema` in `@muster/contracts` and the `pairing_state`
 * enum in `@muster/db`, declared here because this package is the domain and may not depend on
 * the package that validates the wire.
 */
export type PairingState =
  "requested" | "fulfilled" | "declined" | "failed" | "lapsed";

/** Which half of a pairing something belongs to. */
export type PairingSide = "client" | "server";

/** What a server requires of a client before it will talk to it. */
export type RegistrationMode = "open" | "manual" | "trustedDcr";

/** An event's lifecycle position, as the request rules read it. */
export type PairingEventStatus = "draft" | "open" | "closed";

/** Every state, in the order `data-model.md` names them. */
export const PAIRING_STATES: readonly PairingState[] = [
  "requested",
  "fulfilled",
  "declined",
  "failed",
  "lapsed",
];

/** Both halves of a pairing. */
export const PAIRING_SIDES: readonly PairingSide[] = ["client", "server"];

/**
 * Who a fresh request notifies.
 *
 * The server's organisation: they are the ones who can answer it (scenario 1). Not a
 * transition, so not in the table, and declared beside it so the two are read together.
 */
export const REQUEST_NOTIFIES: readonly PairingSide[] = ["server"];

/** One legal move, with who may make it and who hears about it. */
export interface PairingTransition {
  readonly from: PairingState;
  readonly to: PairingState;
  /**
   * The side whose members may ask for it, or `none` when no participant may.
   *
   * `none` is lapsing: it follows from an event closing, and a participant who could ask for
   * it directly could retire a pairing the counterparty was still working on.
   */
  readonly by: PairingSide | "none";
  /** The sides to notify. Never includes the side that acted - they already know. */
  readonly notifies: readonly PairingSide[];
}

/** Why a transition may not be made. */
export type TransitionRefusal = "illegal_transition" | "wrong_side";

/** Why a pairing may not be requested. */
export type PairingRequestRefusal =
  | "event_not_open"
  | "cross_event"
  | "not_a_client"
  | "not_a_server"
  | "no_registration_needed";

/** What the request rules read off the event and the two enrolments. */
export interface PairingRequestSides {
  /** The event the request names. */
  readonly eventId: string;
  readonly eventStatus: PairingEventStatus;
  /** The client side's enrolment: which event it is in, and whether its system is a client. */
  readonly client: { readonly eventId: string; readonly isClient: boolean };
  /** The server side's enrolment, and what its system requires of a client. */
  readonly server: {
    readonly eventId: string;
    readonly isServer: boolean;
    readonly registrationMode: RegistrationMode;
  };
}

/** Every transition, and nothing else. */
const TRANSITIONS: readonly PairingTransition[] = [
  {
    from: "requested",
    to: "fulfilled",
    by: "server",
    notifies: ["client"],
  },
  {
    from: "requested",
    to: "declined",
    by: "server",
    notifies: ["client"],
  },
  {
    // The trusted-DCR attempt, which the app owner runs (User Story 5). The server's
    // organisation is told because a statement their own endpoint rejected is usually
    // something on their side to fix, and because the app owner is watching the attempt
    // happen and reads the failure in its response.
    from: "requested",
    to: "failed",
    by: "client",
    notifies: ["server"],
  },
  {
    from: "failed",
    to: "requested",
    by: "client",
    notifies: ["server"],
  },
  {
    // Neither side chose it, so both are told (FR-011).
    from: "requested",
    to: "lapsed",
    by: "none",
    notifies: ["client", "server"],
  },
];

/**
 * The transition between two states, when the data model names one.
 *
 * @param from - The state the pairing holds.
 * @param to - The state asked for.
 * @returns The transition, or `undefined` when there is none - including for a transition to
 *   the state already held, which would overwrite what the first answer recorded and notify
 *   the counterparty a second time about something that already happened.
 * @example
 * ```ts
 * const transition = pairingTransition(pairing.state, "fulfilled");
 * if (transition === undefined) {
 *   return jsonError(c, 409, "illegal_transition");
 * }
 * ```
 */
export function pairingTransition(
  from: PairingState,
  to: PairingState,
): PairingTransition | undefined {
  return TRANSITIONS.find(
    (transition) => transition.from === from && transition.to === to,
  );
}

/**
 * Whether a transition is one the data model names.
 *
 * @param from - The state the pairing holds.
 * @param to - The state asked for.
 * @returns `true` when it is legal.
 * @example
 * ```ts
 * canTransition("requested", "fulfilled"); // true
 * canTransition("fulfilled", "declined"); // false
 * ```
 */
export function canTransition(from: PairingState, to: PairingState): boolean {
  return pairingTransition(from, to) !== undefined;
}

/**
 * Why this caller may not make this transition, or `undefined` when they may.
 *
 * The order the two refusals are tested in is deliberate. An impossible transition is
 * reported as impossible even to somebody who holds no side, because the state is a thing they
 * can check and their standing is not - and because "this pairing has already been answered"
 * is the useful thing to say when two members of one organisation answer at once.
 *
 * @param from - The state the pairing holds.
 * @param to - The state asked for.
 * @param sides - The sides the caller's organisations hold. Both, for a member of both
 *   organisations (spec edge case).
 * @returns The refusal code, or `undefined` when the transition may be made.
 * @example
 * ```ts
 * const refusal = transitionRefusal(pairing.state, "declined", sides);
 * if (refusal !== undefined) {
 *   return jsonError(c, refusal === "wrong_side" ? 403 : 409, refusal);
 * }
 * ```
 */
export function transitionRefusal(
  from: PairingState,
  to: PairingState,
  sides: readonly PairingSide[],
): TransitionRefusal | undefined {
  const transition = pairingTransition(from, to);
  if (transition === undefined) {
    return "illegal_transition";
  }
  if (transition.by === "none" || !sides.includes(transition.by)) {
    return "wrong_side";
  }
  return undefined;
}

/**
 * Whether an event closing lapses a pairing in this state (FR-011).
 *
 * Derived from the transition table rather than stated again, so the set of pairings a closing
 * event touches cannot drift from the set of pairings that may legally lapse.
 *
 * @param state - The pairing's state.
 * @returns `true` when closing the event should lapse it.
 * @example
 * ```ts
 * const open = pairings.filter((pairing) => lapsesOnEventClose(pairing.state));
 * ```
 */
export function lapsesOnEventClose(state: PairingState): boolean {
  return canTransition(state, "lapsed");
}

/**
 * Why a pairing may not be requested, or `undefined` when it may.
 *
 * The order is the message the requester can act on. Nothing about a closed event is fixed by
 * choosing a different server, and nothing about two systems in two different events is fixed
 * by editing the field set.
 *
 * @param sides - The event and the two enrolments.
 * @returns The refusal code, or `undefined` when the request may be made.
 * @example
 * ```ts
 * const refusal = pairingRequestRefusal({
 *   eventId: event.id,
 *   eventStatus: event.status,
 *   client: { eventId: client.enrolment.eventId, isClient: client.system.clientProfile !== null },
 *   server: { eventId: server.enrolment.eventId, isServer: true, registrationMode: mode },
 * });
 * ```
 */
export function pairingRequestRefusal(
  sides: PairingRequestSides,
): PairingRequestRefusal | undefined {
  if (sides.eventStatus !== "open") {
    return "event_not_open";
  }
  if (
    sides.client.eventId !== sides.eventId ||
    sides.server.eventId !== sides.eventId
  ) {
    // Scenario 6: a pairing exists within a single event.
    return "cross_event";
  }
  if (!sides.client.isClient) {
    return "not_a_client";
  }
  if (!sides.server.isServer) {
    return "not_a_server";
  }
  if (sides.server.registrationMode === "open") {
    // FR-016: an open-registration server accepts any client, so a request against it is a
    // promise of an answer that will never come.
    return "no_registration_needed";
  }
  return undefined;
}
