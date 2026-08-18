import { PlugIcon, ServerIcon } from "@primer/octicons-react";

import { DetailList } from "./DetailList.tsx";
import {
  clientDetails,
  registrationGuidance,
  serverDetails,
} from "../lib/systemDetails.ts";

import type { SystemRecord } from "@muster/contracts";
import type { JSX } from "react";

/**
 * A system's server and client profiles, in full.
 *
 * The same component on the event view and on the system detail, so a reader
 * comparing two entries is comparing the same fields in the same order.
 *
 * @author John Grimes
 */

/**
 * Renders whichever profiles a system carries.
 *
 * @param props - the system to describe
 * @returns the profiles
 * @example
 * ```tsx
 * <SystemProfiles system={entry.system} />
 * ```
 */
export function SystemProfiles({
  system,
}: Readonly<{
  /** the system to describe */
  system: SystemRecord;
}>): JSX.Element {
  return (
    <div className="flex flex-col gap-4">
      {system.serverProfile === null ? null : (
        <div className="flex flex-col gap-2">
          <h4 className="flex items-center gap-2 text-sm font-semibold">
            <ServerIcon size={16} />
            As a server
          </h4>
          <DetailList details={serverDetails(system.serverProfile)} />
          <p className="text-xs text-base-content/70">
            {registrationGuidance(system.serverProfile)}
          </p>
        </div>
      )}
      {system.clientProfile === null ? null : (
        <div className="flex flex-col gap-2">
          <h4 className="flex items-center gap-2 text-sm font-semibold">
            <PlugIcon size={16} />
            As a client
          </h4>
          <DetailList details={clientDetails(system.clientProfile)} />
        </div>
      )}
    </div>
  );
}
