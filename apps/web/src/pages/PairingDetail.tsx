/*
 * Copyright © 2026 Commonwealth Scientific and Industrial Research Organisation
 * (CSIRO) ABN 41 687 119 230. Licensed under the Apache License, Version 2.0.
 */

import {
  pairingMutationResponseSchema,
  pairingResponseSchema,
} from "@muster/contracts";
import {
  AlertIcon,
  ArrowLeftIcon,
  CheckCircleIcon,
  DownloadIcon,
  HistoryIcon,
  KeyIcon,
  PlugIcon,
  ServerIcon,
  ShieldLockIcon,
  XCircleIcon,
} from "@primer/octicons-react";
import { useState } from "react";
import { Link, useParams } from "react-router";

import { muster } from "../api/muster.ts";
import { useResource } from "../api/useResource.ts";
import { DetailList } from "../components/DetailList.tsx";
import { TextAreaField, TextField } from "../components/Fields.tsx";
import { IssueList } from "../components/IssueList.tsx";
import { OperationAlert } from "../components/OperationAlert.tsx";
import { PairingHeading } from "../components/PairingHeading.tsx";
import { Panel } from "../components/Panel.tsx";
import { scopeWarningSentence } from "../lib/checks.ts";
import { mayRegister } from "../lib/dcr.ts";
import { describeAge } from "../lib/format.ts";
import { busy, failed, idle, pending, succeeded } from "../lib/operation.ts";
import {
  describeTimelineEntry,
  mayFulfilByHand,
  mayTake,
  pairingStateClass,
  pairingStateSentence,
  pairingStateWords,
  refusalNotice,
} from "../lib/pairings.ts";
import { clientDetails } from "../lib/systemDetails.ts";

import type { Operation } from "../lib/operation.ts";
import type { PairingDetail as Pairing } from "@muster/contracts";
import type { JSX } from "react";

/**
 * One pairing, in full: the field set, the timeline, and the two actions.
 *
 * Acceptance scenario 4 is the shape of this screen. Both organisations open the
 * same page and see the same state and the same history - who did what, when, and
 * for which organisation - so neither has to ask the other how the registration
 * went. The two actions appear only for the party entitled to take them, and only
 * while the pairing and its event can still take them, because that is what
 * `mayTake` asks the state machine - and the fulfilment appears only where the
 * identifier is the server organisation's to issue, which is the one thing the
 * state machine cannot see.
 *
 * @author John Grimes
 */

/**
 * Renders the timeline both parties read (FR-013).
 *
 * @param props - the pairing whose history to show
 * @returns the timeline
 */
function Timeline({
  pairing,
}: Readonly<{
  /** the pairing whose history to show */
  pairing: Pairing;
}>): JSX.Element {
  return (
    <ol className="flex flex-col gap-3">
      {pairing.timeline.map((entry) => (
        <li key={entry.id} className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`badge badge-sm ${pairingStateClass[entry.toState]}`}
            >
              {pairingStateWords[entry.toState]}
            </span>
            <span className="text-sm">{describeTimelineEntry(entry)}</span>
            <span className="text-xs text-base-content/60">
              {describeAge(entry.at, new Date())}
            </span>
          </div>
          {entry.detail.clientId === undefined ? null : (
            <p className="text-xs text-base-content/70">
              Client identifier{" "}
              <code className="font-mono">{entry.detail.clientId}</code>
            </p>
          )}
          {entry.detail.reason === undefined ? null : (
            <p className="text-xs text-base-content/70">
              {entry.detail.reason}
            </p>
          )}
        </li>
      ))}
    </ol>
  );
}

/** What one of the server organisation's two actions needs. */
type ActionProps = {
  /** what the action is called in its messages */
  readonly what: string;
  /** the label of the one field it carries */
  readonly label: string;
  /** how to fill that field in */
  readonly hint: string;
  /** whether the field is a paragraph rather than a line */
  readonly multiline: boolean;
  /** the wording on the button */
  readonly submit: string;
  /** the icon on the button */
  readonly icon: JSX.Element;
  /** builds the request body from what was typed */
  readonly body: (value: string) => unknown;
  /** where to send it */
  readonly path: string;
  /**
   * Called with what to report once the action has been taken. The panel holding
   * this form unmounts as soon as the pairing has moved, so the outcome is
   * reported by the screen rather than here or it would never be read.
   */
  readonly onDone: (outcome: Operation) => void;
};

/**
 * Renders one of the server organisation's actions: fulfil, or decline.
 *
 * One component for both, because they differ only in the field they carry and
 * what they are called - and because a refusal has to be reported the same way
 * whichever was attempted (FR-037).
 *
 * @param props - what the action is called, its one field, and where to send it
 * @returns the form
 */
function PairingActionForm(props: Readonly<ActionProps>): JSX.Element {
  const [value, setValue] = useState("");
  const [issues, setIssues] = useState<readonly string[]>([]);
  const [operation, setOperation] = useState<Operation>(idle);

  const handleSubmit = async (): Promise<void> => {
    if (value.trim() === "") {
      setIssues([`${props.label} is needed.`]);
      return;
    }
    setIssues([]);
    setOperation(pending(props.what));
    const result = await muster.post(
      props.path,
      props.body(value.trim()),
      pairingMutationResponseSchema,
    );
    if (!result.ok) {
      setOperation(failed(props.what, result.failure));
      return;
    }
    setValue("");
    const settled = `This pairing is now ${pairingStateWords[result.data.pairing.state].toLowerCase()}.`;
    // The action is recorded either way, so a message that could not be sent is
    // said as the caveat it is rather than as a failure of the action.
    const outcome = succeeded(
      props.what,
      result.data.notificationFailure === undefined
        ? `${settled} The app's owner has been told.`
        : `${settled} The app's owner could not be told: ${result.data.notificationFailure}`,
    );
    setOperation(outcome);
    props.onDone(outcome);
  };

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        void handleSubmit();
      }}
    >
      <IssueList issues={issues} />
      {props.multiline ? (
        <TextAreaField
          label={props.label}
          hint={props.hint}
          value={value}
          onChange={setValue}
        />
      ) : (
        <TextField
          label={props.label}
          hint={props.hint}
          value={value}
          onChange={setValue}
        />
      )}
      <button
        type="submit"
        className="btn btn-sm self-start"
        disabled={busy(operation)}
      >
        {props.icon}
        {props.submit}
      </button>
      <OperationAlert operation={operation} />
    </form>
  );
}

/**
 * The pairing detail screen.
 *
 * @returns the screen
 * @author John Grimes
 */
export function PairingDetail(): JSX.Element {
  const { pairingId } = useParams();
  const { data, operation, reload } = useResource(
    pairingId === undefined ? null : `/api/pairings/${pairingId}`,
    pairingResponseSchema,
    "Loading the pairing",
  );
  // Held here rather than in the form: the panel the form sits in unmounts as
  // soon as the pairing has moved, so an outcome reported inside it would flash
  // and vanish (the constitution: every action produces a perceptible response).
  const [taken, setTaken] = useState<Operation>(idle);
  const handleDone = (outcome: Operation): void => {
    setTaken(outcome);
    reload();
  };

  if (data === null) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-2xl font-bold sm:text-3xl">Pairing</h1>
        <OperationAlert operation={operation} />
        <Link to="/pairings" className="btn btn-sm self-start">
          <ArrowLeftIcon size={16} />
          Back to the pairings
        </Link>
      </div>
    );
  }

  const { pairing } = data;
  const fields = pairing.registrationFields;
  const refusal = refusalNotice(pairing);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link
          to={`/pairings?event=${pairing.eventSlug}`}
          className="btn btn-ghost btn-sm"
        >
          <ArrowLeftIcon size={16} />
          Pairings
        </Link>
      </div>

      <PairingHeading
        title={`${pairing.client.systemName} at ${pairing.server.systemName}`}
        pairing={pairing}
      >
        <p className="text-sm text-base-content/70">
          {pairingStateSentence(pairing)}
        </p>
        <p className="text-sm text-base-content/70">
          Requested {describeAge(pairing.requestedAt, new Date())}, in{" "}
          <Link to={`/events/${pairing.eventSlug}`} className="link">
            {pairing.eventSlug}
          </Link>
          {pairing.sides.length === 2
            ? " - you are on both sides of it."
            : pairing.sides.includes("server")
              ? " - you are the server's side."
              : " - you are the client's side."}
        </p>
      </PairingHeading>

      <OperationAlert operation={operation} />
      <OperationAlert operation={taken} />

      {pairing.clientId === null ? null : (
        <div role="status" className="alert alert-soft alert-success">
          <KeyIcon size={16} />
          <span>
            {pairing.server.systemName} issued the client identifier{" "}
            <code className="font-mono">{pairing.clientId}</code>
          </span>
        </div>
      )}

      {pairing.scopeWarning === null ? null : (
        <div role="status" className="alert alert-soft alert-warning">
          <AlertIcon size={16} />
          <div className="flex flex-col gap-1">
            <span>
              {scopeWarningSentence(
                pairing.scopeWarning,
                pairing.server.systemName,
                new Date(),
              )}
            </span>
            <span className="text-xs">
              It advertised{" "}
              <code className="font-mono">
                {pairing.scopeWarning.advertisedScopes.join(" ")}
              </code>
              . Both organisations see this warning.
            </span>
          </div>
        </div>
      )}

      {refusal === null ? null : (
        <div role="status" className="alert alert-soft alert-warning">
          <XCircleIcon size={16} />
          <span>{refusal}</span>
        </div>
      )}

      <Panel title="The two sides" icon={<PlugIcon size={18} />}>
        <DetailList
          details={[
            {
              label: "Client",
              value: `${pairing.client.systemName} (${pairing.client.organisation.name})`,
            },
            {
              label: "Server",
              value: `${pairing.server.systemName} (${pairing.server.organisation.name})`,
            },
            { label: "Registration", value: pairing.registrationMode },
          ]}
        />
      </Panel>

      <Panel
        title="Registration details"
        icon={<ServerIcon size={18} />}
        description="What the app's owner submitted when the pairing was requested. A snapshot: the client's own record may have changed since."
      >
        <DetailList
          details={[
            { label: "Client name", value: fields.clientName },
            ...clientDetails(fields),
          ]}
        />
      </Panel>

      {mayRegister(pairing) ? (
        <Panel
          title="Register with no human on the server's side"
          icon={<KeyIcon size={18} />}
          description={`${pairing.server.systemName} accepts registrations that Muster vouches for, so this pairing can be completed without waiting for its organisation.`}
        >
          <Link
            to={`/pairings/${pairing.id}/register`}
            className="btn btn-primary btn-sm self-start"
          >
            <KeyIcon size={16} />
            Register at {pairing.server.systemName}
          </Link>
        </Panel>
      ) : null}

      {pairing.statement === null ? null : (
        <Panel
          title="What Muster vouched for"
          icon={<ShieldLockIcon size={18} />}
          description="The software statement Muster signed and presented. Both organisations can read it; it carries no secret."
        >
          <div className="flex flex-col gap-3">
            <DetailList
              details={[
                {
                  label: "Statement",
                  value: pairing.statement.jti,
                  mono: true,
                },
                {
                  label: "Signed with",
                  value: pairing.statement.keyId,
                  mono: true,
                },
                { label: "Vouches until", value: pairing.statement.expiresAt },
              ]}
            />
            <a
              className="btn btn-sm self-start"
              href={pairing.statement.downloadPath}
              download={`${pairing.statement.jti}.jws`}
            >
              <DownloadIcon size={16} />
              Download the statement
            </a>
          </div>
        </Panel>
      )}

      {mayFulfilByHand(pairing) ? (
        <Panel
          title="Register the client"
          icon={<CheckCircleIcon size={18} />}
          description="Record the client identifier you issued. The app's owner is told, and both of you see it here."
        >
          <PairingActionForm
            what="Recording the client identifier"
            label="Client identifier"
            hint="The client_id your server issued for this app."
            multiline={false}
            submit="Fulfil the request"
            icon={<CheckCircleIcon size={16} />}
            body={(clientId) => ({ clientId })}
            path={`/api/pairings/${pairing.id}/fulfil`}
            onDone={handleDone}
          />
        </Panel>
      ) : null}

      {mayTake(pairing, "decline") ? (
        <Panel
          title="Decline the request"
          icon={<XCircleIcon size={18} />}
          description="Say why, so the app's owner can fix it and ask again."
        >
          <PairingActionForm
            what="Declining the request"
            label="Reason"
            hint="What would have to change for you to register this client."
            multiline
            submit="Decline"
            icon={<XCircleIcon size={16} />}
            body={(reason) => ({ reason })}
            path={`/api/pairings/${pairing.id}/decline`}
            onDone={handleDone}
          />
        </Panel>
      ) : null}

      <Panel
        title="History"
        icon={<HistoryIcon size={18} />}
        description="The same history for both organisations, in the order things happened."
      >
        <Timeline pairing={pairing} />
      </Panel>
    </div>
  );
}
