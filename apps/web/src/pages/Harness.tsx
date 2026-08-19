import {
  harnessRunResponseSchema,
  harnessRunsResponseSchema,
} from "@muster/contracts";
import {
  ArrowLeftIcon,
  BeakerIcon,
  BookIcon,
  ChecklistIcon,
  OrganizationIcon,
  PlayIcon,
  TrashIcon,
} from "@primer/octicons-react";
import { useState } from "react";
import { Link, useParams } from "react-router";

import { muster } from "../api/muster.ts";
import { useResource } from "../api/useResource.ts";
import { OperationAlert } from "../components/OperationAlert.tsx";
import { Panel } from "../components/Panel.tsx";
import { describeAge } from "../lib/format.ts";
import {
  conformanceSentence,
  evidenceJson,
  outcomeClass,
  outcomeWords,
  runningHarness,
  runOperationOf,
  runTally,
} from "../lib/harness.ts";
import { busy, failed, idle, pending } from "../lib/operation.ts";

import type { Operation } from "../lib/operation.ts";
import type { HarnessCheck, HarnessRun } from "@muster/contracts";
import type { JSX } from "react";

/**
 * Proving a server implements the registration profile (US6).
 *
 * The screen is the report. A vendor comes here to find out what their server does
 * wrong, so every check shows its own verdict, the sentence explaining it, and the
 * request and response it was decided from - the evidence is what makes the report
 * arguable rather than an opinion, and it is public for the same reason (SC-005).
 *
 * Three things are deliberate. The run is offered only to the people it would work
 * for, and the page says why it is not offered rather than hiding the button. The
 * cleanup note is shown as prominently as the verdict, because a client left behind
 * on somebody's server is something they have to go and delete. And an advisory is
 * visibly not a failure: the profile's SHOULDs are reported without costing the
 * badge.
 *
 * @author John Grimes
 */

/**
 * Renders one check, with the evidence behind it.
 *
 * @param props - the check to show
 * @returns the check
 */
function CheckReport({
  check,
}: Readonly<{
  /** the check to show */
  check: HarnessCheck;
}>): JSX.Element {
  const responseBody = check.response.text ?? evidenceJson(check.response.body);
  return (
    <li className="flex flex-col gap-2 border-t border-base-300 pt-3 first:border-0 first:pt-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`badge badge-sm ${outcomeClass[check.outcome]}`}>
          {outcomeWords[check.outcome]}
        </span>
        <h3 className="text-sm font-semibold">{check.title}</h3>
        <code className="font-mono text-xs text-base-content/50">
          {check.name}
        </code>
      </div>
      <p className="text-sm">{check.detail}</p>
      <details className="text-xs">
        <summary className="cursor-pointer text-base-content/70">
          The request and the response
        </summary>
        <div className="mt-2 flex flex-col gap-2">
          <p className="font-mono text-xs break-all">
            {check.request.method} {check.request.url}
          </p>
          <pre className="overflow-x-auto rounded bg-base-100 p-2">
            <code>{evidenceJson(check.request.body)}</code>
          </pre>
          <p className="font-mono text-xs">
            HTTP {String(check.response.status)}
          </p>
          {responseBody === "" ? (
            <p className="text-base-content/60">
              The server answered with no body.
            </p>
          ) : (
            <pre className="overflow-x-auto rounded bg-base-100 p-2">
              <code>{responseBody}</code>
            </pre>
          )}
        </div>
      </details>
    </li>
  );
}

/**
 * Renders one run's report.
 *
 * @param props - the run to show
 * @returns the report
 */
function RunReport({
  run,
}: Readonly<{
  /** the run to show */
  run: HarnessRun;
}>): JSX.Element {
  return (
    <Panel
      title={`Run of ${new Date(run.ranAt).toISOString().slice(0, 10)}`}
      icon={<ChecklistIcon size={18} />}
      description={`${runTally(run)} - ${describeAge(run.ranAt, new Date())}.`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`badge badge-sm ${run.verdict === "passed" ? "badge-success" : "badge-error"}`}
        >
          {run.verdict === "passed" ? "Passed" : "Failed"}
        </span>
        <span className="text-sm text-base-content/70">
          {run.verdict === "passed"
            ? "This entry carries the DCR verified badge."
            : "This entry carries no verified badge until a run passes every check."}
        </span>
      </div>

      <ul className="flex flex-col gap-3">
        {run.checks.map((check) => (
          <CheckReport key={check.name} check={check} />
        ))}
      </ul>

      <div className="flex items-start gap-2 rounded border border-base-300 bg-base-100 p-3 text-sm">
        <TrashIcon size={16} className="mt-0.5 shrink-0" />
        <span>{run.cleanup}</span>
      </div>

      <p className="text-xs text-base-content/60">
        Share this report:{" "}
        <Link className="link font-mono" to={`/api/harness-runs/${run.id}`}>
          /api/harness-runs/{run.id}
        </Link>{" "}
        needs no account.
      </p>
    </Panel>
  );
}

/**
 * The conformance harness screen.
 *
 * @returns the screen
 * @author John Grimes
 */
export function Harness(): JSX.Element {
  const { enrolmentId } = useParams();
  const {
    data,
    operation: read,
    reload,
  } = useResource(
    enrolmentId === undefined
      ? null
      : `/api/enrolments/${enrolmentId}/harness-runs`,
    harnessRunsResponseSchema,
    "Loading the conformance runs",
  );
  const [operation, setOperation] = useState<Operation>(idle);

  const handleRun = async (): Promise<void> => {
    setOperation(pending(runningHarness));
    const result = await muster.post(
      `/api/enrolments/${String(enrolmentId)}/harness-runs`,
      {},
      harnessRunResponseSchema,
    );
    if (!result.ok) {
      setOperation(failed(runningHarness, result.failure));
      return;
    }
    setOperation(runOperationOf(result.data.run));
    reload();
  };

  if (data === null) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-2xl font-bold sm:text-3xl">Conformance</h1>
        <OperationAlert operation={read} />
      </div>
    );
  }

  const { event, system } = data;
  const registration = system.system.serverProfile?.registrationEndpoint;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link
          to={`/events/${event.slug}/systems/${system.system.id}`}
          className="btn btn-ghost btn-sm"
        >
          <ArrowLeftIcon size={16} />
          {system.system.name}
        </Link>
      </div>

      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-bold sm:text-3xl">
          Conformance of {system.system.name}
        </h1>
        <p className="flex flex-wrap items-center gap-2 text-sm text-base-content/70">
          <OrganizationIcon size={14} />
          {system.organisation.name}
          <span aria-hidden="true">-</span>
          {event.name}
        </p>
        <p className="max-w-2xl text-sm">
          {conformanceSentence(system.conformance, new Date())}
        </p>
        <p className="text-sm text-base-content/70">
          <Link to="/docs/registration-profile" className="link">
            <BookIcon size={14} /> What each check requires
          </Link>
        </p>
      </header>

      <OperationAlert operation={operation} />
      <OperationAlert operation={read} />

      <Panel
        title="Run the profile against this server"
        icon={<BeakerIcon size={18} />}
        description="Muster mints four software statements and presents five registration requests: a valid statement, a tampered signature, an expired statement, a replay of the valid one, and one asserting metadata outside the signature. It deletes the throwaway clients it registers where the server allows it."
      >
        <div className="flex flex-col gap-3">
          {registration === undefined ? null : (
            <p className="text-sm">
              The requests go to{" "}
              <code className="font-mono text-xs break-all">
                {registration}
              </code>
              .
            </p>
          )}
          {data.mayRun ? (
            <button
              type="button"
              className="btn btn-primary btn-sm self-start"
              disabled={busy(operation)}
              onClick={() => {
                void handleRun();
              }}
            >
              <PlayIcon size={16} />
              {data.runs.length === 0 ? "Run the checks" : "Run them again"}
            </button>
          ) : (
            <p className="text-sm text-base-content/70">
              Only an approved member of {system.organisation.name} can run the
              harness against this entry, while {event.name} is open and the
              entry accepts registrations Muster vouches for. Anyone can read
              the reports below.
            </p>
          )}
        </div>
      </Panel>

      {data.runs.length === 0 ? (
        <p className="flex items-center gap-2 text-base-content/70">
          <ChecklistIcon size={16} />
          Nothing has been run against this entry yet.
        </p>
      ) : null}

      {data.runs.map((run) => (
        <RunReport key={run.id} run={run} />
      ))}
    </div>
  );
}
