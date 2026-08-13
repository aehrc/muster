/**
 * The trusted-DCR run screen: what will be vouched for, what happened, and what to keep.
 *
 * The wireframe's three regions, and each is a requirement rather than a layout choice.
 *
 * **The steps are shown, not summarised.** Minting, presenting and recording fail
 * differently - a refused signature is the vendor's problem, an unreachable endpoint is
 * their network's, a state clash is somebody in the reader's own organisation - so the page
 * says which one it got to (FR-037). Before the run they read as pending, which is also how
 * the reader knows what is about to happen on their behalf.
 *
 * **Nothing runs because the page was opened.** A run mints a signed artefact and presents
 * it to somebody else's server, so it happens on a click and never on navigation or a stale
 * cache. The button says what it will do.
 *
 * **The claims are shown before and after.** The pairing carries the latest statement, so
 * reloading the page still shows what was vouched for and still offers the download - which
 * is the artefact itself, byte for byte (FR-027).
 *
 * **The secret is shown once, and the page says so.** It is held in this component's state
 * and nowhere else: Muster does not store it and cannot show it again (FR-026), so leaving
 * the page loses it. Masked by default with a reveal, because a screen being shared at a
 * connectathon is the normal case rather than the exception.
 *
 * Author: John Grimes
 */

import { useState } from "react";
import { Link } from "react-router";

import { usePairingEntry } from "./pairingEntry.js";
import { describeError } from "../api/errors.js";
import { statementDownloadPath, useDcrRun } from "../api/queries.js";
import {
  DetailRow,
  ErrorAlert,
  InfoAlert,
  PageHeader,
  Panel,
} from "../components/layout.js";
import { fullTime } from "../formatting/times.js";
import { pairingPath } from "../routes.js";

import type {
  DcrRun as Run,
  DcrRunStep,
  PairingDetail,
  SoftwareStatementView,
} from "@muster/contracts";

/** What each step is called, in the order the run does them. */
const STEP_LABELS: readonly {
  readonly name: DcrRunStep["name"];
  readonly label: string;
  readonly waiting: string;
}[] = [
  {
    name: "mint",
    label: "Mint software statement",
    waiting:
      "Muster will sign the vetted metadata and the event with its published key.",
  },
  {
    name: "present",
    label: "Present to the server's registration endpoint",
    waiting:
      "The statement is the whole request body: the server takes its metadata from inside it.",
  },
  {
    name: "record",
    label: "Record the result",
    waiting:
      "The pairing moves to fulfilled or failed, and the other organisation is emailed.",
  },
];

/** How a finished outcome reads at the top of the page. */
const OUTCOME_LABEL: Readonly<Record<Run["outcome"], string>> = {
  registered: "Registered",
  refused: "Refused by the server",
  unreachable: "The registration endpoint could not be reached",
};

/**
 * What the button offers.
 *
 * A plain function rather than a nested ternary in the markup, because "what will happen if I
 * press this" is the whole of Nielsen's first heuristic here and is worth reading in one place.
 */
function runButtonLabel(pending: boolean, hasRun: boolean): string {
  if (pending) {
    return "Registering…";
  }
  return hasRun ? "Run again" : "Mint and present the statement";
}

/**
 * Why the run is not on offer.
 *
 * Said rather than left as a missing button (FR-037). The server decides whether the action is
 * available; this only puts the likely reason into words, and the two cases differ in what the
 * reader should do about it.
 */
function unavailableReason(pairing: PairingDetail): string {
  if (pairing.sides.includes("server") && !pairing.sides.includes("client")) {
    return "The run is the app owner's to start: Muster vouches for the client on behalf of the organisation that owns it.";
  }
  if (pairing.state !== "requested" && pairing.state !== "failed") {
    return `This pairing is ${pairing.state}, so there is nothing to register. A fulfilled, declined or lapsed pairing keeps its record and takes no further action.`;
  }
  return "This pairing cannot be registered automatically now - the event may have closed, or the server's registration mode may not be trusted DCR.";
}

/** How one step reads: before the run, during it, and after it. */
function stepState(step: DcrRunStep | undefined, pending: boolean): string {
  if (step === undefined) {
    return pending ? "Working" : "Not started";
  }
  return step.outcome === "done" ? "Done" : "Failed";
}

/** Mints a statement, presents it and shows what came back. */
export function DcrRun({ id }: Readonly<{ readonly id: string }>) {
  const entry = usePairingEntry(id);
  const run = useDcrRun(id);
  // The secret lives here and nowhere else. Held separately from `run.data` so that a later
  // refetch of the pairing cannot displace it while the reader is still copying it.
  const [secret, setSecret] = useState<string | null>(null);

  if (entry.pairing === undefined) {
    return entry.fallback;
  }
  const { pairing } = entry;
  const canRun = pairing.actions.includes("register");

  function handleRun() {
    run.mutate(undefined, {
      onSuccess: (result) => {
        setSecret(result.run.clientSecret);
      },
    });
  }

  return (
    <article className="page-wide">
      <p className="back">
        <Link to={pairingPath(id)}>&larr; Back to pairing</Link>
      </p>

      <PageHeader
        title={`Trusted DCR run: ${pairing.client.name} → ${pairing.server.name}`}
        {...(run.data === undefined
          ? {}
          : { status: OUTCOME_LABEL[run.data.run.outcome] })}
        subtitle={`${pairing.event.name} - Muster vouches for the metadata and the server registers it with no human on the server side.`}
      />

      {run.error === null ? null : (
        <ErrorAlert message={describeError(run.error)} />
      )}
      {run.data?.run.outcome === "registered" ? (
        <InfoAlert>
          Registered. The issued client identifier is{" "}
          <strong>{run.data.run.clientId}</strong>.
        </InfoAlert>
      ) : null}

      <Panel
        title="Steps"
        description="Each step reports its own outcome, so a failure names the thing that failed."
        {...(canRun
          ? {
              actions: (
                <button
                  type="button"
                  className="button button-primary"
                  disabled={run.isPending}
                  onClick={handleRun}
                >
                  {runButtonLabel(run.isPending, run.data !== undefined)}
                </button>
              ),
            }
          : {})}
      >
        <StepList run={run.data?.run} pending={run.isPending} />
        {canRun || run.data !== undefined ? null : (
          // Only when there is nothing else to explain the absence of the button. After a run
          // the steps above say what happened, and repeating "this cannot be registered" beside
          // a successful one would read as a contradiction.
          <p className="note">{unavailableReason(pairing)}</p>
        )}
      </Panel>

      {run.data === undefined ? null : (
        <ResultPanel id={id} run={run.data.run} notified={run.data.notified} />
      )}

      {secret === null ? null : <SecretPanel secret={secret} />}

      <StatementPanel id={id} statement={pairing.statement} pairing={pairing} />
    </article>
  );
}

/** The three steps, as pending before the run and as reported after it. */
function StepList({
  run,
  pending,
}: Readonly<{ readonly run: Run | undefined; readonly pending: boolean }>) {
  return (
    <ol className="steps">
      {STEP_LABELS.map((step, index) => {
        const reported = run?.steps.find((entry) => entry.name === step.name);
        const state = stepState(reported, pending);
        return (
          <li
            className={
              reported?.outcome === "failed" ? "step step-failed" : "step"
            }
            key={step.name}
          >
            <div className="step-header">
              <span className="step-index">{index + 1}</span>
              <strong>{step.label}</strong>
              <span className="tag">{state}</span>
            </div>
            <p className="quiet">{reported?.detail ?? step.waiting}</p>
          </li>
        );
      })}
    </ol>
  );
}

/** What the server said, and what was recorded. */
function ResultPanel({
  id,
  run,
  notified,
}: Readonly<{
  readonly id: string;
  readonly run: Run;
  readonly notified: boolean;
}>) {
  return (
    <Panel
      title="Result"
      description="The server's own answer, kept as evidence against the pairing."
    >
      <DetailRow label="Presented to">
        <span className="wrap">{run.registrationEndpoint}</span>
      </DetailRow>
      <DetailRow label="Response">
        {run.answer === null
          ? "No response: the endpoint did not answer."
          : `HTTP ${String(run.answer.status)}${run.answer.error === null ? "" : ` - ${run.answer.error}`}`}
      </DetailRow>
      {run.answer?.errorDescription === null ||
      run.answer?.errorDescription === undefined ? null : (
        <DetailRow label="The server says">
          <span className="wrap">{run.answer.errorDescription}</span>
        </DetailRow>
      )}
      {run.clientId === null ? null : (
        <DetailRow label="client_id">
          <strong className="wrap">{run.clientId}</strong>
        </DetailRow>
      )}
      <DetailRow label="Counterparty notified">
        {notified ? "Yes, by email" : "No - tell them another way"}
      </DetailRow>
      <p className="quiet">
        The whole exchange is on the{" "}
        <Link to={pairingPath(id)}>pairing&apos;s timeline</Link>, which both
        organisations read.
      </p>
    </Panel>
  );
}

/** The one-time client secret (FR-026, principle IV). */
function SecretPanel({ secret }: Readonly<{ readonly secret: string }>) {
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    void navigator.clipboard.writeText(secret).then(() => {
      setCopied(true);
    });
  }

  return (
    <Panel
      title="One-time client secret"
      description="Shown once. Muster does not store it and cannot show it again - copy it before you leave this page."
    >
      <div className="secret-row">
        <label className="field-label" htmlFor="client-secret">
          client_secret
        </label>
        <input
          className="secret-value"
          id="client-secret"
          readOnly
          type={revealed ? "text" : "password"}
          value={secret}
        />
        <button
          type="button"
          className="button"
          onClick={() => {
            setRevealed(!revealed);
          }}
        >
          {revealed ? "Hide" : "Show"}
        </button>
        <button type="button" className="button" onClick={handleCopy}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <p className="note">
        Store it wherever your app keeps its credentials. It is not in
        Muster&apos;s database, not in the pairing, and not in any log.
      </p>
    </Panel>
  );
}

/** The statement's claims, and the artefact itself as a download. */
function StatementPanel({
  id,
  statement,
  pairing,
}: Readonly<{
  readonly id: string;
  readonly statement: SoftwareStatementView | null;
  readonly pairing: PairingDetail;
}>) {
  if (statement === null) {
    return (
      <Panel title="Software statement">
        <p className="note">
          Nothing has been minted for this pairing yet. The statement will carry{" "}
          {pairing.registrationFields.clientName}&apos;s vetted metadata, the
          event, and an expiry no later than the event&apos;s end plus its grace
          period.
        </p>
      </Panel>
    );
  }

  return (
    <Panel
      title="Software statement"
      description="The decoded claims, for review. The statement itself is a signed JWS."
    >
      <DetailRow label="Signed with">
        <span className="wrap">{statement.keyId}</span>
      </DetailRow>
      <DetailRow label="Statement id">
        <span className="wrap">{statement.jti}</span>
      </DetailRow>
      <DetailRow label="Minted">{fullTime(statement.mintedAt)}</DetailRow>
      <DetailRow label="Vouching expires">
        {fullTime(statement.expiresAt)}
      </DetailRow>
      <pre className="code-block">
        {JSON.stringify(statement.claims, null, 2)}
      </pre>
      <p>
        <a className="button" href={statementDownloadPath(id)} download>
          Download software statement
        </a>
      </p>
      <p className="quiet">
        The same artefact Muster presents itself, for registering out of band.
      </p>
    </Panel>
  );
}
