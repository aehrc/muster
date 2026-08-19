import { dcrRunResponseSchema, pairingResponseSchema } from "@muster/contracts";
import {
  ArrowLeftIcon,
  BookIcon,
  CheckCircleIcon,
  DownloadIcon,
  KeyIcon,
  ShieldLockIcon,
  UnverifiedIcon,
  XCircleIcon,
} from "@primer/octicons-react";
import { useState } from "react";
import { Link, useParams } from "react-router";

import { muster } from "../api/muster.ts";
import { useResource } from "../api/useResource.ts";
import { DetailList } from "../components/DetailList.tsx";
import { OperationAlert } from "../components/OperationAlert.tsx";
import { PairingHeading } from "../components/PairingHeading.tsx";
import { Panel } from "../components/Panel.tsx";
import {
  acceptsVouching,
  claimDetails,
  mayRegister,
  runOperation,
  stepClass,
  whyNoRun,
} from "../lib/dcr.ts";
import { busy, failed, idle, pending } from "../lib/operation.ts";
import { clientDetails } from "../lib/systemDetails.ts";

import type { Operation } from "../lib/operation.ts";
import type { DcrRunResponse, PairingDetail } from "@muster/contracts";
import type { JSX } from "react";

/**
 * Registering a client at a server that accepts Muster's vouching (US5).
 *
 * The screen is deliberately in three parts, in the order the member needs them.
 * Before the run: what Muster will vouch for, taken from the pairing's own
 * snapshot, so nobody is asked to authorise something they cannot see. During the
 * run: the steps, because minting, presenting and recording are three things and a
 * member watching a spinner deserves to know which one they are waiting for
 * (FR-037). After it: the decoded statement, the identifier the server issued,
 * and - once, and only here - the client secret.
 *
 * The screen exists only for a server that accepts what Muster vouches for. Reached
 * by its address for any other, it says so and sends the reader back to the pairing,
 * rather than describing a run that the route would refuse.
 *
 * The secret panel is the one place in Muster where a credential is on screen. It
 * says so plainly, because it will not be shown again: it is never stored, never
 * logged and never retrievable (the constitution).
 *
 * @author John Grimes
 */

/**
 * Renders the steps a run took, or is taking.
 *
 * @param props - the run's steps, and whether it is still going
 * @returns the list of steps
 */
function RunSteps({
  run,
  running,
}: Readonly<{
  /** the finished run, or null while it is still going */
  run: DcrRunResponse | null;
  /** whether a run is in flight */
  running: boolean;
}>): JSX.Element {
  const names = [
    "Mint the software statement",
    "Present it to the server",
    "Record the outcome",
  ];
  return (
    <ol className="flex flex-col gap-3">
      {(
        run?.steps ??
        names.map((name) => ({ name, outcome: "skipped" as const, detail: "" }))
      ).map((step) => (
        <li key={step.name} className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            {running ? (
              <span className="loading loading-spinner loading-xs" />
            ) : step.outcome === "failed" ? (
              <XCircleIcon size={16} className="text-error" />
            ) : step.outcome === "succeeded" ? (
              <CheckCircleIcon size={16} className="text-success" />
            ) : (
              <UnverifiedIcon size={16} className="text-base-content/40" />
            )}
            <span className={`text-sm ${stepClass(step.outcome)}`}>
              {step.name}
            </span>
          </div>
          {step.detail === "" ? null : (
            <p className="pl-6 text-xs text-base-content/70">{step.detail}</p>
          )}
        </li>
      ))}
    </ol>
  );
}

/**
 * Renders the one-time client secret.
 *
 * @param props - the secret the server returned
 * @returns the panel
 */
function SecretPanel({
  secret,
}: Readonly<{
  /** the secret, shown this once */
  secret: string;
}>): JSX.Element {
  const [copied, setCopied] = useState(false);
  return (
    <Panel
      title="The client secret, this once"
      icon={<ShieldLockIcon size={18} />}
      description="Muster does not store this and cannot show it again. Copy it into your app's configuration now; if you lose it, ask the server's organisation to issue a new one."
    >
      <div className="flex flex-col gap-3">
        <code className="block overflow-x-auto rounded border border-warning bg-base-100 p-3 font-mono text-sm">
          {secret}
        </code>
        <button
          type="button"
          className="btn btn-sm self-start"
          onClick={() => {
            void navigator.clipboard.writeText(secret).then(() => {
              setCopied(true);
            });
          }}
        >
          <KeyIcon size={16} />
          {copied ? "Copied" : "Copy the secret"}
        </button>
      </div>
    </Panel>
  );
}

/**
 * The registration run screen.
 *
 * @returns the screen
 * @author John Grimes
 */
export function DcrRun(): JSX.Element {
  const { pairingId } = useParams();
  const { data, operation: read } = useResource(
    pairingId === undefined ? null : `/api/pairings/${pairingId}`,
    pairingResponseSchema,
    "Loading the pairing",
  );
  const [run, setRun] = useState<DcrRunResponse | null>(null);
  const [operation, setOperation] = useState<Operation>(idle);

  const pairing: PairingDetail | null = run?.pairing ?? data?.pairing ?? null;

  const handleRun = async (): Promise<void> => {
    setRun(null);
    setOperation(pending("Registering the client"));
    const result = await muster.post(
      `/api/pairings/${String(pairingId)}/register`,
      {},
      dcrRunResponseSchema,
    );
    if (!result.ok) {
      setOperation(failed("Registering the client", result.failure));
      return;
    }
    setRun(result.data);
    setOperation(runOperation(result.data));
  };

  if (pairing === null) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-2xl font-bold sm:text-3xl">Register at a server</h1>
        <OperationAlert operation={read} />
        <Link to="/pairings" className="btn btn-sm self-start">
          <ArrowLeftIcon size={16} />
          Back to the pairings
        </Link>
      </div>
    );
  }

  // Reached by its address rather than by the link, for a server that never
  // accepts a registration Muster vouches for: nothing else on this screen would
  // be true of it, so it says what is true and sends the reader back. The route
  // refuses such a run as well; this is so nobody has to be refused to find out.
  if (!acceptsVouching(pairing)) {
    return (
      <div className="flex flex-col gap-6">
        <PairingHeading
          title={`Register ${pairing.client.systemName} at ${pairing.server.systemName}`}
          pairing={pairing}
        >
          <p className="text-sm text-base-content/70">{whyNoRun(pairing)}</p>
        </PairingHeading>
        <div role="status" className="alert alert-soft alert-warning">
          <UnverifiedIcon size={16} />
          <span>
            Muster has no registration to run here. Follow the pairing itself:
            the server&apos;s organisation records the identifier it issues.
          </span>
        </div>
        <Link to={`/pairings/${pairing.id}`} className="btn btn-sm self-start">
          <ArrowLeftIcon size={16} />
          The pairing
        </Link>
      </div>
    );
  }

  const statement = run?.statement ?? pairing.statement;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link to={`/pairings/${pairing.id}`} className="btn btn-ghost btn-sm">
          <ArrowLeftIcon size={16} />
          The pairing
        </Link>
      </div>

      <PairingHeading
        title={`Register ${pairing.client.systemName} at ${pairing.server.systemName}`}
        pairing={pairing}
      >
        <p className="text-sm text-base-content/70">
          {pairing.server.systemName} accepts registrations that Muster vouches
          for, so nobody in {pairing.server.organisation.name} has to do
          anything. Muster signs a software statement carrying the details below
          and presents it to the server&apos;s registration endpoint.
        </p>
        <p className="text-sm text-base-content/70">
          <Link to="/docs/registration-profile" className="link">
            <BookIcon size={14} /> What the server checks
          </Link>
        </p>
      </PairingHeading>

      <OperationAlert operation={operation} />

      <Panel
        title="What Muster will vouch for"
        icon={<CheckCircleIcon size={18} />}
        description="The field set snapshot when the pairing was requested. To change it, decline and request again with the details you want."
      >
        <DetailList
          details={[
            {
              label: "Client name",
              value: pairing.registrationFields.clientName,
            },
            ...clientDetails(pairing.registrationFields),
          ]}
        />
      </Panel>

      {mayRegister(pairing) ? (
        <Panel
          title="Run the registration"
          icon={<KeyIcon size={18} />}
          description="Muster mints the statement, presents it, and records what the server answered - success or refusal - against the pairing."
        >
          <div className="flex flex-col gap-4">
            <button
              type="button"
              className="btn btn-primary btn-sm self-start"
              disabled={busy(operation)}
              onClick={() => {
                void handleRun();
              }}
            >
              <KeyIcon size={16} />
              {pairing.state === "failed"
                ? "Try registering again"
                : "Register at the server"}
            </button>
            <RunSteps run={run} running={busy(operation)} />
          </div>
        </Panel>
      ) : (
        <Panel
          title={run === null ? "The run" : "What the run did"}
          icon={<KeyIcon size={18} />}
        >
          <div className="flex flex-col gap-4">
            {run === null ? (
              <p className="text-sm text-base-content/70">
                {whyNoRun(pairing)}
              </p>
            ) : null}
            <RunSteps run={run} running={false} />
          </div>
        </Panel>
      )}

      {run?.clientSecret === undefined ? null : (
        <SecretPanel secret={run.clientSecret} />
      )}

      {pairing.clientId === null ? null : (
        <div role="status" className="alert alert-soft alert-success">
          <CheckCircleIcon size={16} />
          <span>
            {pairing.server.systemName} issued the client identifier{" "}
            <code className="font-mono">{pairing.clientId}</code>
          </span>
        </div>
      )}

      {statement === null || statement === undefined ? null : (
        <Panel
          title="The software statement"
          icon={<ShieldLockIcon size={18} />}
          description="The signed artefact Muster presented. Download it to register the same client at another server by hand: it is the identical artefact, byte for byte."
        >
          <div className="flex flex-col gap-4">
            <DetailList details={claimDetails(statement.claims)} />
            <a
              className="btn btn-sm self-start"
              href={statement.downloadPath}
              download={`${statement.jti}.jws`}
            >
              <DownloadIcon size={16} />
              Download the statement
            </a>
            <p className="text-xs text-base-content/60">
              Signed with key{" "}
              <code className="font-mono">{statement.keyId}</code>, vouching
              until {statement.expiresAt}. The key is published at{" "}
              <a className="link" href="/.well-known/jwks.json">
                /.well-known/jwks.json
              </a>
              .
            </p>
          </div>
        </Panel>
      )}

      {run?.registeredMetadata === null ||
      run?.registeredMetadata === undefined ? null : (
        <Panel
          title="What the server says it registered"
          icon={<CheckCircleIcon size={18} />}
          description="The server's own account of the client it created. Compare it with the statement above: a difference is worth raising with its owner."
        >
          <pre className="overflow-x-auto rounded bg-base-100 p-3 text-xs">
            <code>{JSON.stringify(run.registeredMetadata, undefined, 2)}</code>
          </pre>
        </Panel>
      )}
    </div>
  );
}
