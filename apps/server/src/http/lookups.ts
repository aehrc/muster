import {
  findEventBySlug,
  findPairingRecord,
  findSystemById,
  listCheckStatuses,
  listEnrolledSystems,
  listLatestHarnessRuns,
} from "@muster/db";
import { HTTPException } from "hono/http-exception";

import type { AppEnvironment } from "../app.ts";
import type {
  CheckStatusRow,
  EnrolledSystemRow,
  EventRow,
  HarnessRunRow,
  PairingRecordRow,
  SystemRow,
} from "@muster/db";
import type { SQL } from "bun";
import type { Context } from "hono";

/**
 * Reading the records a route was addressed to, or refusing.
 *
 * Every route that names an event or a system in its path has to answer the same
 * question first - does it exist - and has to answer it the same way, because a
 * 404 that reads differently depending on which route produced it tells the
 * caller nothing extra and gives the console two shapes to handle. One module
 * holds those lookups, so the routes a member drives and the public read API
 * cannot drift on what "no such event" means.
 *
 * @author John Grimes
 */

/**
 * Finds an event by slug, or refuses.
 *
 * @param context - the request being answered
 * @param slug - the event's slug
 * @returns the event
 * @throws {HTTPException} 404 when there is no such event
 * @example
 * ```ts
 * const event = await requireEvent(context, context.req.param("slug"));
 * ```
 */
export const requireEvent = async (
  context: Context<AppEnvironment>,
  slug: string,
): Promise<EventRow> => {
  const event = await findEventBySlug(context.get("sql"), slug);
  if (event === undefined) {
    throw new HTTPException(404, { message: "No such event." });
  }
  return event;
};

/**
 * Finds a system by identifier, or refuses.
 *
 * @param context - the request being answered
 * @param id - the system identifier
 * @returns the system
 * @throws {HTTPException} 404 when there is no such system
 * @example
 * ```ts
 * const system = await requireSystem(context, context.req.param("id"));
 * ```
 */
export const requireSystem = async (
  context: Context<AppEnvironment>,
  id: string,
): Promise<SystemRow> => {
  const system = await findSystemById(context.get("sql"), id);
  if (system === undefined) {
    throw new HTTPException(404, { message: "No such system." });
  }
  return system;
};

/**
 * Finds a pairing with both its sides, or refuses.
 *
 * Whether the caller may see it is a separate question, asked by the routes
 * against the sides this returns.
 *
 * @param context - the request being answered
 * @param id - the pairing identifier
 * @returns the pairing and its two sides
 * @throws {HTTPException} 404 when there is no such pairing
 * @example
 * ```ts
 * const record = await requirePairingRecord(context, context.req.param("id"));
 * ```
 */
export const requirePairingRecord = async (
  context: Context<AppEnvironment>,
  id: string,
): Promise<PairingRecordRow> => {
  const record = await findPairingRecord(context.get("sql"), id);
  if (record === undefined) {
    throw new HTTPException(404, { message: "No such pairing." });
  }
  return record;
};

/** One enrolled system, with the latest check and conformance run of it. */
export type EnrolledEntry = {
  /** the enrolment joined to its system and organisation */
  readonly row: EnrolledSystemRow;
  /** the latest check, absent when nothing has checked the entry */
  readonly check: CheckStatusRow | undefined;
  /** the latest conformance run, absent when none has been run */
  readonly conformance: HarnessRunRow | undefined;
};

/**
 * Lists an event's enrolled systems, each with its latest check and run.
 *
 * Three queries rather than three per entry: the statuses and the conformance
 * verdicts each arrive as one set and are matched to the entries here. Both the
 * event view and the brands bundle need exactly this, so neither has to remember
 * how to join them.
 *
 * @param sql - a connection
 * @param eventId - the event whose enrolments are wanted
 * @returns the entries, in the order the repository lists them
 * @example
 * ```ts
 * const entries = await listEnrolledEntries(context.get("sql"), event.id);
 * ```
 */
export const listEnrolledEntries = async (
  sql: SQL,
  eventId: string,
): Promise<EnrolledEntry[]> => {
  const [rows, statuses, verdicts] = await Promise.all([
    listEnrolledSystems(sql, eventId),
    listCheckStatuses(sql, eventId),
    listLatestHarnessRuns(sql, eventId),
  ]);
  const checks = new Map(
    statuses.map((status) => [status.latest.enrolmentId, status]),
  );
  const runs = new Map(verdicts.map((run) => [run.enrolmentId, run]));
  return rows.map((row) => ({
    row,
    check: checks.get(row.enrolmentId),
    conformance: runs.get(row.enrolmentId),
  }));
};
