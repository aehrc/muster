/*
 * Copyright © 2026 Commonwealth Scientific and Industrial Research Organisation
 * (CSIRO) ABN 41 687 119 230. Licensed under the Apache License, Version 2.0.
 */

import {
  eventsResponseSchema,
  eventSystemsSchema,
  pairingResponseSchema,
  pairingsResponseSchema,
} from "@muster/contracts";
import {
  ArrowRightIcon,
  LinkIcon,
  PaperAirplaneIcon,
  PlugIcon,
} from "@primer/octicons-react";
import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";

import { muster } from "../api/muster.ts";
import { useResource } from "../api/useResource.ts";
import {
  CheckboxField,
  SelectField,
  TextAreaField,
  TextField,
} from "../components/Fields.tsx";
import { IssueList } from "../components/IssueList.tsx";
import { OperationAlert } from "../components/OperationAlert.tsx";
import { Panel } from "../components/Panel.tsx";
import { StandingNotice } from "../components/StandingNotice.tsx";
import { standingFor } from "../lib/account.ts";
import { describeAge } from "../lib/format.ts";
import { busy, failed, idle, pending, succeeded } from "../lib/operation.ts";
import {
  buildPairingRequest,
  emptyPairingForm,
  existingPairing,
  filterPairings,
  ownClients,
  pairableServers,
  pairingFormFor,
  pairingStateClass,
  pairingStateWords,
  refusalNotice,
} from "../lib/pairings.ts";
import { useSession } from "../session/sessionContext.ts";

import type { Operation } from "../lib/operation.ts";
import type { PairingFormValues } from "../lib/pairings.ts";
import type {
  EnrolledSystem,
  PairingState,
  PairingSummary,
} from "@muster/contracts";
import type { JSX } from "react";

/**
 * The pairing list: every pairing the reader's organisations are part of.
 *
 * Both directions, because a member of the server's organisation needs the same
 * list as the app owner (FR-013): the pairings this organisation asked for and the
 * ones it was asked for, in one place, with the state of each on the card.
 *
 * Requesting one is the other half of the screen. The servers offered are the ones
 * that register clients at all - an `open` server needs no pairing, so there is no
 * button for it (FR-016) - and the field set arrives prefilled from the chosen
 * client's own record, editable before it is sent (FR-012).
 *
 * @author John Grimes
 */

/** What requesting a pairing is called in its messages. */
const requesting = "Requesting the pairing";

/** The states the filter offers. */
const stateOptions = [
  { value: "all", label: "Every state" },
  { value: "requested", label: "Requested" },
  { value: "fulfilled", label: "Fulfilled" },
  { value: "declined", label: "Declined" },
  { value: "failed", label: "Failed" },
  { value: "lapsed", label: "Lapsed" },
];

/**
 * Renders one pairing in the list.
 *
 * @param props - the pairing to show
 * @returns the card
 */
function PairingCard({
  pairing,
}: Readonly<{
  /** the pairing to show */
  pairing: PairingSummary;
}>): JSX.Element {
  const refusal = refusalNotice(pairing);
  return (
    <li className="flex flex-col gap-2 rounded-box border border-base-300 bg-base-100 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex flex-wrap items-center gap-2 font-semibold">
          <Link to={`/pairings/${pairing.id}`} className="link link-hover">
            {pairing.client.systemName}
          </Link>
          <ArrowRightIcon size={14} />
          {pairing.server.systemName}
        </h3>
        <span className={`badge badge-sm ${pairingStateClass[pairing.state]}`}>
          {pairingStateWords[pairing.state]}
        </span>
      </div>
      <p className="text-sm text-base-content/70">
        {pairing.client.organisation.name} asked{" "}
        {pairing.server.organisation.name},{" "}
        {describeAge(pairing.requestedAt, new Date())}
        {pairing.sides.length === 2
          ? " - you are on both sides"
          : pairing.sides.includes("server")
            ? " - you are the server"
            : " - you are the client"}
      </p>
      {pairing.clientId === null ? null : (
        <p className="text-sm">
          Client identifier{" "}
          <code className="font-mono">{pairing.clientId}</code>
        </p>
      )}
      {refusal === null ? null : (
        <p className="text-sm text-base-content/70">{refusal}</p>
      )}
    </li>
  );
}

/**
 * The pairing list screen.
 *
 * @returns the screen
 * @author John Grimes
 */
export function Pairings(): JSX.Element {
  const { session, operation: sessionOperation } = useSession();
  const [search, setSearch] = useSearchParams();
  const standing = standingFor(session);
  const organisationIds = (session?.memberships ?? []).map(
    (membership) => membership.organisationId,
  );

  const events = useResource(
    "/api/events",
    eventsResponseSchema,
    "Loading the events",
  );
  const asked = search.get("event");
  const slug =
    asked ??
    events.data?.events.find((event) => event.status === "open")?.slug ??
    events.data?.events[0]?.slug ??
    null;

  const pairings = useResource(
    slug === null ? null : `/api/pairings?event=${slug}`,
    pairingsResponseSchema,
    "Loading your pairings",
  );
  const systems = useResource(
    slug === null ? null : `/api/events/${slug}/systems`,
    eventSystemsSchema,
    "Loading the event's systems",
  );

  const [state, setState] = useState<PairingState | "all">("all");
  const [values, setValues] = useState<PairingFormValues>(emptyPairingForm);
  const [issues, setIssues] = useState<readonly string[]>([]);
  const [operation, setOperation] = useState<Operation>(idle);

  const clients = useMemo(
    () => ownClients(systems.data?.systems ?? [], organisationIds),
    [systems.data, organisationIds],
  );
  const servers = useMemo(
    () => pairableServers(systems.data?.systems ?? []),
    [systems.data],
  );
  const shown = filterPairings(pairings.data?.pairings ?? [], state);
  const clash = existingPairing(
    pairings.data?.pairings ?? [],
    values.clientEnrolmentId,
    values.serverEnrolmentId,
  );

  // Choosing a client refills the field set from its record; changing the server
  // leaves whatever has been edited alone.
  const chooseClient = (enrolmentId: string): void => {
    const chosen = clients.find((entry) => entry.enrolmentId === enrolmentId);
    setIssues([]);
    setValues(
      chosen === undefined
        ? { ...values, clientEnrolmentId: enrolmentId }
        : pairingFormFor(chosen, values.serverEnrolmentId),
    );
  };

  const handleRequest = async (): Promise<void> => {
    if (slug === null) {
      return;
    }
    const outcome = buildPairingRequest(slug, values);
    setIssues(outcome.ok ? [] : outcome.issues);
    if (!outcome.ok) {
      return;
    }
    setOperation(pending(requesting));
    const result = await muster.post(
      "/api/pairings",
      outcome.value,
      pairingResponseSchema,
    );
    if (!result.ok) {
      setOperation(failed(requesting, result.failure));
      pairings.reload();
      return;
    }
    setValues(emptyPairingForm);
    setOperation(
      succeeded(
        requesting,
        `${result.data.pairing.server.systemName} has been asked to register ${result.data.pairing.client.systemName}, and its members have been notified.`,
      ),
    );
    pairings.reload();
  };

  if (!standing.canWrite) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-2xl font-bold sm:text-3xl">Pairings</h1>
        <OperationAlert operation={sessionOperation} />
        <StandingNotice standing={standing} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-bold sm:text-3xl">Pairings</h1>
        <p className="text-sm text-base-content/70">
          Every pairing your organisations are part of, in both directions.
        </p>
      </header>

      <OperationAlert operation={events.operation} />
      <OperationAlert operation={pairings.operation} />
      <OperationAlert operation={systems.operation} />

      <section
        aria-label="Filters"
        className="flex flex-col gap-3 rounded-box border border-base-300 bg-base-200 p-4 sm:flex-row sm:items-end"
      >
        <div className="flex-1">
          <SelectField
            label="Event"
            options={(events.data?.events ?? []).map((event) => ({
              value: event.slug,
              label: `${event.name} (${event.status})`,
            }))}
            value={slug ?? ""}
            onChange={(chosen) => {
              setSearch({ event: chosen });
            }}
          />
        </div>
        <div className="sm:w-64">
          <SelectField
            label="State"
            options={stateOptions}
            value={state}
            onChange={(chosen) => {
              setState(chosen === "all" ? "all" : (chosen as PairingState));
            }}
          />
        </div>
      </section>

      <Panel
        title="Your pairings"
        icon={<LinkIcon size={18} />}
        description="Open one to see its history, the registration details, and what can be done next."
      >
        {shown.length === 0 ? (
          <p className="text-sm text-base-content/70">
            {(pairings.data?.pairings ?? []).length === 0
              ? "Your organisations have no pairings in this event yet."
              : "No pairing in this event is in that state."}
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {shown.map((pairing) => (
              <PairingCard key={pairing.id} pairing={pairing} />
            ))}
          </ul>
        )}
      </Panel>

      <Panel
        title="Request a pairing"
        icon={<PlugIcon size={18} />}
        description="Choose one of your enrolled clients and an enrolled server that registers clients. The details are prefilled from the client's record and can be edited before you send them."
      >
        {clients.length === 0 || servers.length === 0 ? (
          <p className="text-sm text-base-content/70">
            {clients.length === 0
              ? "None of your organisations has a client enrolled in this event."
              : "No server in this event needs a registration, so there is nothing to request."}
          </p>
        ) : (
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void handleRequest();
            }}
          >
            <div className="flex flex-col gap-3 sm:flex-row">
              <div className="flex-1">
                <SelectField
                  label="Your client"
                  options={[
                    { value: "", label: "Choose a client" },
                    ...clients.map((entry) => ({
                      value: entry.enrolmentId,
                      label: entry.system.name,
                    })),
                  ]}
                  value={values.clientEnrolmentId}
                  onChange={chooseClient}
                />
              </div>
              <div className="flex-1">
                <SelectField
                  label="The server"
                  options={[
                    { value: "", label: "Choose a server" },
                    ...servers.map((entry: EnrolledSystem) => ({
                      value: entry.enrolmentId,
                      label: `${entry.system.name} (${entry.organisation.name})`,
                    })),
                  ]}
                  value={values.serverEnrolmentId}
                  onChange={(serverEnrolmentId) => {
                    setValues({ ...values, serverEnrolmentId });
                  }}
                />
              </div>
            </div>

            <TextField
              label="Client name"
              hint="What the server should record this client as."
              value={values.clientName}
              onChange={(clientName) => {
                setValues({ ...values, clientName });
              }}
            />
            <TextField
              label="Launch URL"
              value={values.launchUrl}
              onChange={(launchUrl) => {
                setValues({ ...values, launchUrl });
              }}
            />
            <TextAreaField
              label="Redirect URIs"
              hint="One per line."
              value={values.redirectUris}
              onChange={(redirectUris) => {
                setValues({ ...values, redirectUris });
              }}
            />
            <TextAreaField
              label="Scopes"
              hint="One per line, or separated by spaces."
              value={values.scopes}
              onChange={(scopes) => {
                setValues({ ...values, scopes });
              }}
            />
            <div className="flex flex-col gap-3 sm:flex-row">
              <div className="flex-1">
                <SelectField
                  label="Client type"
                  options={[
                    { value: "public", label: "Public (cannot keep a secret)" },
                    {
                      value: "confidential",
                      label: "Confidential (keeps a secret)",
                    },
                  ]}
                  value={values.confidentiality}
                  onChange={(confidentiality) => {
                    setValues({
                      ...values,
                      confidentiality:
                        confidentiality === "confidential"
                          ? "confidential"
                          : "public",
                    });
                  }}
                />
              </div>
              <div className="flex-1">
                <TextField
                  label="Launch context"
                  hint="What the app needs in the launch, such as patient."
                  value={values.launchContext}
                  onChange={(launchContext) => {
                    setValues({ ...values, launchContext });
                  }}
                />
              </div>
            </div>
            <CheckboxField
              label="This client needs token introspection"
              checked={values.needsIntrospection}
              onChange={(needsIntrospection) => {
                setValues({ ...values, needsIntrospection });
              }}
            />

            <IssueList issues={issues} />
            {clash === undefined ? null : (
              <div role="status" className="alert alert-soft alert-warning">
                <LinkIcon size={16} />
                <span>
                  These two are already paired.{" "}
                  <Link to={`/pairings/${clash.id}`} className="link">
                    Open the existing pairing
                  </Link>
                  .
                </span>
              </div>
            )}
            <button
              type="submit"
              className="btn btn-primary btn-sm self-start"
              disabled={busy(operation)}
            >
              <PaperAirplaneIcon size={16} />
              Request the pairing
            </button>
            <OperationAlert operation={operation} />
          </form>
        )}
      </Panel>
    </div>
  );
}
