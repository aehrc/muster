import { describe, expect, test } from "bun:test";

import {
  applyPairingAction,
  authorisePairingRequest,
  openPairingStates,
  pairingTransitions,
} from "./stateMachine.ts";

import type {
  PairingAction,
  PairingActionFacts,
  PairingRequestFacts,
} from "./stateMachine.ts";
import type { PairingSide, PairingState } from "@muster/contracts";

/**
 * The pairing state machine.
 *
 * The legal transitions are the five in `data-model.md` and nothing else, and
 * each one is answered here without a database, a clock or a request. Two things
 * are being pinned down: that an illegal move is refused with wording the party
 * can act on, and that a move is refused unless the caller is on the side of the
 * pairing entitled to make it - the client owner requests and retries, the server
 * owner fulfils and declines, and Muster itself lapses.
 */

// The facts of an action, defaulting to a server member fulfilling a request.
const facts = (
  overrides: Partial<PairingActionFacts> = {},
): PairingActionFacts => ({
  action: "fulfil",
  state: "requested",
  sides: ["server"],
  eventStatus: "open",
  ...overrides,
});

// The facts of a request, defaulting to a permissible one.
const requestFacts = (
  overrides: Partial<PairingRequestFacts> = {},
): PairingRequestFacts => ({
  registrationMode: "manual",
  clientEnrolledInEvent: true,
  serverEnrolledInEvent: true,
  duplicateOf: null,
  ...overrides,
});

// The state an action reaches, or the reason it was refused.
const outcome = (overrides: Partial<PairingActionFacts> = {}): string => {
  const result = applyPairingAction(facts(overrides));
  return result.ok ? result.transition.to : result.refusal.reason;
};

describe("pairingTransitions", () => {
  // The transition table is the data model's, exactly: five moves and no more.
  // Anything else a route might attempt has nowhere to land.
  test("holds the five transitions the data model states", () => {
    const moves = pairingTransitions.map(
      (transition) =>
        `${transition.from ?? "none"} -> ${transition.to} (${transition.action})`,
    );

    expect(moves).toEqual([
      "none -> requested (request)",
      "requested -> fulfilled (fulfil)",
      "requested -> declined (decline)",
      "requested -> failed (fail)",
      "failed -> requested (retry)",
      "requested -> lapsed (lapse)",
    ]);
  });

  // Each action belongs to one side of the pairing, and the lapse belongs to
  // neither: an event closing is Muster's doing, not a party's.
  test("attributes each action to the side entitled to take it", () => {
    const sides = Object.fromEntries(
      pairingTransitions.map((transition) => [
        transition.action,
        transition.side,
      ]),
    );

    expect(sides).toEqual({
      request: "client",
      fulfil: "server",
      decline: "server",
      fail: "client",
      retry: "client",
      lapse: null,
    });
  });

  // The registration field set is a snapshot taken when the request is made
  // (FR-012). Only a retry after a failure replaces it, because that is the one
  // transition whose whole purpose is corrected metadata.
  test("replaces the registration field snapshot only on request and retry", () => {
    const replacing = pairingTransitions
      .filter((transition) => transition.replacesRegistrationFields)
      .map((transition) => transition.action);

    expect(replacing).toEqual(["request", "retry"]);
  });

  // The client identifier arrives with the fulfilment and nowhere else; the
  // reason arrives with the decline and nowhere else.
  test("records the client identifier on fulfilment and the reason on a decline", () => {
    const recording = (key: "recordsClientId" | "recordsDeclineReason") =>
      pairingTransitions
        .filter((transition) => transition[key])
        .map((transition) => transition.action);

    expect(recording("recordsClientId")).toEqual(["fulfil"]);
    expect(recording("recordsDeclineReason")).toEqual(["decline"]);
  });

  // Every action but the lapse needs an open event (FR-011); the lapse is what
  // closing an event does, so requiring an open one would make it impossible.
  test("requires an open event for every action except the lapse", () => {
    const needingOpen = pairingTransitions
      .filter((transition) => transition.requiresOpenEvent)
      .map((transition) => transition.action);

    expect(needingOpen).toEqual([
      "request",
      "fulfil",
      "decline",
      "fail",
      "retry",
    ]);
  });
});

describe("openPairingStates", () => {
  // "Still open" is `requested` and only `requested`: a declined or fulfilled
  // pairing is finished, and a failed one is the owner's to retry.
  test("counts only a requested pairing as still open", () => {
    expect(openPairingStates).toEqual(["requested"]);
  });
});

describe("applyPairingAction", () => {
  // Acceptance scenario 2: the server's organisation records the identifier and
  // the pairing is fulfilled.
  test("fulfils a requested pairing for the server's organisation", () => {
    const result = applyPairingAction(facts());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.transition.to).toBe("fulfilled");
      expect(result.transition.recordsClientId).toBe(true);
    }
  });

  // Acceptance scenario 3: the same side may decline instead.
  test("declines a requested pairing for the server's organisation", () => {
    expect(outcome({ action: "decline" })).toBe("declined");
  });

  // FR-011: closing the event lapses what is still open, and the lapse is taken
  // for neither side, so no membership is consulted.
  test("lapses a requested pairing on a closed event", () => {
    expect(outcome({ action: "lapse", sides: [], eventStatus: "closed" })).toBe(
      "lapsed",
    );
  });

  // The owner's retry after a failed registration attempt (US5's failure path,
  // stated here because the transition belongs to the machine).
  test("returns a failed pairing to requested when the client owner retries", () => {
    expect(
      outcome({ action: "retry", state: "failed", sides: ["client"] }),
    ).toBe("requested");
  });

  // A fulfilled pairing is finished. Fulfilling it again is refused rather than
  // treated as a no-op, so nobody is left wondering which identifier is current.
  test("refuses to fulfil a pairing that is already fulfilled", () => {
    expect(outcome({ state: "fulfilled" })).toBe("illegal_transition");
  });

  // Every other move out of a settled state is refused the same way.
  test("refuses every move out of a settled state", () => {
    const settled: readonly PairingState[] = [
      "fulfilled",
      "declined",
      "lapsed",
    ];
    const actions: readonly PairingAction[] = [
      "fulfil",
      "decline",
      "fail",
      "retry",
      "lapse",
    ];

    for (const state of settled) {
      for (const action of actions) {
        expect(outcome({ state, action, sides: ["client", "server"] })).toBe(
          "illegal_transition",
        );
      }
    }
  });

  // A failed pairing takes a retry and nothing else: it cannot be fulfilled by
  // hand without the metadata being resubmitted.
  test("refuses to fulfil a failed pairing", () => {
    expect(outcome({ state: "failed" })).toBe("illegal_transition");
  });

  // A pairing that exists cannot be requested again; the duplicate rule is a
  // separate refusal, and this one is about the state.
  test("refuses to request a pairing that already has a state", () => {
    expect(
      outcome({ action: "request", state: "requested", sides: ["client"] }),
    ).toBe("illegal_transition");
  });

  // The wording names the state and the action, because "not allowed" leaves the
  // person guessing which of the two was wrong.
  test("names the state and the action in an illegal transition", () => {
    const result = applyPairingAction(facts({ state: "declined" }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusal.detail).toContain("declined");
      expect(result.refusal.detail).toContain("fulfil");
    }
  });

  // The app owner cannot fulfil their own request: only the server's
  // organisation issues a client identifier (FR-014).
  test("refuses a fulfilment by the client's organisation", () => {
    const result = applyPairingAction(facts({ sides: ["client"] }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusal.reason).toBe("wrong_side");
      expect(result.refusal.detail).toContain("server");
    }
  });

  // Nor can the server's organisation request or retry on the client's behalf.
  test("refuses a retry by the server's organisation", () => {
    expect(
      outcome({ action: "retry", state: "failed", sides: ["server"] }),
    ).toBe("wrong_side");
  });

  // A caller on neither side is refused before anything else is considered.
  test("refuses an action by an organisation on neither side", () => {
    expect(outcome({ sides: [] })).toBe("wrong_side");
  });

  // The edge case in the specification: one member belonging to both
  // organisations acts for either side.
  test("permits both sides' actions for a member of both organisations", () => {
    const sides: readonly PairingSide[] = ["client", "server"];

    expect(outcome({ sides })).toBe("fulfilled");
    expect(outcome({ action: "retry", state: "failed", sides })).toBe(
      "requested",
    );
  });

  // FR-011: a closed event takes nothing new, so a fulfilment against one is
  // refused with the event as the cause rather than the caller.
  test("refuses a fulfilment on a closed event", () => {
    const result = applyPairingAction(facts({ eventStatus: "closed" }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusal.reason).toBe("event_not_open");
      expect(result.refusal.detail).toContain("closed");
    }
  });

  // A draft event has never been open, and is refused for its own reason.
  test("refuses a fulfilment on a draft event", () => {
    expect(outcome({ eventStatus: "draft" })).toBe("event_not_open");
  });
});

describe("authorisePairingRequest", () => {
  // Acceptance scenario 1: an enrolled client, an enrolled manual-registration
  // server, one event.
  test("permits a request against an enrolled manual-registration server", () => {
    expect(authorisePairingRequest(requestFacts()).ok).toBe(true);
  });

  // A trusted-DCR server also takes requests; the difference is who fulfils it.
  test("permits a request against a trusted-DCR server", () => {
    expect(
      authorisePairingRequest(requestFacts({ registrationMode: "trustedDcr" }))
        .ok,
    ).toBe(true);
  });

  // FR-016, acceptance scenario 5: an open server needs no registration, so
  // there is nothing to request and the refusal says so.
  test("refuses a request against a server that needs no registration", () => {
    const decision = authorisePairingRequest(
      requestFacts({ registrationMode: "open" }),
    );

    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.refusal.reason).toBe("registration_not_needed");
      expect(decision.refusal.detail).toContain("no registration");
    }
  });

  // Acceptance scenario 6: pairings exist within a single event, so an enrolment
  // from elsewhere is refused rather than silently joined.
  test("refuses a request when the server is not enrolled in the event", () => {
    const decision = authorisePairingRequest(
      requestFacts({ serverEnrolledInEvent: false }),
    );

    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.refusal.reason).toBe("not_in_event");
      expect(decision.refusal.detail).toContain("server");
    }
  });

  test("refuses a request when the client is not enrolled in the event", () => {
    const decision = authorisePairingRequest(
      requestFacts({ clientEnrolledInEvent: false }),
    );

    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.refusal.reason).toBe("not_in_event");
      expect(decision.refusal.detail).toContain("client");
    }
  });

  // FR-015 and the specification's edge case: the second request for the same
  // client, server and event is refused, and the caller is pointed at the first.
  test("refuses a duplicate request for the same client, server and event", () => {
    const decision = authorisePairingRequest(
      requestFacts({ duplicateOf: "8f6b1c3e-0f2a-4c67-9f0f-3a5b6d7e8f90" }),
    );

    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.refusal.reason).toBe("duplicate_pairing");
      expect(decision.refusal.detail).toContain("already");
    }
  });

  // Deny by default: an absent duplicate has to be established as absent, so a
  // caller that has not looked cannot get a permission by omission. The rule is
  // ordered so the enrolments are checked before the mode, because a request
  // naming the wrong event is wrong whatever the mode says.
  test("reports the enrolment refusal before the registration mode", () => {
    const decision = authorisePairingRequest(
      requestFacts({ registrationMode: "open", serverEnrolledInEvent: false }),
    );

    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.refusal.reason).toBe("not_in_event");
    }
  });
});
