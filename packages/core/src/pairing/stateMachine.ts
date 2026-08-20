/*
 * Copyright © 2026 Commonwealth Scientific and Industrial Research Organisation
 * (CSIRO) ABN 41 687 119 230. Licensed under the Apache License, Version 2.0.
 */

import { authoriseEventOpen, granted, refuse } from "../accounts/rules.ts";

import type { AuthorisationDecision, Refusal } from "../accounts/rules.ts";
import type {
  EventStatus,
  PairingSide,
  PairingState,
  RegistrationMode,
} from "@muster/contracts";

/**
 * The pairing state machine.
 *
 * A pairing is a conversation between two organisations, and this decides who may
 * say what, when. The transitions are the ones `data-model.md` states - its five,
 * plus the trusted-DCR run it describes in prose - and there is no other: an
 * action with nowhere to land is refused rather than tolerated, because a tracker
 * that quietly accepts an impossible move is worse than no tracker - both parties
 * would then be reading a history that did not happen.
 *
 * Everything here is decided from facts passed in. There is no database, no clock
 * and no request, so the rules are the same whether a route handler, the event
 * closing routine or the console is asking.
 *
 * Each action belongs to one side. The client's organisation asks, runs a trusted
 * registration, and, after a failed attempt, asks again with corrected metadata;
 * the server's organisation answers by issuing an identifier or declining; and the
 * lapse belongs to neither, because an event closing is Muster's own doing.
 *
 * @author John Grimes
 */

/** What moves a pairing. */
export type PairingAction =
  "request" | "fulfil" | "register" | "decline" | "fail" | "retry" | "lapse";

/** One legal move. */
export type PairingTransition = {
  /** the action that makes it */
  readonly action: PairingAction;
  /** the state it moves from, null when the pairing is being created */
  readonly from: PairingState | null;
  /** the state it moves to */
  readonly to: PairingState;
  /** the side entitled to take it, null for Muster's own action */
  readonly side: PairingSide | null;
  /** whether it records the issued client identifier */
  readonly recordsClientId: boolean;
  /** whether it records a decline reason */
  readonly recordsDeclineReason: boolean;
  /** whether it replaces the registration field snapshot */
  readonly replacesRegistrationFields: boolean;
  /** whether it needs the event to be open */
  readonly requiresOpenEvent: boolean;
};

/** What deciding an action needs to know. */
export type PairingActionFacts = {
  /** the action asked for */
  readonly action: PairingAction;
  /** the pairing's current state, null when it is being created */
  readonly state: PairingState | null;
  /** the sides the caller may act for */
  readonly sides: readonly PairingSide[];
  /** the event's status */
  readonly eventStatus: EventStatus;
};

/** The outcome of an action. */
export type PairingTransitionResult =
  | { readonly ok: true; readonly transition: PairingTransition }
  | { readonly ok: false; readonly refusal: Refusal };

/** What deciding a request needs to know. */
export type PairingRequestFacts = {
  /** the server's registration mode */
  readonly registrationMode: RegistrationMode;
  /** whether the client enrolment belongs to the event */
  readonly clientEnrolledInEvent: boolean;
  /** whether the server enrolment belongs to the event */
  readonly serverEnrolledInEvent: boolean;
  /** the existing pairing for this client, server and event, if any */
  readonly duplicateOf: string | null;
};

/**
 * The legal moves, in the order the data model states them.
 *
 * The table is the machine: `applyPairingAction` looks a move up in it and
 * refuses when there is none, so adding a state to the enumeration without adding
 * its transitions here leaves it unreachable rather than half-implemented.
 */
export const pairingTransitions: readonly PairingTransition[] = [
  {
    action: "request",
    from: null,
    to: "requested",
    side: "client",
    recordsClientId: false,
    recordsDeclineReason: false,
    replacesRegistrationFields: true,
    requiresOpenEvent: true,
  },
  {
    action: "fulfil",
    from: "requested",
    to: "fulfilled",
    side: "server",
    recordsClientId: true,
    recordsDeclineReason: false,
    replacesRegistrationFields: false,
    requiresOpenEvent: true,
  },
  {
    // The trusted-DCR run (US5): the app owner presents Muster's vouching to the
    // server's registration endpoint, and a server that accepts it has registered
    // the client, so the request is fulfilled with no human on the server's side.
    // It belongs to the client's side because it is the client being vouched for;
    // the server's consent is its published registration endpoint.
    action: "register",
    from: "requested",
    to: "fulfilled",
    side: "client",
    recordsClientId: true,
    recordsDeclineReason: false,
    replacesRegistrationFields: false,
    requiresOpenEvent: true,
  },
  {
    action: "decline",
    from: "requested",
    to: "declined",
    side: "server",
    recordsClientId: false,
    recordsDeclineReason: true,
    replacesRegistrationFields: false,
    requiresOpenEvent: true,
  },
  {
    action: "fail",
    from: "requested",
    to: "failed",
    side: "client",
    recordsClientId: false,
    recordsDeclineReason: false,
    replacesRegistrationFields: false,
    requiresOpenEvent: true,
  },
  {
    action: "retry",
    from: "failed",
    to: "requested",
    side: "client",
    recordsClientId: false,
    recordsDeclineReason: false,
    replacesRegistrationFields: true,
    requiresOpenEvent: true,
  },
  {
    action: "lapse",
    from: "requested",
    to: "lapsed",
    side: null,
    recordsClientId: false,
    recordsDeclineReason: false,
    replacesRegistrationFields: false,
    requiresOpenEvent: false,
  },
];

/**
 * The states a pairing is still open in.
 *
 * What closing an event lapses (FR-011). A fulfilled or declined pairing is
 * finished and a failed one is the owner's to retry, so only a request is
 * outstanding.
 */
export const openPairingStates: readonly PairingState[] = ["requested"];

/** How each action reads in a refusal. */
const actionWords: Record<PairingAction, string> = {
  request: "request",
  fulfil: "fulfilment",
  register: "registration run",
  decline: "decline",
  fail: "failure",
  retry: "retry",
  lapse: "lapse",
};

/** How each side reads in a refusal. */
const sideWords: Record<PairingSide, string> = {
  client: "the client's organisation",
  server: "the server's organisation",
};

/**
 * Decides an action against a pairing.
 *
 * Three conditions, each refused with its own reason so the party is told which
 * one they failed: the move must exist in the table, the caller must be on the
 * side the move belongs to, and the event must be open unless the move is the
 * lapse that closing an event performs.
 *
 * @param facts - the action, the pairing's state, the sides the caller may act
 *   for, and the event's status
 * @returns the transition to apply, or the refusal to report
 * @example
 * ```ts
 * const result = applyPairingAction({
 *   action: "fulfil",
 *   state: pairing.state,
 *   sides: ["server"],
 *   eventStatus: event.status,
 * });
 * if (!result.ok) {
 *   throw refusalError(result.refusal);
 * }
 * ```
 */
export const applyPairingAction = (
  facts: PairingActionFacts,
): PairingTransitionResult => {
  const transition = pairingTransitions.find(
    (candidate) =>
      candidate.action === facts.action && candidate.from === facts.state,
  );
  if (transition === undefined) {
    return refuse(
      "illegal_transition",
      `That pairing is ${facts.state ?? "not yet requested"}, so a ${actionWords[facts.action]} is not possible.`,
    );
  }

  if (transition.side !== null && !facts.sides.includes(transition.side)) {
    return refuse(
      "wrong_side",
      `Only ${sideWords[transition.side]} can take that action on this pairing.`,
    );
  }

  if (transition.requiresOpenEvent) {
    const openness = authoriseEventOpen(facts.eventStatus);
    if (!openness.ok) {
      return openness;
    }
  }

  return { ok: true, transition };
};

/**
 * Decides whether a pairing may be requested at all.
 *
 * The conditions the state machine cannot see: both enrolments belong to the
 * event the request names (acceptance scenario 6), the server registers clients
 * at all (FR-016), and no pairing for this client and server already exists
 * (FR-015). Deny by default - a caller that has not established the absence of a
 * duplicate cannot be granted a request by omission.
 *
 * @param facts - the server's registration mode, whether each side is enrolled in
 *   the event, and the identifier of any existing pairing
 * @returns the decision
 * @example
 * ```ts
 * const decision = authorisePairingRequest({
 *   registrationMode: profile.registrationMode,
 *   clientEnrolledInEvent: true,
 *   serverEnrolledInEvent: true,
 *   duplicateOf: existing?.id ?? null,
 * });
 * ```
 */
export const authorisePairingRequest = (
  facts: PairingRequestFacts,
): AuthorisationDecision => {
  if (!facts.clientEnrolledInEvent) {
    return refuse(
      "not_in_event",
      "That client is not enrolled in this event, and a pairing exists within a single event.",
    );
  }
  if (!facts.serverEnrolledInEvent) {
    return refuse(
      "not_in_event",
      "That server is not enrolled in this event, and a pairing exists within a single event.",
    );
  }
  if (facts.registrationMode === "open") {
    return refuse(
      "registration_not_needed",
      "That server needs no registration, so there is no pairing to request.",
    );
  }
  if (facts.duplicateOf !== null) {
    return refuse(
      "duplicate_pairing",
      "A pairing for that client and server already exists in this event.",
    );
  }
  return granted;
};
