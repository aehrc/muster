/**
 * One pairing: what was asked for, what has happened, and what to do next.
 *
 * The wireframe's three regions, and each is a requirement rather than a layout choice. The
 * registration details are the snapshot the request carried, which is everything a server owner
 * needs to register the client without asking a question by email (FR-012). The timeline is the
 * history both organisations read, identically (FR-013) - so it is rendered from what the server
 * sent and nothing about it depends on which side is looking. The respond block appears only when
 * the server said this caller may act, which is what keeps the console from holding a second copy
 * of who may answer a pairing (FR-014).
 *
 * A member of both organisations sees both sides and both actions, and the timeline says which
 * organisation each action was taken for (spec edge case).
 *
 * The scope warning sits with the registration details because that is what it is about: a scope
 * the server does not advertise is a field the app owner has to change or the server owner has to
 * explain. Both parties see the identical warning (FR-019), and it names the scopes rather than
 * counting them, because a count is not something either of them can act on.
 *
 * Author: John Grimes
 */

import { useState } from "react";
import { Link } from "react-router";

import { usePairingEntry } from "./pairingEntry.js";
import { describePairingState } from "./pairingFilters.js";
import { describeError } from "../api/errors.js";
import { usePairingAnswer } from "../api/queries.js";
import { SubmitButton, TextField } from "../components/fields.js";
import { StatusIcon, StatusLabel } from "../components/icons.js";
import {
  DetailRow,
  EmptyState,
  ErrorAlert,
  InfoAlert,
  PageHeader,
  Panel,
} from "../components/layout.js";
import { PAIRING_STATE_STATES } from "../components/statusStates.js";
import { fullTime } from "../formatting/times.js";
import { dcrRunPath, ROUTES } from "../routes.js";

import type { PairingDetail as Pairing, ScopeWarning } from "@muster/contracts";

/** A pairing's registration snapshot, its timeline and the actions the caller may take. */
export function PairingDetail({ id }: Readonly<{ readonly id: string }>) {
  const entry = usePairingEntry(id);

  if (entry.pairing === undefined) {
    return entry.fallback;
  }
  const { pairing } = entry;

  return (
    <article className="flex flex-col">
      <p className="mb-2 text-sm">
        <Link className="link" to={ROUTES.pairings}>
          &larr; Back to pairings
        </Link>
      </p>

      <PageHeader
        title={`${pairing.client.name} → ${pairing.server.name}`}
        status={
          <StatusLabel state={PAIRING_STATE_STATES[pairing.state]}>
            {describePairingState(pairing.state)}
          </StatusLabel>
        }
        subtitle={`${pairing.event.name} - ${pairing.client.organisation.name} to ${pairing.server.organisation.name}`}
      />

      {pairing.clientId === null ? null : (
        <InfoAlert>
          Registered. The issued client identifier is{" "}
          <strong>{pairing.clientId}</strong>.
        </InfoAlert>
      )}
      {pairing.declineReason === null ? null : (
        <ErrorAlert message={`Declined: ${pairing.declineReason}`} />
      )}
      {pairing.statement === null ? null : (
        <p className="text-base-content/70 mb-2 text-sm">
          A software statement was minted for this pairing on{" "}
          {fullTime(pairing.statement.mintedAt)}, signed with{" "}
          <code className="wrap-anywhere">{pairing.statement.keyId}</code>, and
          vouches until {fullTime(pairing.statement.expiresAt)}.
        </p>
      )}
      {pairing.state === "lapsed" ? (
        <p className="text-base-content/70 mb-2 text-sm">
          This pairing was still waiting for an answer when the event closed, so
          it lapsed. Its record stays readable.
        </p>
      ) : null}

      {/* The wireframe's two columns: what was asked for on the left, where it has got to
          and what to do about it on the right. They stack below the breakpoint. */}
      <div className="flex flex-col gap-x-4 lg:flex-row lg:items-start">
        <div className="flex min-w-0 flex-col lg:flex-2">
          <Panel
            title="Registration details"
            description="The field set as submitted. A snapshot: editing the client's own entry afterwards does not change what was asked for here."
          >
            <DetailRow label="Client name">
              {pairing.registrationFields.clientName}
            </DetailRow>
            <DetailRow label="Launch URL">
              <span className="wrap-anywhere">
                {pairing.registrationFields.launchUrl}
              </span>
            </DetailRow>
            <DetailRow label="Redirect URIs">
              <ul className="flex flex-col gap-1">
                {pairing.registrationFields.redirectUris.map((uri) => (
                  <li className="wrap-anywhere" key={uri}>
                    {uri}
                  </li>
                ))}
              </ul>
            </DetailRow>
            <DetailRow label="Scopes">
              <span className="wrap-anywhere">
                {pairing.registrationFields.scopes.join(" ")}
              </span>
            </DetailRow>
            <DetailRow label="Confidentiality">
              {pairing.registrationFields.confidentiality === "confidential"
                ? "Confidential"
                : "Public"}
            </DetailRow>
            <DetailRow label="Launch context">
              {pairing.registrationFields.launchContext.length === 0
                ? "None stated"
                : pairing.registrationFields.launchContext}
            </DetailRow>
            <DetailRow label="Token introspection">
              {pairing.registrationFields.needsIntrospection
                ? "Required"
                : "Not required"}
            </DetailRow>
            {pairing.scopeWarning === null ? null : (
              <ScopeWarningNotice warning={pairing.scopeWarning} />
            )}
          </Panel>
        </div>

        <div className="flex min-w-0 flex-col lg:flex-1">
          <Panel
            title="Timeline"
            description="The same history for both organisations. Every transition emails the counterparty."
          >
            <Timeline pairing={pairing} />
          </Panel>
          <Panel title="Your part in it">
            <DetailRow label="Sides you hold">
              {pairing.sides.length === 0
                ? "None"
                : pairing.sides
                    .map((side) =>
                      side === "client" ? "App owner" : "Server owner",
                    )
                    .join(" and ")}
            </DetailRow>
            <DetailRow label="Requested">
              <span className="wrap-anywhere">{pairing.requestedAt}</span>
            </DetailRow>
          </Panel>
        </div>
      </div>

      {pairing.actions.includes("register") ? (
        <RegisterPanel id={id} pairing={pairing} />
      ) : null}

      {pairing.actions.includes("fulfil") ||
      pairing.actions.includes("decline") ? (
        <RespondPanel id={id} pairing={pairing} />
      ) : null}
    </article>
  );
}

/**
 * The scopes the server does not advertise (FR-019, scenario 4).
 *
 * Named rather than counted, and dated: the warning is only as current as the check behind it, so
 * a server that has since added the scope is not argued with silently.
 */
function ScopeWarningNotice({
  warning,
}: Readonly<{ readonly warning: ScopeWarning }>) {
  return (
    <div className="alert alert-warning alert-soft mt-2 items-start">
      <StatusIcon state="warning" />
      <div className="min-w-0">
        <strong>
          Scope warning:{" "}
          {warning.unsupportedScopes.length === 1
            ? `${warning.unsupportedScopes[0] ?? ""} is not among`
            : `${warning.unsupportedScopes.join(", ")} are not among`}{" "}
          the server&apos;s advertised scopes.
        </strong>
        <div className="text-sm opacity-70">
          Observed when the server was last checked,{" "}
          {fullTime(warning.checkedAt)}.
        </div>
      </div>
    </div>
  );
}

/** Every recorded transition, oldest first, with who did it and for whom. */
function Timeline({ pairing }: Readonly<{ readonly pairing: Pairing }>) {
  return (
    <ul className="flex flex-col gap-2 text-sm">
      {pairing.timeline.map((entry) => (
        <li key={entry.id}>
          <span className="wrap-anywhere">{entry.at}</span> -{" "}
          {entry.fromState === null
            ? "Requested"
            : describePairingState(entry.toState)}{" "}
          by {entry.actorDisplayName ?? "Muster"}
          {entry.actingFor === null ? "" : ` (${entry.actingFor.name})`}
          {entry.clientId === null ? null : (
            <div className="wrap-anywhere">client_id {entry.clientId}</div>
          )}
          {entry.reason === null ? null : (
            <div className="text-base-content/60">{entry.reason}</div>
          )}
          {entry.notifies.length === 0 ? null : (
            <div className="text-base-content/60">
              {entry.notifies
                .map((side) =>
                  side === "client"
                    ? pairing.client.organisation.name
                    : pairing.server.organisation.name,
                )
                .join(" and ")}{" "}
              notified by email
            </div>
          )}
        </li>
      ))}
      {pairing.state === "requested" ? (
        <li className="text-base-content/60">
          Pending - awaiting a response from {pairing.server.organisation.name}
        </li>
      ) : null}
    </ul>
  );
}

/**
 * The trusted-DCR run, offered to the app owner (FR-026).
 *
 * A link rather than a button, because the run has a screen of its own: it reports three steps,
 * and it may hand back a secret that is shown once and must not be lost to a navigation the
 * reader did not choose.
 */
function RegisterPanel({
  id,
  pairing,
}: Readonly<{ readonly id: string; readonly pairing: Pairing }>) {
  return (
    <Panel
      title="Register automatically"
      description={`${pairing.server.name} accepts Muster-vouched registration, so no human on the server side is needed.`}
    >
      <p>
        Muster signs the registration details above into a software statement,
        presents it to the server, and records the client identifier it issues.
        The statement expires no later than the end of {pairing.event.name} plus
        its grace period.
      </p>
      <p>
        <Link className="btn btn-primary" to={dcrRunPath(id)}>
          Open the registration run
        </Link>
      </p>
    </Panel>
  );
}

/**
 * Fulfilling or declining.
 *
 * Shown only when the server offered the action. Each form reports its own state - working,
 * refused with the server's own words, or gone - because a button that looks unpressed while a
 * request is in flight invites a second one (FR-037).
 */
function RespondPanel({
  id,
  pairing,
}: Readonly<{ readonly id: string; readonly pairing: Pairing }>) {
  const answer = usePairingAnswer(id);
  const [clientId, setClientId] = useState("");
  const [reason, setReason] = useState("");

  return (
    <section className="flex flex-wrap gap-4 [&>section]:flex-1 [&>section]:basis-64">
      {pairing.actions.includes("fulfil") ? (
        <Panel
          title="Fulfil"
          description="Record the client identifier your server issued. The app owner is emailed."
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              answer.mutate({ kind: "fulfil", clientId });
            }}
          >
            <TextField
              label="Issued client identifier"
              value={clientId}
              placeholder="e.g. smart-forms-mr-2291"
              required
              onChange={setClientId}
            />
            <SubmitButton pending={answer.isPending}>
              Mark fulfilled
            </SubmitButton>
          </form>
        </Panel>
      ) : null}

      {pairing.actions.includes("decline") ? (
        <Panel
          title="Decline"
          description="A reason is required: without one the app owner has nothing to fix."
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              answer.mutate({ kind: "decline", reason });
            }}
          >
            <TextField
              label="Reason"
              value={reason}
              placeholder="e.g. redirect URI not permitted in our environment"
              required
              onChange={setReason}
            />
            <SubmitButton pending={answer.isPending}>Decline</SubmitButton>
          </form>
        </Panel>
      ) : null}

      {answer.error === null ? null : (
        <ErrorAlert message={describeError(answer.error)} />
      )}
      {answer.data === undefined || answer.data.notified ? null : (
        <EmptyState>
          Recorded, but the notification could not be sent. Tell the other
          organisation another way.
        </EmptyState>
      )}
    </section>
  );
}
