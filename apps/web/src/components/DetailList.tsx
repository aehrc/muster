/*
 * Copyright © 2026 Commonwealth Scientific and Industrial Research Organisation
 * (CSIRO) ABN 41 687 119 230. Licensed under the Apache License, Version 2.0.
 */

import type { Detail } from "../lib/systemDetails.ts";
import type { JSX } from "react";

/**
 * The structured fields of a record, as a description list.
 *
 * Used wherever a system's profiles appear, so the event view and the system
 * detail cannot describe the same record differently. Which fields to show, and
 * what to call them, is decided in `lib/systemDetails.ts`; this renders whatever
 * it is handed.
 *
 * A value that is a list - redirect URIs, scopes - is rendered as separate items
 * rather than joined into a sentence, because a reader copying one of them needs
 * to see where it ends.
 *
 * @author John Grimes
 */

/**
 * Renders a record's fields.
 *
 * @param props - the fields to show
 * @returns the description list, or nothing when there are no fields
 * @example
 * ```tsx
 * <DetailList details={serverDetails(profile)} />
 * ```
 */
export function DetailList({
  details,
}: Readonly<{
  /** the fields to show */
  details: readonly Detail[];
}>): JSX.Element | null {
  if (details.length === 0) {
    return null;
  }
  return (
    <dl className="flex flex-col gap-2 text-sm sm:grid sm:grid-cols-[minmax(9rem,auto)_1fr] sm:gap-x-4">
      {details.map((detail) => (
        <div key={detail.label} className="contents">
          <dt className="text-base-content/60">{detail.label}</dt>
          <dd
            className={`mb-1 break-words sm:mb-0 ${detail.mono === true ? "font-mono text-xs" : ""}`}
          >
            {typeof detail.value === "string" ? (
              detail.value
            ) : (
              <ul className="flex flex-col gap-0.5">
                {detail.value.map((entry) => (
                  <li key={entry}>{entry}</li>
                ))}
              </ul>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}
