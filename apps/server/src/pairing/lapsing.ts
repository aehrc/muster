/*
 * Copyright © 2026 Commonwealth Scientific and Industrial Research Organisation
 * (CSIRO) ABN 41 687 119 230. Licensed under the Apache License, Version 2.0.
 */

import { applyPairingAction, openPairingStates } from "@muster/core";
import {
  insertPairingEvent,
  listPairingsInState,
  updatePairingState,
} from "@muster/db";

import type { EventStatus } from "@muster/contracts";
import type { SQL } from "bun";

/**
 * What closing an event does to the pairings still open in it.
 *
 * FR-011: a closed event keeps its records readable, takes nothing new, and marks
 * still-open pairings as lapsed. Lapsing is a transition like any other, so it
 * goes through the same state machine and lands on the same timeline - both
 * parties see why their pairing stopped rather than finding it stuck at
 * "requested" for ever.
 *
 * The state machine is asked per pairing rather than the states being updated in
 * one statement, because the machine is the only thing entitled to say what a
 * pairing may move to, and a bulk update would be a second, quieter answer to
 * that question.
 *
 * @author John Grimes
 */

/** What lapsing needs to know. */
export type LapseOptions = {
  /** the event that has closed */
  readonly eventId: string;
  /** the event's status, which the state machine consults */
  readonly eventStatus: EventStatus;
  /** the admin who closed it, null when Muster closed it on the dates */
  readonly actorAccountId: string | null;
};

/**
 * Lapses every pairing still open in an event.
 *
 * @param sql - a connection
 * @param options - the event, its status, and who closed it
 * @returns how many pairings lapsed
 * @example
 * ```ts
 * await lapseOpenPairings(sql, {
 *   eventId: event.id,
 *   eventStatus: event.status,
 *   actorAccountId: admin.id,
 * });
 * ```
 */
export const lapseOpenPairings = async (
  sql: SQL,
  options: LapseOptions,
): Promise<number> => {
  const open = await listPairingsInState(sql, {
    eventId: options.eventId,
    states: openPairingStates,
  });

  let lapsed = 0;
  for (const pairing of open) {
    const result = applyPairingAction({
      action: "lapse",
      state: pairing.state,
      // Nobody acts for a side: an event closing is Muster's own doing, which is
      // also why the timeline entry carries no organisation.
      sides: [],
      eventStatus: options.eventStatus,
    });
    if (!result.ok) {
      continue;
    }
    await updatePairingState(sql, {
      id: pairing.id,
      state: result.transition.to,
    });
    await insertPairingEvent(sql, {
      pairingId: pairing.id,
      actorAccountId: options.actorAccountId,
      actingForOrganisationId: null,
      fromState: pairing.state,
      toState: result.transition.to,
      detail: { reason: "The event closed." },
    });
    lapsed += 1;
  }
  return lapsed;
};
