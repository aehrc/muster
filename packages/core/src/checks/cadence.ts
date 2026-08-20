/*
 * Copyright © 2026 Commonwealth Scientific and Industrial Research Organisation
 * (CSIRO) ABN 41 687 119 230. Licensed under the Apache License, Version 2.0.
 */

import type { EventStatus } from "@muster/contracts";

/**
 * How often an enrolled server is checked, and when the next check is due.
 *
 * Pure, over an injected clock, so the cadence is a rule rather than an
 * observation about a running process. SC-004 sets the requirement: an
 * unreachable server is flagged within one check interval, and that interval is
 * 15 minutes or less while an event is open. Outside an open event a daily check
 * is enough - nobody is waiting on the answer.
 *
 * The jitter is subtracted rather than added, which is the whole trick here. A
 * jitter that delayed a check would let the worst case drift past the 15 minutes
 * SC-004 promises; one that brings it forward spreads the load across the window
 * and keeps every interval inside the promise. It is derived from the target's
 * own identifier rather than from a random number, so a target keeps its slot
 * across restarts instead of hopping around the window on every boot.
 *
 * @author John Grimes
 */

/** How often an open event's entries are checked, at the outside (SC-004). */
export const openEventCheckIntervalMs = 15 * 60 * 1000;

/** How often the entries of an event that is not open are checked. */
export const idleEventCheckIntervalMs = 24 * 60 * 60 * 1000;

/** The share of an interval the jitter may bring a check forward by. */
const jitterShare = 5;

/** What deciding whether a check is due needs to know. */
export type CheckDueFacts = {
  /** the target's stable identifier, which fixes its slot in the window */
  readonly key: string;
  /** the status of the event the target is enrolled in */
  readonly eventStatus: EventStatus;
  /** when the target was last checked, null when it never has been */
  readonly lastCheckedAt: Date | null;
  /** the current instant */
  readonly now: Date;
};

/**
 * The interval between checks of an entry in an event of this status.
 *
 * @param eventStatus - the event's status
 * @returns the interval in milliseconds
 * @example
 * ```ts
 * checkIntervalMs("open"); // 900000
 * ```
 */
export const checkIntervalMs = (eventStatus: EventStatus): number =>
  eventStatus === "open" ? openEventCheckIntervalMs : idleEventCheckIntervalMs;

/**
 * The jitter that brings one target's check forward.
 *
 * @param key - the target's stable identifier
 * @param intervalMs - the interval the jitter is a share of
 * @returns a value in [0, intervalMs / 5), the same one every time for a key
 * @example
 * ```ts
 * checkJitterMs(enrolmentId, openEventCheckIntervalMs);
 * ```
 */
export const checkJitterMs = (key: string, intervalMs: number): number => {
  // FNV-1a: a few lines, no dependency, and spread enough for a few hundred
  // targets. Nothing here is a security decision.
  let hash = 0x81_1c_9d_c5;
  for (const character of key) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01_00_01_93) >>> 0;
  }
  return hash % Math.floor(intervalMs / jitterShare);
};

/**
 * Reports whether a target is due for a check.
 *
 * A target nothing has ever checked is due at once: an entry with no status at
 * all is the worst thing for a reader to be shown.
 *
 * @param facts - the target, its event's status, its last check and the clock
 * @returns true when the check should run now
 * @example
 * ```ts
 * if (checkDue({ key: target.enrolmentId, eventStatus, lastCheckedAt, now })) {
 *   await checkTarget(target);
 * }
 * ```
 */
export const checkDue = (facts: CheckDueFacts): boolean => {
  if (facts.lastCheckedAt === null) {
    return true;
  }
  const intervalMs = checkIntervalMs(facts.eventStatus);
  const dueAfterMs = intervalMs - checkJitterMs(facts.key, intervalMs);
  return facts.now.getTime() - facts.lastCheckedAt.getTime() >= dueAfterMs;
};
