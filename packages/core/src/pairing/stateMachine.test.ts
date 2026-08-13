/**
 * The pairing state machine: what may happen, who may make it happen, and who hears.
 *
 * FR-013 names five states and `data-model.md` names exactly five transitions between them.
 * Everything else is refused, and that is what most of these cases assert: the machine is
 * enumerated both ways round, so a transition added to the table without a decision about who
 * may make it fails here rather than at a connectathon.
 *
 * The other subject is the request refusal. A pairing exists inside one event (FR-012), an
 * open-registration server needs no pairing at all (FR-016), and a closed event takes nothing
 * new (FR-011) - three refusals that the route must not be the only thing holding.
 *
 * Author: John Grimes
 */

import { describe, expect, it } from "bun:test";

import {
  canTransition,
  lapsesOnEventClose,
  PAIRING_SIDES,
  PAIRING_STATES,
  pairingRequestRefusal,
  pairingTransition,
  REQUEST_NOTIFIES,
  transitionRefusal,
} from "./stateMachine.js";

import type { PairingRequestSides, PairingState } from "./stateMachine.js";

/** The five transitions `data-model.md` names, as `from -> to`. */
const LEGAL: readonly (readonly [PairingState, PairingState])[] = [
  ["requested", "fulfilled"],
  ["requested", "declined"],
  ["requested", "failed"],
  ["failed", "requested"],
  ["requested", "lapsed"],
];

/** A request whose every precondition holds, for the cases that break one of them. */
function validRequest(
  overrides: {
    readonly eventStatus?: PairingRequestSides["eventStatus"];
    readonly client?: Partial<PairingRequestSides["client"]>;
    readonly server?: Partial<PairingRequestSides["server"]>;
  } = {},
): PairingRequestSides {
  return {
    eventId: "event-1",
    eventStatus: overrides.eventStatus ?? "open",
    client: { eventId: "event-1", isClient: true, ...overrides.client },
    server: {
      eventId: "event-1",
      isServer: true,
      registrationMode: "manual",
      ...overrides.server,
    },
  };
}

describe("PAIRING_STATES", () => {
  it("is exactly the vocabulary FR-013 names", () => {
    // The console filters on these and the database enum mirrors them; a sixth state
    // appearing in one of the three and not the others is the failure this pins.
    expect([...PAIRING_STATES]).toEqual([
      "requested",
      "fulfilled",
      "declined",
      "failed",
      "lapsed",
    ]);
  });
});

describe("pairingTransition", () => {
  it("admits exactly the five transitions the data model names", () => {
    for (const [from, to] of LEGAL) {
      expect(pairingTransition(from, to)).toBeDefined();
    }
  });

  it("refuses every other pair of states", () => {
    // Enumerated rather than sampled: this is the whole point of a state machine, and a
    // spot check would miss the one transition somebody adds by accident.
    const legal = new Set(LEGAL.map(([from, to]) => `${from}->${to}`));
    for (const from of PAIRING_STATES) {
      for (const to of PAIRING_STATES) {
        if (!legal.has(`${from}->${to}`)) {
          expect(pairingTransition(from, to)).toBeUndefined();
        }
      }
    }
  });

  it("refuses a transition to the state already held", () => {
    // Fulfilling a fulfilled pairing would overwrite the recorded client identifier and
    // notify the app owner a second time about something that already happened.
    for (const state of PAIRING_STATES) {
      expect(canTransition(state, state)).toBe(false);
    }
  });

  it("gives the server side the answer to a request", () => {
    // FR-014: the server's organisation records the identifier or declines with a reason.
    expect(pairingTransition("requested", "fulfilled")?.by).toBe("server");
    expect(pairingTransition("requested", "declined")?.by).toBe("server");
  });

  it("gives the client side the registration attempt and the retry", () => {
    // The app owner runs the trusted-DCR attempt and fixes the metadata afterwards, so both
    // the failure and the retry are theirs to make.
    expect(pairingTransition("requested", "failed")?.by).toBe("client");
    expect(pairingTransition("failed", "requested")?.by).toBe("client");
  });

  it("gives lapsing to nobody", () => {
    // An event closing is not an action either organisation takes, so no side may ask for it
    // and neither can be refused for not being the right one (FR-011).
    expect(pairingTransition("requested", "lapsed")?.by).toBe("none");
  });

  it("notifies the counterparty of an answer and the requester of a retry", () => {
    // FR-014, from both directions: whoever did not act is the one who has to be told.
    expect(pairingTransition("requested", "fulfilled")?.notifies).toEqual([
      "client",
    ]);
    expect(pairingTransition("requested", "declined")?.notifies).toEqual([
      "client",
    ]);
    // A rejected trusted-DCR attempt tells the server's organisation: their endpoint refused
    // a statement, which is usually theirs to fix, and the app owner is watching the attempt
    // and reads the failure in its response.
    expect(pairingTransition("requested", "failed")?.notifies).toEqual([
      "server",
    ]);
    expect(pairingTransition("failed", "requested")?.notifies).toEqual([
      "server",
    ]);
  });

  it("notifies both sides that a pairing lapsed", () => {
    // Neither side chose it, so neither side already knows.
    expect([
      ...(pairingTransition("requested", "lapsed")?.notifies ?? []),
    ]).toEqual(["client", "server"]);
  });

  it("tells somebody about every transition", () => {
    // FR-014 says every transition notifies the counterparty. A transition that told nobody
    // would be one both parties find out about by refreshing the page.
    for (const [from, to] of LEGAL) {
      expect(pairingTransition(from, to)?.notifies.length ?? 0).toBeGreaterThan(
        0,
      );
    }
  });

  it("never asks the side that acted to notify itself", () => {
    for (const [from, to] of LEGAL) {
      const transition = pairingTransition(from, to);
      if (transition !== undefined && transition.by !== "none") {
        expect(transition.notifies).not.toContain(transition.by);
      }
    }
  });
});

describe("REQUEST_NOTIFIES", () => {
  it("tells the server's organisation about a new request", () => {
    // Scenario 1: creating a pairing is not a transition between states, and it still has to
    // reach the people who can answer it.
    expect([...REQUEST_NOTIFIES]).toEqual(["server"]);
  });
});

describe("transitionRefusal", () => {
  it("admits a legal transition asked for by the right side", () => {
    expect(
      transitionRefusal("requested", "fulfilled", ["server"]),
    ).toBeUndefined();
    expect(
      transitionRefusal("failed", "requested", ["client"]),
    ).toBeUndefined();
  });

  it("admits it for a member who holds both sides", () => {
    // A member may belong to both organisations in a pairing (spec edge case), and then
    // either side's actions are theirs to take.
    expect(
      transitionRefusal("requested", "declined", ["client", "server"]),
    ).toBeUndefined();
  });

  it("refuses the app owner fulfilling their own request", () => {
    // The whole point of the workflow: the identifier is the server's to issue.
    expect(transitionRefusal("requested", "fulfilled", ["client"])).toBe(
      "wrong_side",
    );
    expect(transitionRefusal("requested", "declined", ["client"])).toBe(
      "wrong_side",
    );
  });

  it("refuses the server owner retrying the client's registration", () => {
    expect(transitionRefusal("failed", "requested", ["server"])).toBe(
      "wrong_side",
    );
  });

  it("refuses somebody who holds no side at all", () => {
    expect(transitionRefusal("requested", "fulfilled", [])).toBe("wrong_side");
  });

  it("refuses either side asking for a lapse", () => {
    // Lapsing follows from an event closing. A participant who could ask for it directly
    // could retire a pairing the counterparty was still working on.
    for (const sides of [
      ["client"],
      ["server"],
      ["client", "server"],
    ] as const) {
      expect(transitionRefusal("requested", "lapsed", sides)).toBe(
        "wrong_side",
      );
    }
  });

  it("reports an illegal transition before it considers the side", () => {
    // A member of neither organisation asking for something impossible is told what is
    // impossible: the state is the thing they can check, and their standing is not.
    expect(transitionRefusal("fulfilled", "declined", [])).toBe(
      "illegal_transition",
    );
    expect(transitionRefusal("lapsed", "requested", ["client"])).toBe(
      "illegal_transition",
    );
  });

  it("refuses answering a pairing that has already been answered", () => {
    // Two members of the server's organisation answering at once: the second is told the
    // pairing has moved on rather than silently overwriting the first answer.
    expect(transitionRefusal("fulfilled", "fulfilled", ["server"])).toBe(
      "illegal_transition",
    );
    expect(transitionRefusal("declined", "fulfilled", ["server"])).toBe(
      "illegal_transition",
    );
  });
});

describe("lapsesOnEventClose", () => {
  it("lapses a pairing still waiting for an answer", () => {
    // FR-011: closing an event marks still-open pairings lapsed.
    expect(lapsesOnEventClose("requested")).toBe(true);
  });

  it("leaves every settled pairing alone", () => {
    // A fulfilled pairing is a fact about the event that happened, and a declined or failed
    // one is a record worth keeping; none of them becomes lapsed by the event ending.
    expect(lapsesOnEventClose("fulfilled")).toBe(false);
    expect(lapsesOnEventClose("declined")).toBe(false);
    expect(lapsesOnEventClose("failed")).toBe(false);
    expect(lapsesOnEventClose("lapsed")).toBe(false);
  });

  it("agrees with the transition table", () => {
    // Whatever lapses must have a legal path to `lapsed`, or closing an event would try to
    // make a transition the machine refuses.
    for (const state of PAIRING_STATES) {
      expect(lapsesOnEventClose(state)).toBe(canTransition(state, "lapsed"));
    }
  });
});

describe("pairingRequestRefusal", () => {
  it("admits a client and a manual server enrolled in one open event", () => {
    // Scenario 1, the happy path.
    expect(pairingRequestRefusal(validRequest())).toBeUndefined();
  });

  it("admits a trusted-DCR server", () => {
    // The zero-touch path still starts as a pairing request; only the fulfilment differs.
    expect(
      pairingRequestRefusal(
        validRequest({ server: { registrationMode: "trustedDcr" } }),
      ),
    ).toBeUndefined();
  });

  it("refuses a server that needs no registration", () => {
    // FR-016 and scenario 5: an open-registration server accepts any client, so a pairing
    // request against it is a promise of an answer that will never come. Refused here as
    // well as hidden in the console, because the console is not a security boundary.
    expect(
      pairingRequestRefusal(
        validRequest({ server: { registrationMode: "open" } }),
      ),
    ).toBe("no_registration_needed");
  });

  it("refuses a closed event", () => {
    // FR-011: a closed event keeps its records readable and takes nothing new.
    expect(pairingRequestRefusal(validRequest({ eventStatus: "closed" }))).toBe(
      "event_not_open",
    );
  });

  it("refuses a draft event", () => {
    expect(pairingRequestRefusal(validRequest({ eventStatus: "draft" }))).toBe(
      "event_not_open",
    );
  });

  it("refuses a server enrolled in a different event", () => {
    // Scenario 6: pairings exist within a single event.
    expect(
      pairingRequestRefusal(validRequest({ server: { eventId: "event-2" } })),
    ).toBe("cross_event");
  });

  it("refuses a client enrolled in a different event", () => {
    expect(
      pairingRequestRefusal(validRequest({ client: { eventId: "event-2" } })),
    ).toBe("cross_event");
  });

  it("refuses a client side that is not a client", () => {
    // A server-only system has no launch URL, no redirect URIs and no scopes, so there is
    // nothing to register.
    expect(
      pairingRequestRefusal(validRequest({ client: { isClient: false } })),
    ).toBe("not_a_client");
  });

  it("refuses a server side that is not a server", () => {
    expect(
      pairingRequestRefusal(validRequest({ server: { isServer: false } })),
    ).toBe("not_a_server");
  });

  it("reports the closed event before anything else", () => {
    // The order is the message the requester acts on. Nothing about a closed event can be
    // fixed by choosing a different server.
    expect(
      pairingRequestRefusal(
        validRequest({
          eventStatus: "closed",
          server: { registrationMode: "open", eventId: "event-2" },
        }),
      ),
    ).toBe("event_not_open");
  });
});

describe("PAIRING_SIDES", () => {
  it("names both halves", () => {
    expect([...PAIRING_SIDES]).toEqual(["client", "server"]);
  });
});
