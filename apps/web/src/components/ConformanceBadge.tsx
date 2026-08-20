/*
 * Copyright © 2026 Commonwealth Scientific and Industrial Research Organisation
 * (CSIRO) ABN 41 687 119 230. Licensed under the Apache License, Version 2.0.
 */

import { VerifiedIcon } from "@primer/octicons-react";
import { Link } from "react-router";

import {
  harnessPath,
  showsVerifiedBadge,
  verifiedBadgeWords,
} from "../lib/harness.ts";

import type { EnrolledSystem } from "@muster/contracts";
import type { JSX } from "react";

/**
 * An entry's "DCR verified" badge.
 *
 * It appears only on an entry whose latest conformance run passed every check
 * (FR-030), and it carries the date it was earned, because a claim about somebody
 * else's server that nobody can date is the participant table's problem all over
 * again. A failing run shows no badge at all rather than a red one: the absence is
 * the statement.
 *
 * The badge links to the report it came from, so a reader who does not take it on
 * trust can go and read the evidence - which is the whole point of the run being
 * public (SC-005).
 *
 * @author John Grimes
 */

/**
 * Renders an entry's verified badge, if it has earned one.
 *
 * @param props - the enrolled system whose standing to show
 * @returns the badge, or nothing when there is none to show
 * @example
 * ```tsx
 * <ConformanceBadge entry={entry} />
 * ```
 */
export function ConformanceBadge({
  entry,
}: Readonly<{
  /** the enrolled system whose standing to show */
  entry: EnrolledSystem;
}>): JSX.Element | null {
  const conformance = entry.conformance;
  if (conformance === null || !showsVerifiedBadge(conformance)) {
    return null;
  }
  return (
    <Link
      to={harnessPath(entry.enrolmentId)}
      className="badge badge-success badge-sm gap-1"
      title="Every check of the trusted registration profile passed. Open the report."
    >
      <VerifiedIcon size={12} />
      {verifiedBadgeWords(conformance)}
    </Link>
  );
}
