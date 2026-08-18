import { findEventBySlug, findPairingRecord, findSystemById } from "@muster/db";
import { HTTPException } from "hono/http-exception";

import type { AppEnvironment } from "../app.ts";
import type { EventRow, PairingRecordRow, SystemRow } from "@muster/db";
import type { Context } from "hono";

/**
 * Finding the records a route was addressed to, or refusing.
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
