/**
 * The conformance harness screen: what will be presented, what happened, and what it proves.
 *
 * The wireframe's four regions, and each is a requirement rather than a layout choice.
 *
 * **Nothing runs because the page was opened.** A run signs statements and registers throwaway
 * clients on somebody else's server, so it happens on a click. Before the first one the results
 * table still lists every check with what the profile expects, which is how the reader knows
 * what is about to be asked of their server.
 *
 * **The verdict says what it did to the badge.** FR-030 ties the badge to the run, so the
 * banner says the badge was applied and when, or that there is none and how many checks failed
 * (FR-037).
 *
 * **Every check shows its evidence.** Scenario 1 asks for the request and the response, so both
 * are here behind a disclosure rather than on a second page: the row says what happened and the
 * detail says what was sent and what came back. The request body shows the statement described
 * rather than reproduced, because the server that answers is the only party that needs the
 * artefact itself.
 *
 * **The page is public and says so.** A vendor produces evidence and shares it (SC-005), so the
 * report reads for anybody; only the button belongs to the entry's owner, and the reason it is
 * missing is stated rather than left as an absence.
 *
 * Author: John Grimes
 */

import { Link } from "react-router";

import {
  describeBadge,
  describeHarnessRefusal,
  describeVerdict,
  formatEvidenceBody,
  summariseEvidence,
  HARNESS_CHECK_LABELS,
} from "./harnessReport.js";
import { describeError } from "../api/errors.js";
import { useHarnessRun, useHarnessRuns } from "../api/queries.js";
import {
  DetailRow,
  EmptyState,
  ErrorAlert,
  Loading,
  PageHeader,
  Panel,
  Tag,
} from "../components/layout.js";
import { fullTime } from "../formatting/times.js";
import { eventPath } from "../routes.js";

import type { HarnessCheckView, HarnessRunView } from "@muster/contracts";
import type { ReactNode } from "react";

/**
 * What the button offers.
 *
 * A plain function rather than a nested ternary in the markup: "what will happen if I press
 * this" is the whole of Nielsen's first heuristic here, and it is worth reading in one place.
 */
function runButtonLabel(pending: boolean, hasRun: boolean): string {
  if (pending) {
    return "Running the checks…";
  }
  return hasRun ? "Run checks again" : "Run checks";
}

/** Runs the profile's checks against one enrolled server, and shows what it found. */
export function Harness({
  enrolmentId,
}: Readonly<{ readonly enrolmentId: string }>) {
  const listing = useHarnessRuns(enrolmentId);
  const started = useHarnessRun(enrolmentId);

  if (listing.isPending) {
    return <Loading label="Loading the conformance harness" />;
  }
  if (listing.error !== null) {
    return <ErrorAlert message={describeError(listing.error)} />;
  }

  const { target, runs } = listing.data;
  // The run just made, or the newest recorded one: reloading the page keeps the report.
  const latest = started.data?.run ?? runs[0];
  const verdict = describeVerdict(latest);
  const unavailable = describeHarnessRefusal(target.refusal);

  return (
    <article className="page-wide">
      <p className="back">
        <Link to={eventPath(target.eventSlug)}>
          &larr; Back to {target.eventName}
        </Link>
      </p>

      <PageHeader
        title={`Conformance harness: ${target.systemName}`}
        subtitle={`${target.organisationName} - Muster presents the registration profile's cases to this server and reports what it did with each of them.`}
        {...(latest === undefined
          ? {}
          : { status: latest.verdict === "passed" ? "passed" : "failed" })}
      />

      {started.error === null ? null : (
        <ErrorAlert message={describeError(started.error)} />
      )}

      <Panel
        title="Target"
        description="The endpoint the statements are presented to, as this entry declares it."
        {...(target.canRun
          ? {
              actions: (
                <button
                  type="button"
                  className="button button-primary"
                  disabled={started.isPending}
                  onClick={() => {
                    started.mutate();
                  }}
                >
                  {runButtonLabel(started.isPending, runs.length > 0)}
                </button>
              ),
            }
          : {})}
      >
        <DetailRow label="Registration endpoint">
          <span className="wrap">
            {target.registrationEndpoint ?? "None declared"}
          </span>
        </DetailRow>
        <DetailRow label="Event">{target.eventName}</DetailRow>
        {unavailable === null ? null : <p className="note">{unavailable}</p>}
      </Panel>

      <Panel title="Verdict">
        <p
          className={`state state-${verdict.tone === "fail" ? "error" : "pending"}`}
        >
          {verdict.text}
        </p>
        <p className="quiet">
          Any failing run removes the badge: it is driven by the latest run, not
          by the best one.
        </p>
      </Panel>

      <Panel
        title="Results"
        description="Each check reports its own outcome with the request that was sent and the answer that came back."
      >
        <ResultsTable checks={latest?.checks ?? []} />
        {latest === undefined ? null : (
          <p className="note">Cleanup: {latest.cleanup}</p>
        )}
      </Panel>

      <PreviousRuns runs={runs} />
    </article>
  );
}

/** The results table: one row per check, before a run and after it. */
function ResultsTable({
  checks,
}: Readonly<{ readonly checks: readonly HarnessCheckView[] }>) {
  return (
    <table className="table">
      <thead>
        <tr>
          <th>Check</th>
          <th>Result</th>
          <th>Evidence</th>
        </tr>
      </thead>
      <tbody>
        {HARNESS_CHECK_LABELS.map((label) => {
          const reported = checks.find((check) => check.name === label.name);
          return (
            <tr key={label.name}>
              <td>{label.label}</td>
              <td>
                {reported === undefined ? (
                  <span className="quiet">not run</span>
                ) : (
                  <span
                    className={`check check-${reported.outcome === "passed" ? "ok" : "bad"}`}
                    // What the check did, addressable without reading its styling (FR-008).
                    data-state={reported.outcome}
                    data-testid="check-result"
                  >
                    {reported.outcome === "passed" ? "PASS" : "FAIL"}
                  </span>
                )}
              </td>
              <td>
                {reported === undefined ? (
                  <span className="quiet">Expects {label.expectation}</span>
                ) : (
                  <CheckEvidence check={reported} />
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** One check's conclusion, its advisories, and the exchange behind it. */
function CheckEvidence({
  check,
}: Readonly<{ readonly check: HarnessCheckView }>): ReactNode {
  return (
    <>
      <span className="wrap">{summariseEvidence(check)}</span>
      {check.advisories.map((advisory) => (
        <p className="note" key={advisory}>
          Advisory: {advisory}
        </p>
      ))}
      <details>
        <summary>view request/response</summary>
        <pre className="code-block code-wrap">
          {check.request.method} {check.request.url}
          {"\n"}
          {formatEvidenceBody(check.request.body)}
        </pre>
        <pre className="code-block code-wrap">
          {check.response === null
            ? (check.failure ?? "No response.")
            : `HTTP ${String(check.response.status)}\n${formatEvidenceBody(check.response.body)}`}
        </pre>
      </details>
    </>
  );
}

/** Every recorded run, so a vendor can see their own progress. */
function PreviousRuns({
  runs,
}: Readonly<{ readonly runs: readonly HarnessRunView[] }>) {
  return (
    <Panel
      title="Recorded runs"
      description="Every run is kept. The newest one decides the badge."
    >
      {runs.length === 0 ? (
        <EmptyState>
          Nothing has run against this entry yet, so it carries no badge - which
          is an absence rather than a failure.
        </EmptyState>
      ) : (
        <ul className="plain-list">
          {runs.map((recorded) => (
            <li key={recorded.id}>
              <span className="wrap">{fullTime(recorded.ranAt)}</span>{" "}
              <Tag>{recorded.verdict}</Tag>{" "}
              {describeBadge(
                recorded.verdict === "passed"
                  ? { verifiedAt: recorded.ranAt, runId: recorded.id }
                  : null,
              ) ?? "no badge"}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
