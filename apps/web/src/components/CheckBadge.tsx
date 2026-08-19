import { AlertIcon, KeyIcon, ShieldLockIcon } from "@primer/octicons-react";

import {
  checkVerdict,
  checkVerdictClass,
  checkVerdictWords,
  describeCheckedAt,
  driftSentence,
  ticketSupport,
  ticketSupportSentence,
} from "../lib/checks.ts";

import type { CheckVerdict } from "../lib/checks.ts";
import type { EnrolledSystem } from "@muster/contracts";
import type { JSX } from "react";

/**
 * An entry's verification, as the event view and the system detail show it.
 *
 * The badge is what makes staleness visible instead of silent, which is half of
 * what the participant table got wrong. It appears only on entries that have a
 * server side, because a client has no address of its own to verify - and an
 * entry nothing has checked says so rather than being left blank, since a blank
 * reads as a pass.
 *
 * @author John Grimes
 */

/**
 * Renders one verdict as a badge.
 *
 * @param props - the verdict to show
 * @returns the badge
 * @example
 * ```tsx
 * <CheckBadge verdict={checkVerdict(entry.check)} />
 * ```
 */
export function CheckBadge({
  verdict,
}: Readonly<{
  /** the verdict to show */
  verdict: CheckVerdict;
}>): JSX.Element {
  return (
    <span className={`badge badge-sm ${checkVerdictClass[verdict]}`}>
      {verdict === "guarded" ? <ShieldLockIcon size={12} /> : null}
      {verdict === "drifted" ? <AlertIcon size={12} /> : null}
      {checkVerdictWords[verdict]}
    </span>
  );
}

/**
 * Renders when an entry was checked, why it failed, and any drift.
 *
 * @param props - the enrolled system whose check to describe
 * @returns the note, or nothing for an entry with no server side
 * @example
 * ```tsx
 * <CheckNote entry={entry} />
 * ```
 */
export function CheckNote({
  entry,
}: Readonly<{
  /** the enrolled system whose check to describe */
  entry: EnrolledSystem;
}>): JSX.Element | null {
  if (entry.system.serverProfile === null) {
    return null;
  }
  const check = entry.check;
  return (
    <div className="flex flex-col gap-1">
      <p className="text-xs text-base-content/60">
        {describeCheckedAt(check, new Date())}
      </p>
      {check === null || check.latest.detail === null ? null : (
        <p className="text-xs text-warning">{check.latest.detail}</p>
      )}
      {check === null || check.latest.driftFlags.length === 0 ? null : (
        <ul className="flex flex-col gap-0.5">
          {check.latest.driftFlags.map((flag) => (
            <li key={flag.field} className="text-xs text-warning">
              {driftSentence(flag)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Renders an entry's verdict badge, if it has one to show.
 *
 * @param props - the enrolled system whose verdict to show
 * @returns the badge, or nothing for an entry with no server side
 * @example
 * ```tsx
 * <EntryCheckBadge entry={entry} />
 * ```
 */
export function EntryCheckBadge({
  entry,
}: Readonly<{
  /** the enrolled system whose verdict to show */
  entry: EnrolledSystem;
}>): JSX.Element | null {
  return entry.system.serverProfile === null ? null : (
    <CheckBadge verdict={checkVerdict(entry.check)} />
  );
}

/**
 * Renders an entry's permission ticket support, when a check observed any.
 *
 * Acceptance scenario 3: a server that advertises ticket types in its
 * smart-configuration says so on the event view, and it says so on the strength of
 * a check rather than of its owner's word. An entry that advertises nothing shows
 * nothing at all - a badge reading "no tickets" on every other entry in the
 * directory would be noise (FR-034).
 *
 * @param props - the enrolled system whose ticket support to show
 * @returns the badge, or nothing when no support was observed
 * @example
 * ```tsx
 * <EntryTicketBadge entry={entry} />
 * ```
 */
export function EntryTicketBadge({
  entry,
}: Readonly<{
  /** the enrolled system whose ticket support to show */
  entry: EnrolledSystem;
}>): JSX.Element | null {
  const types = ticketSupport(entry.check);
  return types.length === 0 ? null : (
    <span
      className="badge badge-sm badge-info gap-1"
      title={ticketSupportSentence(types)}
    >
      <KeyIcon size={12} />
      Permission tickets
    </span>
  );
}
