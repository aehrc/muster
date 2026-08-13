/**
 * Asking a server to register one of your clients.
 *
 * Lives on the server's page in the event view, which is where somebody browsing the directory
 * decides they want to pair with it - and it is the place FR-016 is about: a server whose
 * registration mode is `open` needs no registration, so this panel says so and offers no button.
 * The server refuses such a request as well; the console is not a security boundary.
 *
 * The fields are prefilled from the chosen client's own record and editable before submission
 * (FR-012), and the choice of client is limited to the caller's clients enrolled in *this* event,
 * because a pairing exists within a single event (scenario 6).
 *
 * Author: John Grimes
 */

import { useState } from "react";
import { Link } from "react-router";

import { conflictingPairingId, describeError } from "../api/errors.js";
import { useMyOrganisations, usePairingRequest } from "../api/queries.js";
import {
  CheckField,
  SelectField,
  SubmitButton,
  TextAreaField,
  TextField,
} from "../components/fields.js";
import {
  EmptyState,
  ErrorAlert,
  InfoAlert,
  Loading,
  Panel,
} from "../components/layout.js";
import {
  clientCandidates,
  pairingRequestForm,
  pairingRequestFormProblem,
  registrationFieldsFrom,
} from "../forms/pairingRequestForm.js";
import { pairingPath, ROUTES } from "../routes.js";

import type { PairingRequestForm } from "../forms/pairingRequestForm.js";
import type { EnrolledSystem, EventDetail } from "@muster/contracts";

/** Whether this server needs a pairing at all, and if so, the form to ask for one. */
export function RequestPairing({
  event,
  system,
  signedIn,
}: Readonly<{
  readonly event: EventDetail;
  readonly system: EnrolledSystem;
  readonly signedIn: boolean;
}>) {
  const mine = useMyOrganisations();
  const request = usePairingRequest();
  const [selected, setSelected] = useState("");
  const [form, setForm] = useState<PairingRequestForm | undefined>();

  const mode = system.serverProfile?.registrationMode;
  if (mode === "open") {
    // FR-016 and scenario 5: no registration is needed, so no request is offered.
    return (
      <Panel title="Pairing">
        <p>
          No pairing is needed. This server&apos;s registration mode is open: it
          accepts any client without registration, so there is nothing to
          request.
        </p>
      </Panel>
    );
  }
  if (!signedIn) {
    return (
      <Panel title="Pairing">
        <EmptyState>
          <Link to={ROUTES.signIn}>Sign in</Link> as an approved member to
          request a pairing for one of your clients.
        </EmptyState>
      </Panel>
    );
  }
  if (mine.isPending) {
    return (
      <Panel title="Pairing">
        <Loading label="Loading your clients" />
      </Panel>
    );
  }

  const candidates = clientCandidates(
    mine.data?.organisations ?? [],
    event.slug,
  );
  if (candidates.length === 0) {
    return (
      <Panel title="Pairing">
        <EmptyState>
          None of your clients is enrolled in this event yet. Enrol one from{" "}
          <Link to={ROUTES.myOrganisation}>your organisation</Link>, then come
          back.
        </EmptyState>
      </Panel>
    );
  }

  const candidate =
    candidates.find((one) => one.enrolmentId === selected) ?? candidates[0];
  const system_ = mine.data?.organisations
    .flatMap((organisation) => organisation.systems)
    .find((one) => one.id === candidate?.systemId);
  const values =
    form ?? (system_ === undefined ? undefined : pairingRequestForm(system_));
  if (candidate === undefined || values === undefined) {
    return (
      <Panel title="Pairing">
        <EmptyState>None of your clients can be paired here.</EmptyState>
      </Panel>
    );
  }

  const problem = pairingRequestFormProblem(values);
  const existing = conflictingPairingId(request.error);

  return (
    <Panel
      title="Request a pairing"
      description={
        mode === "trustedDcr"
          ? "This server accepts Muster-signed registrations. The request records what would be registered."
          : "The server's members are emailed and answer with the client identifier they issue."
      }
    >
      {request.data === undefined ? null : (
        <InfoAlert>
          Requested.{" "}
          <Link to={pairingPath(request.data.pairing.id)}>
            Watch it on the pairing&apos;s page
          </Link>
          .{" "}
          {request.data.notified
            ? `${system.organisation.name} has been emailed.`
            : "The notification could not be sent, so tell them another way."}
        </InfoAlert>
      )}
      {request.error === null ? null : (
        <ErrorAlert message={describeError(request.error)} />
      )}
      {existing === undefined ? null : (
        <p className="note">
          <Link to={pairingPath(existing)}>
            Open the pairing you already have
          </Link>
          .
        </p>
      )}

      <form
        onSubmit={(event_) => {
          event_.preventDefault();
          request.mutate({
            eventSlug: event.slug,
            clientEnrolmentId: candidate.enrolmentId,
            serverEnrolmentId: system.enrolmentId,
            registrationFields: registrationFieldsFrom(values),
          });
        }}
      >
        <SelectField
          label="Your client"
          value={candidate.enrolmentId}
          options={candidates.map((one) => ({
            value: one.enrolmentId,
            label: one.name,
          }))}
          hint="Only your clients enrolled in this event. A pairing exists within one event."
          onChange={(enrolmentId) => {
            setSelected(enrolmentId);
            // The fields belong to the client that was chosen, so choosing another starts from
            // that record's prefill rather than keeping the previous one's edits.
            setForm(undefined);
          }}
        />
        <TextField
          label="Client name"
          value={values.clientName}
          onChange={(clientName) => {
            setForm({ ...values, clientName });
          }}
        />
        <TextField
          label="Launch URL"
          value={values.launchUrl}
          onChange={(launchUrl) => {
            setForm({ ...values, launchUrl });
          }}
        />
        <TextAreaField
          label="Redirect URIs"
          value={values.redirectUris}
          hint="One per line."
          onChange={(redirectUris) => {
            setForm({ ...values, redirectUris });
          }}
        />
        <TextField
          label="Scopes"
          value={values.scopes}
          hint="Space-separated, as SMART writes them."
          onChange={(scopes) => {
            setForm({ ...values, scopes });
          }}
        />
        <SelectField
          label="Confidentiality"
          value={values.confidentiality}
          options={[
            { value: "public", label: "Public" },
            { value: "confidential", label: "Confidential" },
          ]}
          onChange={(confidentiality) => {
            setForm({ ...values, confidentiality });
          }}
        />
        <TextField
          label="Launch context"
          value={values.launchContext}
          hint="Which launch context this client needs the server to supply."
          onChange={(launchContext) => {
            setForm({ ...values, launchContext });
          }}
        />
        <CheckField
          label="Needs token introspection"
          checked={values.needsIntrospection}
          onChange={(needsIntrospection) => {
            setForm({ ...values, needsIntrospection });
          }}
        />

        {problem === undefined ? null : <p className="note">{problem}</p>}
        <SubmitButton pending={request.isPending}>
          Request the pairing
        </SubmitButton>
      </form>
    </Panel>
  );
}
