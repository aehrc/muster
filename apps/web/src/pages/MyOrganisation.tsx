/**
 * My organisation: members, systems, and enrolment.
 *
 * The one page an approved member spends time on. Its shape follows the wireframe - a members
 * table with an invite action, then a card per system with its enrolment state and an edit form -
 * and the enrolment card is the part that carries the requirement: enrolling asks the member to
 * confirm the details are current, and the card says when that last happened (FR-009, SC-008).
 *
 * A member with no organisation yet sees the create form instead. A member who is not approved
 * sees why, because the alternative is a page of controls that all refuse.
 *
 * Author: John Grimes
 */

import { useState } from "react";
import { Link } from "react-router";

import { describeError } from "../api/errors.js";
import {
  useEnrolAction,
  useEvents,
  useMe,
  useMyOrganisations,
  useOrganisationAction,
  useSystemAction,
} from "../api/queries.js";
import {
  CheckField,
  SelectField,
  SubmitButton,
  TextAreaField,
  TextField,
} from "../components/fields.js";
import {
  DetailRow,
  EmptyState,
  ErrorAlert,
  InfoAlert,
  Loading,
  PageHeader,
  Panel,
  Tag,
} from "../components/layout.js";
import {
  EMPTY_SYSTEM_FORM,
  systemForm,
  systemFormProblem,
  systemRequest,
} from "../forms/systemForm.js";
import { ROUTES } from "../routes.js";

import type { SystemForm } from "../forms/systemForm.js";
import type {
  EventSummary,
  MyOrganisation as Organisation,
  OrganisationSystem,
} from "@muster/contracts";

/** The caller's organisations, their members and their systems. */
export function MyOrganisation() {
  const me = useMe();
  const organisations = useMyOrganisations();
  const events = useEvents();
  const action = useOrganisationAction();
  const [name, setName] = useState("");

  const account = me.data?.account ?? null;

  if (me.isPending) {
    return <Loading label="Loading your account" />;
  }
  if (account === null) {
    return (
      <article className="page">
        <PageHeader title="My organisation" />
        <EmptyState>
          <Link to={ROUTES.signIn}>Sign in</Link> to describe the systems your
          organisation brings.
        </EmptyState>
      </article>
    );
  }
  if (account.writeRefusal !== null) {
    return (
      <article className="page">
        <PageHeader title="My organisation" status={account.status} />
        <EmptyState>
          This account cannot create or edit entries yet.{" "}
          <Link to={ROUTES.signIn}>See where it stands</Link>.
        </EmptyState>
      </article>
    );
  }

  const openEvents = (events.data?.events ?? []).filter(
    (event) => event.status === "open",
  );

  return (
    <article className="page-wide">
      <PageHeader
        title="My organisation"
        subtitle={`${account.displayName} - ${account.email}`}
      />

      {organisations.isPending ? (
        <Loading label="Loading your organisations" />
      ) : null}
      {organisations.error === null ? null : (
        <ErrorAlert message={describeError(organisations.error)} />
      )}

      {(organisations.data?.organisations ?? []).map((organisation) => (
        <OrganisationPanel
          key={organisation.id}
          organisation={organisation}
          accountId={account.id}
          openEvents={openEvents}
        />
      ))}

      <Panel
        title="Create an organisation"
        description="You become its first member, and can invite other approved members afterwards."
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            action.mutate({ kind: "create", name });
            setName("");
          }}
        >
          <TextField
            label="Organisation name"
            value={name}
            onChange={setName}
            hint="Names are not unique: two teams from one company are two organisations."
            required
          />
          <SubmitButton pending={action.isPending}>
            Create organisation
          </SubmitButton>
        </form>
        {action.error === null ? null : (
          <ErrorAlert message={describeError(action.error)} />
        )}
      </Panel>
    </article>
  );
}

/** One organisation: its members, its systems, and what can be done to them. */
function OrganisationPanel({
  organisation,
  accountId,
  openEvents,
}: Readonly<{
  readonly organisation: Organisation;
  readonly accountId: string;
  readonly openEvents: readonly EventSummary[];
}>) {
  const action = useOrganisationAction();
  const [invitee, setInvitee] = useState("");
  const [adding, setAdding] = useState(false);

  return (
    <section className="organisation">
      <h2>{organisation.name}</h2>

      <Panel title="Members">
        {organisation.members.length === 0 ? (
          <EmptyState>
            Nobody is left in this organisation. A track admin can reassign it.
          </EmptyState>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Joined</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {organisation.members.map((member) => (
                <tr key={member.accountId}>
                  <td>{member.displayName}</td>
                  <td className="wrap">{member.email}</td>
                  <td>{member.joinedAt.slice(0, 10)}</td>
                  <td>
                    <button
                      type="button"
                      className="button"
                      onClick={() => {
                        action.mutate({
                          kind: "leave",
                          id: organisation.id,
                          accountId: member.accountId,
                        });
                      }}
                    >
                      {member.accountId === accountId ? "Leave" : "Remove"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <form
          onSubmit={(event) => {
            event.preventDefault();
            action.mutate({
              kind: "invite",
              id: organisation.id,
              email: invitee,
            });
            setInvitee("");
          }}
        >
          <TextField
            label="Invite a member"
            type="email"
            value={invitee}
            onChange={setInvitee}
            hint="The invitee must already be an approved Muster account."
            required
          />
          <SubmitButton pending={action.isPending}>Invite member</SubmitButton>
        </form>
        {action.error === null ? null : (
          <ErrorAlert message={describeError(action.error)} />
        )}
      </Panel>

      {organisation.systems.map((system) => (
        <SystemCard
          key={system.id}
          organisationId={organisation.id}
          system={system}
          openEvents={openEvents}
        />
      ))}

      {adding ? (
        <SystemFormPanel
          title="Add a system"
          organisationId={organisation.id}
          initial={EMPTY_SYSTEM_FORM}
          onDone={() => {
            setAdding(false);
          }}
        />
      ) : (
        <button
          type="button"
          className="button button-primary"
          onClick={() => {
            setAdding(true);
          }}
        >
          Add system
        </button>
      )}
    </section>
  );
}

/** One system, with where it is enrolled and how to change it. */
function SystemCard({
  organisationId,
  system,
  openEvents,
}: Readonly<{
  readonly organisationId: string;
  readonly system: OrganisationSystem;
  readonly openEvents: readonly EventSummary[];
}>) {
  const [editing, setEditing] = useState(false);

  return (
    <Panel
      title={system.name}
      actions={
        <button
          type="button"
          className="button"
          onClick={() => {
            setEditing(!editing);
          }}
        >
          {editing ? "Cancel" : "Edit"}
        </button>
      }
    >
      <div className="chips">
        {system.kinds.map((kind) => (
          <Tag key={kind}>{kind === "server" ? "Server" : "Client"}</Tag>
        ))}
      </div>

      {system.serverProfile === null ? null : (
        <DetailRow label="FHIR base URL">
          <span className="wrap">{system.serverProfile.fhirBaseUrl}</span>
        </DetailRow>
      )}
      {system.clientProfile === null ? null : (
        <>
          <DetailRow label="Launch URL">
            <span className="wrap">{system.clientProfile.launchUrl}</span>
          </DetailRow>
          <DetailRow label="Scopes">
            <span className="wrap">
              {system.clientProfile.scopes.join(" ")}
            </span>
          </DetailRow>
        </>
      )}

      <Enrolment systemId={system.id} system={system} openEvents={openEvents} />

      {editing ? (
        <SystemFormPanel
          title="Edit system"
          systemId={system.id}
          organisationId={organisationId}
          initial={systemForm(system)}
          onDone={() => {
            setEditing(false);
          }}
        />
      ) : null}
    </Panel>
  );
}

/** Where a system is enrolled, and how to enrol it. */
function Enrolment({
  systemId,
  system,
  openEvents,
}: Readonly<{
  readonly systemId: string;
  readonly system: OrganisationSystem;
  readonly openEvents: readonly EventSummary[];
}>) {
  const [slug, setSlug] = useState(openEvents[0]?.slug ?? "");
  const [tags, setTags] = useState("");
  const action = useEnrolAction(slug);

  return (
    <div className="enrolment">
      {system.enrolments.length === 0 ? (
        <EmptyState>Not enrolled in any event.</EmptyState>
      ) : (
        <ul className="plain-list">
          {system.enrolments.map((enrolment) => (
            <li key={enrolment.id}>
              Enrolled in {enrolment.eventName} ({enrolment.eventStatus}) -
              details confirmed {enrolment.confirmedAt.slice(0, 10)}
              {enrolment.tags.length === 0
                ? null
                : ` - ${enrolment.tags.join(", ")}`}
            </li>
          ))}
        </ul>
      )}

      {openEvents.length === 0 ? (
        <p className="note">No event is open for enrolment.</p>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            action.mutate({
              systemId,
              tags: tags
                .split(/[\s,]+/)
                .map((tag) => tag.trim().toLowerCase())
                .filter((tag) => tag.length > 0),
            });
          }}
        >
          <SelectField
            label="Enrol in event"
            value={slug}
            options={openEvents.map((event) => ({
              value: event.slug,
              label: event.name,
            }))}
            onChange={setSlug}
          />
          <TextField
            label="Capability tags"
            value={tags}
            onChange={setTags}
            hint="From the event's own tags, separated by spaces or commas."
          />
          <p className="note">
            Enrolling records that you have confirmed these details are current.
          </p>
          <SubmitButton pending={action.isPending}>
            Enrol and confirm details
          </SubmitButton>
        </form>
      )}
      {action.error === null ? null : (
        <ErrorAlert message={describeError(action.error)} />
      )}
      {action.isSuccess ? (
        <InfoAlert>
          Enrolled, and the details are confirmed as current.
        </InfoAlert>
      ) : null}
    </div>
  );
}

/** The system form, for adding one or editing one. */
function SystemFormPanel({
  title,
  organisationId,
  systemId,
  initial,
  onDone,
}: Readonly<{
  readonly title: string;
  readonly organisationId: string;
  readonly systemId?: string;
  readonly initial: SystemForm;
  readonly onDone: () => void;
}>) {
  const action = useSystemAction();
  const [form, setForm] = useState<SystemForm>(initial);
  const problem = systemFormProblem(form);

  /** Updates one field. */
  const set =
    <K extends keyof SystemForm>(field: K) =>
    (value: SystemForm[K]) => {
      setForm({ ...form, [field]: value });
    };

  return (
    <Panel title={title}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (problem !== undefined) {
            return;
          }
          action.mutate(
            systemId === undefined
              ? {
                  kind: "create",
                  organisationId,
                  system: systemRequest(form),
                }
              : { kind: "edit", systemId, system: systemRequest(form) },
            { onSuccess: onDone },
          );
        }}
      >
        <TextField
          label="Name"
          value={form.name}
          onChange={set("name")}
          required
        />
        <TextAreaField
          label="Description"
          value={form.description}
          onChange={set("description")}
        />

        <CheckField
          label="This system is a server"
          checked={form.isServer}
          onChange={set("isServer")}
        />
        {form.isServer ? (
          <>
            <TextField
              label="FHIR base URL"
              type="url"
              value={form.fhirBaseUrl}
              onChange={set("fhirBaseUrl")}
              placeholder="https://fhir.example.org/r4"
              hint="Must be https."
              required
            />
            <SelectField
              label="Authorization"
              value={form.authorizationMode}
              options={[
                { value: "smart", label: "SMART App Launch" },
                { value: "open", label: "Open - no authorization" },
              ]}
              onChange={set("authorizationMode")}
            />
            <SelectField
              label="Registration mode"
              value={form.registrationMode}
              options={[
                { value: "open", label: "Open - no registration needed" },
                { value: "manual", label: "Manual request" },
                { value: "trustedDcr", label: "Trusted DCR" },
              ]}
              onChange={set("registrationMode")}
            />
            {form.registrationMode === "trustedDcr" ? (
              <TextField
                label="Registration endpoint"
                type="url"
                value={form.registrationEndpoint}
                onChange={set("registrationEndpoint")}
                hint="Where Muster presents a signed software statement."
                required
              />
            ) : null}
            <TextAreaField
              label="Notes"
              value={form.notes}
              onChange={set("notes")}
            />
          </>
        ) : null}

        <CheckField
          label="This system is a client"
          checked={form.isClient}
          onChange={set("isClient")}
        />
        {form.isClient ? (
          <>
            <TextField
              label="Launch URL"
              type="url"
              value={form.launchUrl}
              onChange={set("launchUrl")}
              required
            />
            <TextAreaField
              label="Redirect URIs"
              value={form.redirectUris}
              onChange={set("redirectUris")}
              hint="One per line."
            />
            <TextField
              label="Scopes"
              value={form.scopes}
              onChange={set("scopes")}
              hint="Space separated, as SMART writes them."
            />
            <SelectField
              label="Confidentiality"
              value={form.confidentiality}
              options={[
                { value: "public", label: "Public client" },
                { value: "confidential", label: "Confidential client" },
              ]}
              onChange={set("confidentiality")}
            />
            <TextField
              label="Launch context needed"
              value={form.launchContext}
              onChange={set("launchContext")}
              hint="What the server must supply at launch, in your own words."
            />
            <CheckField
              label="Token introspection required"
              checked={form.needsIntrospection}
              onChange={set("needsIntrospection")}
            />
          </>
        ) : null}

        {problem === undefined ? null : <ErrorAlert message={problem} />}
        <SubmitButton pending={action.isPending}>Save system</SubmitButton>
      </form>
      {action.error === null ? null : (
        <ErrorAlert message={describeError(action.error)} />
      )}
    </Panel>
  );
}
