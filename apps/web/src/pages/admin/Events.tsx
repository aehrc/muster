/**
 * Admin: creating events, editing them, and opening and closing them.
 *
 * The wireframe's event list and edit panel. Persona curation is on the same screen in the
 * wireframe and arrives with the persona index; the space it will occupy is named rather than
 * mocked, so nobody mistakes an empty table for a broken one.
 *
 * Closing an event is here rather than being a separate verb, per `contracts/http-api.md`, and it
 * is one way: the transition is refused by the server, and the button disappears once it is taken.
 *
 * Author: John Grimes
 */

import { useState } from "react";
import { Link } from "react-router";

import { AdminOnly } from "./AdminOnly.js";
import { describeError } from "../../api/errors.js";
import { useEventAction, useEvents, useMe } from "../../api/queries.js";
import { SubmitButton, TextField } from "../../components/fields.js";
import {
  EmptyState,
  ErrorAlert,
  InfoAlert,
  Loading,
  PageHeader,
  Panel,
  Tag,
} from "../../components/layout.js";
import {
  addCapabilityTag,
  createEventRequest,
  EMPTY_EVENT_FORM,
  removeCapabilityTag,
} from "../../forms/eventForm.js";

import type { EventForm } from "../../forms/eventForm.js";
import type { EventSummary } from "@muster/contracts";

/** Every event, with the controls that create and change them. */
export function AdminEvents() {
  const me = useMe();
  const events = useEvents();
  const action = useEventAction();

  if (me.data?.account?.isAdmin !== true) {
    return <AdminOnly title="Events" />;
  }

  return (
    <article className="page-wide">
      <PageHeader
        title="Events"
        subtitle="An event starts as a draft, opens for enrolment, and closes. Closing keeps its records readable and takes nothing new."
      />

      {action.error === null ? null : (
        <ErrorAlert message={describeError(action.error)} />
      )}
      {action.isSuccess ? <InfoAlert>Event saved.</InfoAlert> : null}

      <Panel title="All events">
        {events.isPending ? <Loading label="Loading the events" /> : null}
        {events.data?.events.length === 0 ? (
          <EmptyState>No events yet.</EmptyState>
        ) : null}
        {(events.data?.events ?? []).map((event) => (
          <EventRow
            key={event.slug}
            event={event}
            onOpen={() => {
              action.mutate({
                kind: "edit",
                slug: event.slug,
                patch: { status: "open" },
              });
            }}
            onClose={() => {
              action.mutate({
                kind: "edit",
                slug: event.slug,
                patch: { status: "closed" },
              });
            }}
            pending={action.isPending}
          />
        ))}
      </Panel>

      <EventFormPanel />

      <Panel
        title="Personas"
        description="Curated from the event's configured source server. Arrives with the persona index."
      >
        <EmptyState>
          Persona curation is not built yet. The source server is set on the
          event above.
        </EmptyState>
      </Panel>
    </article>
  );
}

/** One event, with what can be done to it next. */
function EventRow({
  event,
  onOpen,
  onClose,
  pending,
}: Readonly<{
  readonly event: EventSummary;
  readonly onOpen: () => void;
  readonly onClose: () => void;
  readonly pending: boolean;
}>) {
  return (
    <div className="event-row">
      <div>
        <strong>
          <Link to={`/events/${event.slug}`}>{event.name}</Link>
        </strong>
        <Tag>{event.status}</Tag>
        <div className="quiet">
          {event.startsOn} to {event.endsOn} - {event.slug}
        </div>
      </div>
      <div className="page-actions">
        {event.status === "draft" ? (
          <button
            type="button"
            className="button button-primary"
            disabled={pending}
            onClick={onOpen}
          >
            Open for enrolment
          </button>
        ) : null}
        {event.status === "open" ? (
          <button
            type="button"
            className="button"
            disabled={pending}
            onClick={onClose}
          >
            Close event
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** The form that creates an event. */
function EventFormPanel() {
  const action = useEventAction();
  const [form, setForm] = useState<EventForm>(EMPTY_EVENT_FORM);
  const [candidate, setCandidate] = useState("");

  /** Updates one field. */
  const set =
    <K extends keyof EventForm>(field: K) =>
    (value: EventForm[K]) => {
      setForm({ ...form, [field]: value });
    };

  return (
    <Panel
      title="Create an event"
      description="Capability tags are defined per event: two events' tags are independent labels even when they read the same."
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          action.mutate(
            { kind: "create", event: createEventRequest(form) },
            {
              onSuccess: () => {
                setForm(EMPTY_EVENT_FORM);
              },
            },
          );
        }}
      >
        <TextField
          label="Slug"
          value={form.slug}
          onChange={set("slug")}
          placeholder="sparked-2026-09"
          hint="Every public address for the event is built from this, so it cannot be changed later."
          required
        />
        <TextField
          label="Name"
          value={form.name}
          onChange={set("name")}
          required
        />
        <div className="filter-bar">
          <TextField
            label="Start date"
            type="date"
            value={form.startsOn}
            onChange={set("startsOn")}
            required
          />
          <TextField
            label="End date"
            type="date"
            value={form.endsOn}
            onChange={set("endsOn")}
            required
          />
          <TextField
            label="Grace period (days)"
            type="number"
            value={form.graceDays}
            onChange={set("graceDays")}
            hint="How long a minted statement or ticket may outlive the event."
            required
          />
        </div>
        <TextField
          label="Persona source server"
          type="url"
          value={form.personaSourceUrl}
          onChange={set("personaSourceUrl")}
          placeholder="https://smile.sparked-fhir.com/aucore/fhir/DEFAULT"
        />

        <div className="field">
          <span className="field-label">Capability tags</span>
          <div className="chips">
            {form.capabilityTags.length === 0 ? (
              <span className="quiet">None yet.</span>
            ) : (
              form.capabilityTags.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  className="tag tag-on"
                  onClick={() => {
                    setForm({
                      ...form,
                      capabilityTags: removeCapabilityTag(
                        form.capabilityTags,
                        tag,
                      ),
                    });
                  }}
                >
                  {tag} &times;
                </button>
              ))
            )}
          </div>
          <div className="filter-bar">
            <TextField
              label="Add a capability tag"
              value={candidate}
              onChange={setCandidate}
              placeholder="smart-app-host"
            />
            <button
              type="button"
              className="button"
              onClick={() => {
                setForm({
                  ...form,
                  capabilityTags: addCapabilityTag(
                    form.capabilityTags,
                    candidate,
                  ),
                });
                setCandidate("");
              }}
            >
              Add tag
            </button>
          </div>
        </div>

        <SubmitButton pending={action.isPending}>Create event</SubmitButton>
      </form>
      <p className="note">
        Opening and closing an event is a decision of its own, above. The slug
        is fixed once created, because the links already handed out are built
        from it.
      </p>
    </Panel>
  );
}
