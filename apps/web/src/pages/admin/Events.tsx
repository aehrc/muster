/*
 * Copyright © 2026 Commonwealth Scientific and Industrial Research Organisation
 * (CSIRO) ABN 41 687 119 230. Licensed under the Apache License, Version 2.0.
 */

import {
  eventResponseSchema,
  eventsResponseSchema,
  eventStatusSchema,
} from "@muster/contracts";
import {
  CalendarIcon,
  PencilIcon,
  PeopleIcon,
  PlusIcon,
} from "@primer/octicons-react";
import { useState } from "react";
import { Link } from "react-router";

import { muster } from "../../api/muster.ts";
import { useResource } from "../../api/useResource.ts";
import {
  SelectField,
  TextAreaField,
  TextField,
} from "../../components/Fields.tsx";
import { IssueList } from "../../components/IssueList.tsx";
import { OperationAlert } from "../../components/OperationAlert.tsx";
import { Panel } from "../../components/Panel.tsx";
import { PersonaCuration } from "../../components/PersonaCuration.tsx";
import { StandingNotice } from "../../components/StandingNotice.tsx";
import { standingFor } from "../../lib/account.ts";
import {
  buildEventPatch,
  buildEventRequest,
  emptyEventForm,
  eventFormFrom,
} from "../../lib/eventForm.ts";
import { formatDateRange } from "../../lib/format.ts";
import { busy, failed, idle, pending, succeeded } from "../../lib/operation.ts";
import { useSession } from "../../session/sessionContext.ts";

import type { EventFormValues } from "../../lib/eventForm.ts";
import type { Operation } from "../../lib/operation.ts";
import type { JSX } from "react";

/**
 * Event administration: creating events, and opening and closing them.
 *
 * An event's capability tags are defined here and nowhere else (FR-008): they are
 * the vocabulary an enrolment may claim from, so an event with no tags is an event
 * whose entries cannot be grouped by anything.
 *
 * Status is the switch FR-011 turns on. A draft event takes nothing, an open one
 * takes enrolments, and closing one keeps its records readable while refusing
 * anything new.
 *
 * @author John Grimes
 */

/** The statuses an event can be given. */
const statusOptions = [
  { value: "draft", label: "Draft (takes nothing yet)" },
  { value: "open", label: "Open (takes enrolments)" },
  { value: "closed", label: "Closed (readable, takes nothing new)" },
];

/** Which event's form is open, and with what values. */
type Editing = {
  /** the slug being edited, or null for a new event */
  readonly slug: string | null;
  /** the values in the form */
  readonly values: EventFormValues;
};

/**
 * Renders the event form's fields.
 *
 * @param props - the values, whether the slug may be set, and how to change them
 * @returns the fields
 */
function EventFields({
  values,
  withSlug,
  onChange,
}: Readonly<{
  /** the current values */
  values: EventFormValues;
  /** whether the slug is being chosen, which only happens at creation */
  withSlug: boolean;
  /** called with the values after a change */
  onChange: (values: EventFormValues) => void;
}>): JSX.Element {
  const change = <Field extends keyof EventFormValues>(
    field: Field,
    value: EventFormValues[Field],
  ): void => {
    onChange({ ...values, [field]: value });
  };

  return (
    <div className="flex flex-col gap-3">
      {withSlug ? (
        <TextField
          label="Slug"
          hint="Lower case, digits and hyphens. Every public URL for the event derives from it, and it cannot be changed later."
          placeholder="sparked-2026-09"
          value={values.slug}
          onChange={(value) => {
            change("slug", value);
          }}
        />
      ) : null}
      <TextField
        label="Name"
        value={values.name}
        onChange={(value) => {
          change("name", value);
        }}
      />
      <div className="flex flex-col gap-3 sm:flex-row">
        <div className="flex-1">
          <TextField
            label="First day"
            type="date"
            value={values.startsOn}
            onChange={(value) => {
              change("startsOn", value);
            }}
          />
        </div>
        <div className="flex-1">
          <TextField
            label="Last day"
            type="date"
            value={values.endsOn}
            onChange={(value) => {
              change("endsOn", value);
            }}
          />
        </div>
      </div>
      <SelectField
        label="Status"
        options={statusOptions}
        value={values.status}
        onChange={(value) => {
          change("status", eventStatusSchema.parse(value));
        }}
      />
      <TextAreaField
        label="Capability tags"
        hint="One per line. These are the only tags an enrolment in this event may claim."
        value={values.capabilityTags}
        onChange={(value) => {
          change("capabilityTags", value);
        }}
      />
      <TextField
        label="Persona source"
        type="url"
        hint="The FHIR server event personas are curated from. Leave empty for none."
        value={values.personaSourceUrl}
        onChange={(value) => {
          change("personaSourceUrl", value);
        }}
      />
      <TextField
        label="Grace days"
        type="number"
        hint="How many days past the last day a minted artefact may stay valid."
        value={values.graceDays}
        onChange={(value) => {
          change("graceDays", value);
        }}
      />
    </div>
  );
}

/**
 * The admin events screen.
 *
 * @returns the screen
 * @author John Grimes
 */
export function Events(): JSX.Element {
  const { session, operation: sessionOperation } = useSession();
  const {
    data,
    operation: loading,
    reload,
  } = useResource("/api/events", eventsResponseSchema, "Loading the events");
  const [form, setForm] = useState<Editing | null>(null);
  // Curation is its own panel rather than part of the event form: the set is
  // curated far more often than the dates are edited.
  const [curating, setCurating] = useState<string | null>(null);
  const [issues, setIssues] = useState<readonly string[]>([]);
  const [operation, setOperation] = useState<Operation>(idle);

  const standing = standingFor(session);

  const handleSubmit = async (): Promise<void> => {
    if (form === null) {
      return;
    }
    const creating = form.slug === null;
    const outcome = creating
      ? buildEventRequest(form.values)
      : buildEventPatch(form.values);
    setIssues(outcome.ok ? [] : outcome.issues);
    if (!outcome.ok) {
      return;
    }
    const what = creating ? "Creating the event" : "Saving the event";
    setOperation(pending(what));
    const result = creating
      ? await muster.post(
          "/api/admin/events",
          outcome.value,
          eventResponseSchema,
        )
      : await muster.patch(
          `/api/admin/events/${String(form.slug)}`,
          outcome.value,
          eventResponseSchema,
        );
    if (result.ok) {
      setForm(null);
      setOperation(
        succeeded(
          what,
          `${result.data.event.name} is ${result.data.event.status}, with ${String(result.data.event.capabilityTags.length)} capability tag(s).`,
        ),
      );
      reload();
      return;
    }
    setOperation(failed(what, result.failure));
  };

  if (!standing.canAdminister) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-2xl font-bold sm:text-3xl">Events</h1>
        <OperationAlert operation={sessionOperation} />
        <StandingNotice standing={standing} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-bold sm:text-3xl">Events</h1>
      <OperationAlert operation={loading} />
      <OperationAlert operation={operation} />

      <Panel
        title="Events"
        icon={<CalendarIcon size={18} />}
        description="An event's capability tags are the vocabulary its enrolments may claim from."
      >
        <ul className="flex flex-col gap-3">
          {(data?.events ?? []).map((event) => (
            <li
              key={event.slug}
              className="flex flex-col gap-3 rounded-box border border-base-300 bg-base-100 p-3"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="flex flex-col gap-1">
                  <h3 className="font-semibold">
                    <Link
                      to={`/events/${event.slug}`}
                      className="link link-hover"
                    >
                      {event.name}
                    </Link>
                  </h3>
                  <p className="text-sm text-base-content/70">
                    {formatDateRange(event.startsOn, event.endsOn)}
                  </p>
                  <code className="font-mono text-xs text-base-content/60">
                    {event.slug}
                  </code>
                </div>
                <div className="flex items-center gap-2">
                  <span
                    className={`badge badge-sm ${event.status === "open" ? "badge-success" : "badge-soft"}`}
                  >
                    {event.status}
                  </span>
                  <button
                    type="button"
                    className="btn btn-ghost btn-xs"
                    onClick={() => {
                      setCurating(curating === event.slug ? null : event.slug);
                    }}
                  >
                    <PeopleIcon size={14} />
                    {curating === event.slug ? "Hide personas" : "Personas"}
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-xs"
                    onClick={() => {
                      setIssues([]);
                      setOperation(idle);
                      if (form?.slug === event.slug) {
                        setForm(null);
                        return;
                      }
                      void muster
                        .get(`/api/events/${event.slug}`, eventResponseSchema)
                        .then((result) => {
                          if (result.ok) {
                            setForm({
                              slug: event.slug,
                              values: eventFormFrom(result.data.event),
                            });
                            return;
                          }
                          setOperation(
                            failed("Loading the event", result.failure),
                          );
                        });
                    }}
                  >
                    <PencilIcon size={14} />
                    {form?.slug === event.slug ? "Cancel" : "Edit"}
                  </button>
                </div>
              </div>

              {form?.slug === event.slug ? (
                <form
                  className="flex flex-col gap-3"
                  onSubmit={(submitted) => {
                    submitted.preventDefault();
                    void handleSubmit();
                  }}
                >
                  <EventFields
                    values={form.values}
                    withSlug={false}
                    onChange={(values) => {
                      setForm({ slug: event.slug, values });
                    }}
                  />
                  <IssueList issues={issues} />
                  <button
                    type="submit"
                    className="btn btn-primary btn-sm self-start"
                    disabled={busy(operation)}
                  >
                    Save changes
                  </button>
                </form>
              ) : null}

              {curating === event.slug ? (
                <PersonaCuration event={event} />
              ) : null}
            </li>
          ))}
          {data !== null && data.events.length === 0 ? (
            <li className="text-sm text-base-content/70">
              No event exists yet.
            </li>
          ) : null}
        </ul>
      </Panel>

      {form?.slug === null ? (
        <Panel title="A new event" icon={<PlusIcon size={18} />}>
          <form
            className="flex flex-col gap-3"
            onSubmit={(submitted) => {
              submitted.preventDefault();
              void handleSubmit();
            }}
          >
            <EventFields
              values={form.values}
              withSlug
              onChange={(values) => {
                setForm({ slug: null, values });
              }}
            />
            <IssueList issues={issues} />
            <div className="flex gap-2">
              <button
                type="submit"
                className="btn btn-primary btn-sm"
                disabled={busy(operation)}
              >
                Create the event
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => {
                  setForm(null);
                }}
              >
                Cancel
              </button>
            </div>
          </form>
        </Panel>
      ) : (
        <button
          type="button"
          className="btn btn-sm self-start"
          onClick={() => {
            setIssues([]);
            setOperation(idle);
            setForm({ slug: null, values: emptyEventForm });
          }}
        >
          <PlusIcon size={16} />
          Create an event
        </button>
      )}
    </div>
  );
}
