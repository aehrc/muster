/**
 * Filtering and counting the pairing list.
 *
 * The wireframe's two rows of chips - one per state, one per direction - filter the table in
 * place with counts that move as pairings change state. That is two interacting conditions over a
 * list plus an aggregate, which is either a pure function with tests or a source of "why is this
 * row still showing" reports.
 *
 * Author: John Grimes
 */

import { describe, expect, it } from "bun:test";

import {
  countByState,
  describePairingState,
  filterPairings,
  NO_PAIRING_FILTER,
  outstandingCount,
  PAIRING_STATE_CHIPS,
} from "./pairingFilters.js";

import type { PairingSummary } from "@muster/contracts";

/** A pairing row, with only the fields the filters read. */
function row(
  id: string,
  state: PairingSummary["state"],
  sides: PairingSummary["sides"],
  actions: PairingSummary["actions"] = [],
): PairingSummary {
  return {
    id,
    event: {
      slug: "sparked-2026-09",
      name: "Sparked Connectathon September 2026",
      startsOn: "2026-09-15",
      endsOn: "2026-09-19",
      status: "open",
    },
    state,
    client: {
      enrolmentId: `${id}-client`,
      systemId: `${id}-client-system`,
      name: "Smart Forms",
      organisation: { id: "org-csiro", name: "CSIRO" },
    },
    server: {
      enrolmentId: `${id}-server`,
      systemId: `${id}-server-system`,
      name: "MediRecords FHIR",
      organisation: { id: "org-mr", name: "MediRecords" },
    },
    clientId: null,
    declineReason: null,
    sides,
    actions,
    requestedAt: "2026-09-03T10:12:00.000Z",
    updatedAt: "2026-09-03T10:12:00.000Z",
  };
}

const pairings: readonly PairingSummary[] = [
  row("a", "requested", ["client"]),
  row("b", "fulfilled", ["client"]),
  row("c", "requested", ["server"], ["fulfil", "decline"]),
  row("d", "lapsed", ["client", "server"]),
];

describe("filterPairings", () => {
  it("shows everything when nothing is filtered", () => {
    expect(filterPairings(pairings, NO_PAIRING_FILTER)).toHaveLength(4);
  });

  it("narrows to one state", () => {
    expect(
      filterPairings(pairings, {
        ...NO_PAIRING_FILTER,
        state: "requested",
      }).map((one) => one.id),
    ).toEqual(["a", "c"]);
  });

  it("narrows to the direction the caller is acting in", () => {
    // "As app owner" means the pairings where the caller holds the client side.
    expect(
      filterPairings(pairings, {
        ...NO_PAIRING_FILTER,
        direction: "client",
      }).map((one) => one.id),
    ).toEqual(["a", "b", "d"]);
    expect(
      filterPairings(pairings, {
        ...NO_PAIRING_FILTER,
        direction: "server",
      }).map((one) => one.id),
    ).toEqual(["c", "d"]);
  });

  it("shows a pairing in both directions to a member of both organisations", () => {
    // The spec's edge case: one person in both organisations sees both sides of one pairing, so
    // it appears whichever direction they filter by.
    const both = [
      ...filterPairings(pairings, {
        ...NO_PAIRING_FILTER,
        direction: "client",
      }),
      ...filterPairings(pairings, {
        ...NO_PAIRING_FILTER,
        direction: "server",
      }),
    ];
    expect(both.filter((one) => one.id === "d")).toHaveLength(2);
  });

  it("combines the state and the direction", () => {
    expect(
      filterPairings(pairings, { state: "requested", direction: "server" }).map(
        (one) => one.id,
      ),
    ).toEqual(["c"]);
  });

  it("keeps the order it was given", () => {
    // The list arrives newest activity first, and a filter that re-sorted would move rows as
    // chips were clicked.
    expect(
      filterPairings(pairings, NO_PAIRING_FILTER).map((one) => one.id),
    ).toEqual(["a", "b", "c", "d"]);
  });
});

describe("countByState", () => {
  it("counts every state the chips offer, including the empty ones", () => {
    // The chips show their counts, so a state with none has to be zero rather than absent.
    expect(countByState(pairings)).toEqual({
      requested: 2,
      fulfilled: 1,
      declined: 0,
      failed: 0,
      lapsed: 1,
    });
  });

  it("counts nothing for an empty list", () => {
    expect(countByState([])).toEqual({
      requested: 0,
      fulfilled: 0,
      declined: 0,
      failed: 0,
      lapsed: 0,
    });
  });
});

describe("outstandingCount", () => {
  it("counts the pairings the caller can act on now", () => {
    // What the page leads with: a member wants to know how many requests are waiting for them,
    // not how many pairings exist. Computed from the actions the server offered.
    expect(outstandingCount(pairings)).toBe(1);
  });

  it("counts none when nothing is waiting on the caller", () => {
    expect(outstandingCount([row("a", "requested", ["client"])])).toBe(0);
  });
});

describe("PAIRING_STATE_CHIPS", () => {
  it("offers every state, after the all-states chip", () => {
    expect([...PAIRING_STATE_CHIPS]).toEqual([
      "all",
      "requested",
      "fulfilled",
      "declined",
      "failed",
      "lapsed",
    ]);
  });
});

describe("describePairingState", () => {
  it("says what each state means to a reader", () => {
    expect(describePairingState("requested")).toBe("Requested");
    expect(describePairingState("fulfilled")).toBe("Fulfilled");
    expect(describePairingState("declined")).toBe("Declined");
    expect(describePairingState("failed")).toBe("Failed");
    expect(describePairingState("lapsed")).toBe("Lapsed");
  });

  it("labels the all-states chip", () => {
    expect(describePairingState("all")).toBe("All");
  });
});
