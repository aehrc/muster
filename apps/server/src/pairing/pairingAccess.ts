/**
 * Resolving the pairing a request names, and describing it back.
 *
 * Both halves are here rather than in either route module, because the tracker
 * (`routes.ts`) and the trusted-DCR run (`dcr.routes.ts`) act on the same rows and must
 * agree about two things exactly.
 *
 * **Who may see a pairing, and what a stranger is told.** A pairing somebody is not party
 * to answers 404 rather than 403: a 403 would confirm that two named organisations are
 * negotiating, which anybody with an account could then enumerate. One implementation, so
 * one route cannot answer differently from the other.
 *
 * **What a pairing looks like in a response.** Every mutation returns the pairing as it now
 * stands (`contracts/http-api.md`), and "as it now stands" includes the timeline, the scope
 * warning and the latest software statement. A second copy of that assembly would drift,
 * and the half that drifted would be the half that tells a member what actions they have.
 *
 * Author: John Grimes
 */

import {
  findCheckStatus,
  findLatestSoftwareStatement,
  findPairing,
  listOrganisationsForAccount,
  listPairingTimeline,
} from "@muster/db";

import { callerAccount } from "../admin/access.js";
import { jsonError } from "../http/errors.js";
import { isIdentifier } from "../http/identifiers.js";
import {
  pairingDetailView,
  pairingScopeWarning,
  pairingSides,
} from "../http/views.js";

import type { MusterEnvironment, ServerContext } from "../context.js";
import type { PairingViewer } from "../http/views.js";
import type { PairingDetail } from "@muster/contracts";
import type { PairingWithSides } from "@muster/db";
import type { Context } from "hono";

/** A pairing the caller is party to, and who they are looking at it as. */
export interface CallerPairing {
  readonly row: PairingWithSides;
  readonly viewer: PairingViewer;
}

/**
 * The pairing named in the path, and the sides the caller holds.
 *
 * @param context - The server's dependencies.
 * @param c - The request, which must have passed `requireApproved`.
 * @param pairingId - The identifier from the path.
 * @returns The pairing and the viewer, or the refusal to return from the handler.
 * @example
 * ```ts
 * const found = await callerPairing(context, c, c.req.param("id"));
 * if (found instanceof Response) {
 *   return found;
 * }
 * ```
 */
export async function callerPairing(
  context: ServerContext,
  c: Context<MusterEnvironment>,
  pairingId: string,
): Promise<CallerPairing | Response> {
  const account = callerAccount(c);
  const row = isIdentifier(pairingId)
    ? await findPairing(context.db, pairingId)
    : undefined;
  const mine =
    row === undefined
      ? []
      : await listOrganisationsForAccount(context.db, account.id);
  const sides =
    row === undefined
      ? []
      : pairingSides(
          row,
          mine.map((organisation) => organisation.id),
        );
  if (row === undefined || sides.length === 0) {
    // One answer for both cases. See the module header.
    return jsonError(c, 404, "not_found", "No pairing of yours has that id");
  }
  return {
    row,
    viewer: { sides, standing: account, now: context.clock() },
  };
}

/**
 * A pairing in full, with its history, its scope warning and its statement.
 *
 * The warning comes from the latest check on the *server* side's enrolment (FR-019), and it
 * is the same value whichever side asked: both parties are warned, because an app owner who
 * cannot see it goes on believing the pairing will work and a server owner who cannot see
 * it is asked to register something their own server will refuse.
 *
 * @param context - The server's dependencies.
 * @param row - The pairing with both sides.
 * @param viewer - Who is looking, and when.
 * @returns The response body's `pairing`.
 * @example
 * ```ts
 * return c.json({ pairing: await pairingResponse(context, row, viewer) });
 * ```
 */
export async function pairingResponse(
  context: ServerContext,
  row: PairingWithSides,
  viewer: PairingViewer,
): Promise<PairingDetail> {
  const [timeline, status, statement] = await Promise.all([
    listPairingTimeline(context.db, row.pairing.id),
    findCheckStatus(context.db, row.server.enrolment.id),
    findLatestSoftwareStatement(context.db, row.pairing.id),
  ]);
  return pairingDetailView(
    row,
    viewer,
    timeline,
    pairingScopeWarning(row, status),
    statement,
  );
}
