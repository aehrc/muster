/*
 * Copyright © 2026 Commonwealth Scientific and Industrial Research Organisation
 * (CSIRO) ABN 41 687 119 230. Licensed under the Apache License, Version 2.0.
 */

import { AlertIcon } from "@primer/octicons-react";

import type { JSX } from "react";

/**
 * The fields a form got wrong, named.
 *
 * Shown instead of sending a request the contract would refuse, so the person is
 * told which field while they are still looking at it.
 *
 * @author John Grimes
 */

/**
 * Renders form issues.
 *
 * @param props - the issues, one per offending field
 * @returns the list, or nothing when there are none
 * @example
 * ```tsx
 * <IssueList issues={issues} />
 * ```
 */
export function IssueList({
  issues,
}: Readonly<{
  /** the issues, one per offending field */
  issues: readonly string[];
}>): JSX.Element | null {
  if (issues.length === 0) {
    return null;
  }
  return (
    <div
      role="alert"
      aria-live="polite"
      className="alert alert-soft alert-error"
    >
      <AlertIcon size={16} />
      <ul className="list-inside list-disc text-sm">
        {issues.map((issue) => (
          <li key={issue}>{issue}</li>
        ))}
      </ul>
    </div>
  );
}
