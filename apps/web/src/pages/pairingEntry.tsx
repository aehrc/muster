/**
 * Reading one pairing, and what to show while that is not yet an answer.
 *
 * Two pages read the same pairing - its detail and its trusted-DCR run - and both have to
 * report the same three states: waiting, refused in the server's own words, and answered
 * (FR-037). Written once, so neither can forget one of them and neither can describe the wait
 * differently from the other.
 *
 * A hook that returns an element is unusual, and it is the right shape here: what the caller
 * needs is either the pairing or something to render instead, and returning both as a
 * discriminated pair keeps the branch at the top of the page where a reader looks for it.
 *
 * Author: John Grimes
 */

import { describeError } from "../api/errors.js";
import { usePairing } from "../api/queries.js";
import { ErrorAlert, Loading } from "../components/layout.js";

import type { PairingDetail } from "@muster/contracts";
import type { ReactElement } from "react";

/** Either the pairing, or what to render instead of a page. */
export type PairingEntry =
  | { readonly fallback: ReactElement; readonly pairing?: undefined }
  | { readonly fallback?: undefined; readonly pairing: PairingDetail };

/**
 * The pairing, or the state to render while it is not available.
 *
 * @param id - The pairing's identifier, from the URL.
 * @returns The pairing, or the element to return from the page.
 * @example
 * ```tsx
 * const entry = usePairingEntry(id);
 * if (entry.pairing === undefined) {
 *   return entry.fallback;
 * }
 * ```
 */
export function usePairingEntry(id: string): PairingEntry {
  const entry = usePairing(id);

  if (entry.isPending) {
    return { fallback: <Loading label="Loading the pairing" /> };
  }
  if (entry.error !== null) {
    return { fallback: <ErrorAlert message={describeError(entry.error)} /> };
  }
  return { pairing: entry.data.pairing };
}
