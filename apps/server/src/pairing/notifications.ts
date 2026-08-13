/**
 * Telling the other side.
 *
 * FR-014 requires the counterparty to be notified on every transition, and "the counterparty" is
 * a property of the transition rather than of the request that caused it - so which sides to tell
 * comes from the state machine in `@muster/core` and every caller passes what it said.
 *
 * Two decisions are worth stating.
 *
 * **Every member of the organisation is told, not one of them.** Any member may answer their
 * organisation's pairings (FR-005), so a notice addressed to whoever happened to create the
 * system would be a notice the person on leave that week receives.
 *
 * **A failed send does not fail the transition.** The pairing has already moved and the record
 * is what matters; re-sending an email is not something the actor could do from here anyway. So
 * the outcome is reported back - `notified` in the response body (FR-037) - rather than thrown.
 *
 * Author: John Grimes
 */

import { pairingTransition } from "@muster/core";
import { listOrganisationMembers } from "@muster/db";

import { pairingMessage } from "../mail/messages.js";

import type { ServerContext } from "../context.js";
import type { PairingNoticeKind } from "../mail/messages.js";
import type { PairingSideName } from "@muster/contracts";
import type { PairingSide } from "@muster/core";
import type { PairingWithSides } from "@muster/db";

/**
 * Who a lapse tells: both organisations.
 *
 * Read off the transition table rather than restated, so it cannot disagree with what the
 * timeline says the transition notified.
 */
export const LAPSE_NOTIFIES: readonly PairingSide[] =
  pairingTransition("requested", "lapsed")?.notifies ?? [];

/** The organisation on one side of a pairing. */
function organisationFor(row: PairingWithSides, side: PairingSideName): string {
  return side === "client"
    ? row.client.organisation.id
    : row.server.organisation.id;
}

/**
 * Tells the named sides' organisations what happened to a pairing.
 *
 * @param context - The server's dependencies.
 * @param row - The pairing, after the transition, with both sides.
 * @param kind - Which transition to describe.
 * @param sides - The sides to notify, as the state machine named them.
 * @returns Whether every message was accepted for delivery. False when a send failed, and false
 *   when there was nobody to tell - an organisation whose members have all left cannot be
 *   notified, and reporting that as success would hide it (FR-037).
 * @example
 * ```ts
 * const notified = await notifyPairing(context, updated, "fulfilled", transition.notifies);
 * return c.json({ pairing, notified });
 * ```
 */
export async function notifyPairing(
  context: ServerContext,
  row: PairingWithSides,
  kind: PairingNoticeKind,
  sides: readonly PairingSideName[],
): Promise<boolean> {
  const recipients = await Promise.all(
    sides.map(
      async (side) =>
        await listOrganisationMembers(context.db, organisationFor(row, side)),
    ),
  );
  const addresses = recipients.flat().map((member) => member.email);
  if (addresses.length === 0) {
    return false;
  }

  const sent = await Promise.all(
    addresses.map(async (to) => {
      try {
        await context.mail.send(
          pairingMessage({
            to,
            kind,
            clientName: row.client.system.name,
            serverName: row.server.system.name,
            eventName: row.event.name,
            pairingId: row.pairing.id,
            publicUrl: context.config.publicUrl,
            clientId: row.pairing.clientId,
            reason: row.pairing.declineReason,
          }),
        );
        return true;
      } catch (error) {
        // Logged rather than raised: the transition stands, and the actor is told it did not
        // go. No credential appears in a pairing notice, so the address is safe to name.
        console.error(
          JSON.stringify({
            message: "muster.mail.failed",
            purpose: `pairing_${kind}`,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
        return false;
      }
    }),
  );
  return sent.every(Boolean);
}
