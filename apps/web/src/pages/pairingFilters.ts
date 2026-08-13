/**
 * Filtering and counting the pairing list.
 *
 * The wireframe's two rows of chips filter the table in place, with counts that move as pairings
 * change state. Three interacting decisions over a list, so they are pure functions with tests
 * rather than conditions written inline in a component.
 *
 * The direction chips deserve a note. "As app owner" is not the same question as "who requested
 * it": a member of both organisations in a pairing holds both sides (spec edge case), so the
 * filter asks which sides the caller holds - which the server has already computed from the same
 * rules that decide who may answer.
 *
 * Author: John Grimes
 */

import type {
  PairingSideName,
  PairingState,
  PairingSummary,
} from "@muster/contracts";

/** A state chip, or the one that shows every state. */
export type PairingStateChip = "all" | PairingState;

/** What the chips are currently asking for. */
export interface PairingFilter {
  readonly state: PairingStateChip;
  /** `all`, or the side the caller wants to see themselves acting as. */
  readonly direction: "all" | PairingSideName;
}

/** Nothing filtered. */
export const NO_PAIRING_FILTER: PairingFilter = {
  state: "all",
  direction: "all",
};

/**
 * Every state, in the order `data-model.md` names them.
 *
 * Declared here rather than imported from `@muster/core` so that the chips' order is the
 * console's decision: it is a display order, and tying it to the domain would mean a change to one
 * quietly changing the other.
 */
const STATES: readonly PairingState[] = [
  "requested",
  "fulfilled",
  "declined",
  "failed",
  "lapsed",
];

/** The state chips, in the order the wireframe shows them. */
export const PAIRING_STATE_CHIPS: readonly PairingStateChip[] = [
  "all",
  ...STATES,
];

/**
 * How many pairings hold each state.
 *
 * Every state is present, including the ones with none: the chips show their counts, and a chip
 * whose count was absent rather than zero would render as blank.
 *
 * @param pairings - Every pairing the caller is party to.
 * @returns The count per state.
 * @example
 * ```ts
 * const counts = countByState(pairings);
 * <TagToggle label={`${describePairingState(state)} ${counts[state]}`} … />
 * ```
 */
export function countByState(
  pairings: readonly PairingSummary[],
): Readonly<Record<PairingState, number>> {
  const counts = Object.fromEntries(
    STATES.map((state) => [state, 0]),
  ) as Record<PairingState, number>;
  for (const pairing of pairings) {
    counts[pairing.state] += 1;
  }
  return counts;
}

/**
 * How many pairings the caller can act on now.
 *
 * Read off the actions the server offered rather than computed from the state, so the number the
 * page leads with counts exactly the rows that show a Respond action.
 *
 * @param pairings - Every pairing the caller is party to.
 * @returns How many are waiting on the caller.
 */
export function outstandingCount(pairings: readonly PairingSummary[]): number {
  return pairings.filter((pairing) => pairing.actions.length > 0).length;
}

/**
 * The pairings the chips admit, in the order they arrived.
 *
 * The order is preserved because the list arrives newest activity first, and a filter that
 * re-sorted would move rows around as the chips were clicked.
 *
 * @param pairings - Every pairing the caller is party to.
 * @param filter - What the chips are asking for.
 * @returns The subset to render.
 * @example
 * ```ts
 * const shown = filterPairings(pairings, { state: "requested", direction: "server" });
 * ```
 */
export function filterPairings(
  pairings: readonly PairingSummary[],
  filter: PairingFilter,
): readonly PairingSummary[] {
  return pairings.filter(
    (pairing) =>
      (filter.state === "all" || pairing.state === filter.state) &&
      (filter.direction === "all" || pairing.sides.includes(filter.direction)),
  );
}

/**
 * How a state reads in a chip or a badge.
 *
 * @param state - The state, or `all` for the chip that filters nothing.
 * @returns The label.
 * @example
 * ```ts
 * describePairingState("requested"); // "Requested"
 * ```
 */
export function describePairingState(state: PairingStateChip): string {
  switch (state) {
    case "all": {
      return "All";
    }
    case "requested": {
      return "Requested";
    }
    case "fulfilled": {
      return "Fulfilled";
    }
    case "declined": {
      return "Declined";
    }
    case "failed": {
      return "Failed";
    }
    default: {
      return "Lapsed";
    }
  }
}
