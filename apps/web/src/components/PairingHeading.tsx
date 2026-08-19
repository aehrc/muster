import { pairingStateClass, pairingStateWords } from "../lib/pairings.ts";

import type { PairingSummary } from "@muster/contracts";
import type { JSX, ReactNode } from "react";

/**
 * A pairing screen's heading: what it is, and what state it is in.
 *
 * Shared by the pairing detail and the registration run, because a pairing that
 * looked settled on one screen and open on the other would undo the point of
 * tracking it in one place (SC-002). The state badge is therefore rendered from
 * one component and coloured by one table.
 *
 * @author John Grimes
 */

/**
 * Renders a pairing screen's heading.
 *
 * @param props - the title, the pairing whose state to show, and any prose to put
 *   under it
 * @returns the heading
 * @example
 * ```tsx
 * <PairingHeading title="Register Smart Forms at Stub Auth" pairing={pairing}>
 *   <p>What the run will do.</p>
 * </PairingHeading>
 * ```
 */
export function PairingHeading({
  title,
  pairing,
  children,
}: Readonly<{
  /** the screen's title */
  title: string;
  /** the pairing whose state is shown beside it */
  pairing: PairingSummary;
  /** whatever the screen says under the title */
  children?: ReactNode;
}>): JSX.Element {
  return (
    <header className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold sm:text-3xl">{title}</h1>
        <span className={`badge badge-sm ${pairingStateClass[pairing.state]}`}>
          {pairingStateWords[pairing.state]}
        </span>
      </div>
      {children}
    </header>
  );
}
