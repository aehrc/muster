/**
 * What a conformance run says, in words.
 *
 * Plain functions rather than markup, for the reason the rest of this directory is arranged
 * that way: what the console claims about somebody else's server is worth a test, and a
 * sentence assembled inside a component cannot have one. The verdict banner, the check names
 * and the reason a run is unavailable are all here.
 *
 * The check labels are also the page's promise about what will be presented, so they are
 * listed in the order the harness runs them and each carries what the profile expects. A
 * reader who has never seen the profile should be able to tell from this table what their
 * server is about to be asked.
 *
 * Author: John Grimes
 */

import type {
  DcrVerified,
  HarnessCheckName,
  HarnessCheckView,
  HarnessRunRefusalCode,
  HarnessRunView,
} from "@muster/contracts";

/** One check, as the results table names it. */
export interface HarnessCheckLabel {
  readonly name: HarnessCheckName;
  readonly label: string;
  /** What the profile requires of a server in this case. */
  readonly expectation: string;
}

/** How a verdict reads at the top of the page. */
export interface VerdictDescription {
  readonly tone: "pass" | "fail" | "none";
  readonly text: string;
}

/** Every check, in the order the harness runs them (FR-029). */
export const HARNESS_CHECK_LABELS: readonly HarnessCheckLabel[] = [
  {
    name: "valid-statement",
    label: "Valid statement accepted",
    expectation: "201 with a client_id",
  },
  {
    name: "tampered-signature",
    label: "Tampered signature rejected",
    expectation: "refused, invalid_software_statement",
  },
  {
    name: "expired-statement",
    label: "Expired statement rejected",
    expectation: "refused, invalid_software_statement",
  },
  {
    name: "replayed-statement",
    label: "Replayed statement rejected",
    expectation: "refused on the second use of one identifier",
  },
  {
    name: "metadata-fidelity",
    label: "Metadata fidelity",
    expectation: "the registered client equals the vetted metadata",
  },
  {
    name: "statement-only",
    label: "Statement-only registration",
    expectation: "metadata outside the statement refused or ignored",
  },
];

/** What one check is called, falling back to its own name. */
export function describeCheckName(name: string): string {
  return (
    HARNESS_CHECK_LABELS.find((check) => check.name === name)?.label ?? name
  );
}

/**
 * The banner at the top of a finished run (FR-030).
 *
 * A passing run says the badge has been applied and when, because that is the thing the
 * reader came for; a failing one says the badge is absent and how many checks failed, because
 * "failed" without a count reads as though everything did.
 *
 * @param run - The run to describe, or `undefined` before any has been made.
 * @returns The tone to render and the sentence to show.
 * @example
 * ```ts
 * describeVerdict(run).text; // "All checks passed - ..."
 * ```
 */
export function describeVerdict(
  run: HarnessRunView | undefined,
): VerdictDescription {
  if (run === undefined) {
    return {
      tone: "none",
      text: "No run yet. Nothing is presented to your server until you ask for it.",
    };
  }
  const when = run.ranAt.replace("T", " ").slice(0, 16);
  if (run.verdict === "passed") {
    return {
      tone: "pass",
      text: `All checks passed - DCR verified badge applied to this system's event entries, run ${when}`,
    };
  }
  const failed = run.checks.filter((check) => check.outcome === "failed");
  return {
    tone: "fail",
    text: `${String(failed.length)} of ${String(run.checks.length)} checks failed - no badge is shown, run ${when}`,
  };
}

/**
 * One check's evidence, in a line.
 *
 * @param check - The check.
 * @returns The status and what the check concluded, or why nothing answered.
 */
export function summariseEvidence(check: HarnessCheckView): string {
  return check.response === null
    ? (check.failure ?? "no response")
    : check.detail;
}

/**
 * A body as a reader should see it.
 *
 * Indented when it is JSON, which is what RFC 7591 requires a registration endpoint to answer
 * with: the stored evidence is one long line, and one long line in a table cell is a page that
 * scrolls sideways rather than a body somebody can read. Anything that is not JSON is shown
 * exactly as it arrived, because that is the evidence.
 *
 * @param body - The recorded body.
 * @returns The body, indented when it parses as JSON.
 * @example
 * ```ts
 * formatEvidenceBody('{"error":"invalid_request"}'); // '{\n  "error": "invalid_request"\n}'
 * ```
 */
export function formatEvidenceBody(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body) as unknown, null, 2);
  } catch {
    return body;
  }
}

/**
 * Why the run is not on offer, said rather than left as a missing button (FR-037).
 *
 * @param refusal - The refusal the server computed, or null when there is none.
 * @returns The sentence to show, or null when the run is available.
 */
export function describeHarnessRefusal(
  refusal: HarnessRunRefusalCode | null,
): string | null {
  switch (refusal) {
    case null: {
      return null;
    }
    case "not_signed_in": {
      return "Sign in as a member of the organisation that owns this entry to run the harness. The report itself is public.";
    }
    case "not_the_server_owner": {
      return "The run is the entry owner's to start: it registers throwaway clients on this server.";
    }
    case "email_unverified": {
      return "Follow the verification link in your email first.";
    }
    case "awaiting_approval": {
      return "A track admin has yet to approve this account.";
    }
    case "revoked_member": {
      return "This account's membership has been revoked.";
    }
    case "event_not_open": {
      return "This event is not open, so nothing is presented to your server. Its recorded runs stay readable.";
    }
    case "not_trusted_dcr": {
      return "This entry's registration mode is not trusted DCR, so there is no registration profile for it to conform to.";
    }
    case "no_registration_endpoint": {
      return "This entry declares no registration endpoint for statements to be presented to.";
    }
    default: {
      return "This event's grace period has passed, so the valid statement the harness presents would already have expired.";
    }
  }
}

/**
 * The DCR-verified badge, as a label with its date (FR-030, scenario 2).
 *
 * @param verified - The badge, or null when no passing run stands.
 * @returns The label, or null when there is no badge to show.
 * @example
 * ```ts
 * describeBadge(system.dcrVerified); // "DCR verified 2026-09-02"
 * ```
 */
export function describeBadge(verified: DcrVerified | null): string | null {
  return verified === null
    ? null
    : `DCR verified ${verified.verifiedAt.slice(0, 10)}`;
}
