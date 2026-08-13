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
 * Scope warnings are absent: they need a check to have run against the server (User Story 3).
 *
 * Author: John Grimes
 */

import { useState } from "react";
import { Link } from "react-router";

import { describePairingState } from "./pairingFilters.js";
import { describeError } from "../api/errors.js";
import { usePairing, usePairingAnswer } from "../api/queries.js";
import { SubmitButton, TextField } from "../components/fields.js";
import {
  DetailRow,
  EmptyState,
  ErrorAlert,
  InfoAlert,
  Loading,
  PageHeader,
  Panel,
} from "../components/layout.js";
import { ROUTES } from "../routes.js";

import type { PairingDetail as Pairing } from "@muster/contracts";

/** A pairing's registration snapshot, its timeline and the actions the caller may take. */
export function PairingDetail({ id }: Readonly<{ readonly id: string }>) {
  const entry = usePairing(id);

  if (entry.isPending) {
    return <Loading label="Loading the pairing" />;
  }
  if (entry.error !== null) {
    return <ErrorAlert message={describeError(entry.error)} />;
  }

  const { pairing } = entry.data;

  return (
    <article className="page-wide">
      <p className="back">
        <Link to={ROUTES.pairings}>&larr; Back to pairings</Link>
      </p>

      <PageHeader
        title={`${pairing.client.name} → ${pairing.server.name}`}
        status={describePairingState(pairing.state)}
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
      {pairing.state === "lapsed" ? (
        <p className="note">
          This pairing was still waiting for an answer when the event closed, so
          it lapsed. Its record stays readable.
        </p>
      ) : null}

      <div className="detail-columns">
        <div className="detail-main">
          <Panel
            title="Registration details"
            description="The field set as submitted. A snapshot: editing the client's own entry afterwards does not change what was asked for here."
          >
            <DetailRow label="Client name">
              {pairing.registrationFields.clientName}
            </DetailRow>
            <DetailRow label="Launch URL">
              <span className="wrap">
                {pairing.registrationFields.launchUrl}
              </span>
            </DetailRow>
            <DetailRow label="Redirect URIs">
              <ul className="plain-list">
                {pairing.registrationFields.redirectUris.map((uri) => (
                  <li className="wrap" key={uri}>
                    {uri}
                  </li>
                ))}
              </ul>
            </DetailRow>
            <DetailRow label="Scopes">
              <span className="wrap">
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
          </Panel>
        </div>

        <div className="detail-side">
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
              <span className="wrap">{pairing.requestedAt}</span>
            </DetailRow>
          </Panel>
        </div>
      </div>

      {pairing.actions.length === 0 ? null : (
        <RespondPanel id={id} pairing={pairing} />
      )}
    </article>
  );
}

/** Every recorded transition, oldest first, with who did it and for whom. */
function Timeline({ pairing }: Readonly<{ readonly pairing: Pairing }>) {
  return (
    <ul className="plain-list">
      {pairing.timeline.map((entry) => (
        <li key={entry.id}>
          <span className="wrap">{entry.at}</span> -{" "}
          {entry.fromState === null
            ? "Requested"
            : describePairingState(entry.toState)}{" "}
          by {entry.actorDisplayName ?? "Muster"}
          {entry.actingFor === null ? "" : ` (${entry.actingFor.name})`}
          {entry.clientId === null ? null : (
            <div className="wrap">client_id {entry.clientId}</div>
          )}
          {entry.reason === null ? null : (
            <div className="quiet">{entry.reason}</div>
          )}
          {entry.notifies.length === 0 ? null : (
            <div className="quiet">
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
        <li className="quiet">
          Pending - awaiting a response from {pairing.server.organisation.name}
        </li>
      ) : null}
    </ul>
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
    <section className="card-row">
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
