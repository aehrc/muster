/**
 * Admin: creating events, editing them, opening and closing them, and curating personas.
 *
 * The wireframe's event list, edit panel and persona table, on one screen.
 *
 * Closing an event is here rather than being a separate verb, per `contracts/http-api.md`, and it
 * is one way: the transition is refused by the server, and the button disappears once it is taken.
 *
 * The persona table reads the *public* personas route rather than an admin-only one. That is the
 * constitution's rule about view-only data paths, and it has a second benefit: the flag an admin
 * comes to this page for - a persona the source server no longer holds - is the same field a
 * participant reads on the public page, so the two cannot disagree about it (FR-032).
 *
 * A search puts a request on somebody else's server, so it happens when the admin asks for it and
 * never because the panel was rendered. Its results carry the patients that *cannot* be curated
 * as well as the ones that can, each with the reason - which is what scenario 2 requires and what
 * a filtered list would quietly lose.
 *
 * Author: John Grimes
 */

import { useState } from "react";
import { Link } from "react-router";

import { AdminOnly } from "./AdminOnly.js";
import { describeError } from "../../api/errors.js";
import {
  useAddPersona,
  useEventAction,
  useEvents,
  useMe,
  usePersonas,
  usePersonaSearch,
} from "../../api/queries.js";
import { EventPicker } from "../../components/eventPicker.js";
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
import { describeSourceStatus, openEventSlug } from "../personaGrid.js";

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
      {action.isSuccess ? (
        <InfoAlert>
          Event saved.
          {action.data === undefined || action.data.lapsedPairings === 0
            ? ""
            : ` ${String(action.data.lapsedPairings)} open pairing${action.data.lapsedPairings === 1 ? "" : "s"} lapsed, and both organisations were emailed.`}
        </InfoAlert>
      ) : null}

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

      <PersonasPanel events={events.data?.events ?? []} />
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

/**
 * Curating one event's personas from its configured source server (FR-031).
 *
 * The event is chosen here rather than inherited from an edit form, because curation and
 * editing are separate jobs an admin does at different times.
 */
function PersonasPanel({
  events,
}: Readonly<{ readonly events: readonly EventSummary[] }>) {
  const [slug, setSlug] = useState<string | undefined>();
  const chosen = openEventSlug(events, slug) ?? "";
  const personas = usePersonas(chosen);

  return (
    <Panel
      title="Personas"
      description="The event's shared test patients, curated from the FHIR server set as its persona source. Only patients carrying an IHI are eligible."
      actions={
        <EventPicker events={events} chosen={chosen} onChoose={setSlug} />
      }
    >
      {events.length === 0 ? (
        <EmptyState>Create an event before curating personas.</EmptyState>
      ) : null}
      {personas.isPending && chosen.length > 0 ? (
        <Loading label="Loading the personas" />
      ) : null}
      {personas.error === null ? null : (
        <ErrorAlert message={describeError(personas.error)} />
      )}
      {personas.data === undefined ? null : (
        <>
          {personas.data.event.personaSourceUrl === null ? (
            <ErrorAlert message="This event names no persona source server, so there is nothing to search. Set one when you create the event." />
          ) : null}
          {personas.data.personas.length === 0 ? (
            <EmptyState>No personas curated for this event yet.</EmptyState>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>IHI</th>
                  <th>Source status</th>
                </tr>
              </thead>
              <tbody>
                {personas.data.personas.map((persona) => {
                  const source = describeSourceStatus(persona.sourceStatus);
                  return (
                    <tr key={persona.id}>
                      <td>
                        {persona.canonicalUrl === null ? (
                          persona.display.name
                        ) : (
                          <a
                            href={persona.canonicalUrl}
                            rel="noreferrer"
                            target="_blank"
                          >
                            {persona.display.name}
                          </a>
                        )}
                        <div className="quiet">
                          {persona.display.birthDate ?? "no date of birth"}
                        </div>
                      </td>
                      <td>
                        <code>{persona.ihi}</code>
                      </td>
                      <td className={source.flagged ? "check-bad" : undefined}>
                        {source.text}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          <PersonaSearchPanel slug={chosen} />
        </>
      )}
    </Panel>
  );
}

/**
 * Searching the source server, and adding what it found.
 *
 * The search is submitted rather than typed-into-live: each one is a request to a
 * participant's FHIR server, and a search-as-you-type box would send one per keystroke.
 */
function PersonaSearchPanel({ slug }: Readonly<{ readonly slug: string }>) {
  const [typed, setTyped] = useState("");
  const [asked, setAsked] = useState("");
  const results = usePersonaSearch(slug, asked, asked.length > 0);
  const add = useAddPersona(slug);

  return (
    <div className="persona-search">
      <form
        className="filter-bar"
        onSubmit={(submitted) => {
          submitted.preventDefault();
          setAsked(typed.trim());
        }}
      >
        <TextField
          label="Search the source server"
          value={typed}
          onChange={setTyped}
          placeholder="Morris"
          hint="Searches the event's persona source by patient name. Only patients carrying an IHI can be added; the rest are listed with the reason."
        />
        <SubmitButton pending={results.isFetching && asked.length > 0}>
          Search
        </SubmitButton>
      </form>

      {results.error === null ? null : (
        <ErrorAlert message={describeError(results.error)} />
      )}
      {add.error === null ? null : (
        <ErrorAlert message={describeError(add.error)} />
      )}
      {add.isSuccess && add.data !== undefined ? (
        <InfoAlert>
          {add.data.persona.display.name} added as a persona.
        </InfoAlert>
      ) : null}

      {results.data === undefined ? null : (
        <>
          {results.data.candidates.length === 0 &&
          results.data.ineligible.length === 0 ? (
            <EmptyState>
              The source server matched no patients for that search.
            </EmptyState>
          ) : null}
          {results.data.candidates.map((candidate) => (
            <div className="event-row" key={candidate.patientId}>
              <div>
                <strong>{candidate.display.name}</strong>
                <div className="quiet">
                  {candidate.display.birthDate ?? "no date of birth"} - IHI{" "}
                  <code>{candidate.ihi}</code>
                </div>
              </div>
              <div className="page-actions">
                <button
                  type="button"
                  className="button button-primary"
                  disabled={add.isPending}
                  onClick={() => {
                    add.mutate(candidate.patientId);
                  }}
                >
                  Add persona
                </button>
              </div>
            </div>
          ))}
          {results.data.ineligible.map((refused) => (
            <div
              className="event-row"
              key={refused.patientId ?? refused.display.name}
            >
              <div>
                <strong>{refused.display.name}</strong>
                {/* Scenario 2: the reason is stated, not left to be guessed at. */}
                <div className="state state-error" role="status">
                  {refused.detail}
                </div>
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
