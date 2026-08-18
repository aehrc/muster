import { eventSystemsSchema } from "@muster/contracts";
import {
  CalendarIcon,
  ChecklistIcon,
  OrganizationIcon,
  SearchIcon,
  TagIcon,
} from "@primer/octicons-react";
import { useMemo, useState } from "react";
import { Link, useParams } from "react-router";

import { useResource } from "../api/useResource.ts";
import { Contacts } from "../components/Contacts.tsx";
import { SelectField, TextField } from "../components/Fields.tsx";
import { OperationAlert } from "../components/OperationAlert.tsx";
import { SystemProfiles } from "../components/SystemProfiles.tsx";
import {
  emptyFilter,
  filterSystems,
  groupByKind,
  kindLabel,
  tagsOffered,
} from "../lib/directory.ts";
import { describeAge, formatDateRange } from "../lib/format.ts";

import type { SystemFilter } from "../lib/directory.ts";
import type { EnrolledSystem, EventDetail } from "@muster/contracts";
import type { JSX } from "react";

/**
 * The public event view: the participant table's replacement.
 *
 * Readable without an account, which is the point (SC-006): every system enrolled
 * in the event, grouped by kind and narrowable by capability tag or free text
 * (FR-010), with each entry's connection details in full and the age of its last
 * confirmation on the card - a table's worst failing was that nobody could tell
 * how old a row was.
 *
 * Contact details are the one thing that depends on the reader, and they are not
 * hidden by this page: an anonymous response does not carry them at all, and the
 * page says which it received.
 *
 * @author John Grimes
 */

/** The kinds the filter offers. */
const kindOptions = [
  { value: "all", label: "Servers and clients" },
  { value: "server", label: "Servers only" },
  { value: "client", label: "Clients only" },
];

/**
 * Renders one enrolled system.
 *
 * @param props - the entry and the event it is enrolled in
 * @returns the card
 */
function SystemCard({
  entry,
  event,
}: Readonly<{
  /** the enrolled system */
  entry: EnrolledSystem;
  /** the event it is enrolled in */
  event: EventDetail;
}>): JSX.Element {
  return (
    <article className="card border border-base-300 bg-base-100">
      <div className="card-body gap-3 p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex flex-col gap-1">
            <h3 className="card-title text-base">
              <Link
                to={`/events/${event.slug}/systems/${entry.system.id}`}
                className="link link-hover"
              >
                {entry.system.name}
              </Link>
            </h3>
            <p className="flex items-center gap-2 text-sm text-base-content/70">
              <OrganizationIcon size={14} />
              {entry.organisation.name}
            </p>
          </div>
          <span className="badge badge-soft badge-sm">
            {kindLabel(entry.system.kinds)}
          </span>
        </div>

        {entry.system.description === "" ? null : (
          <p className="text-sm">{entry.system.description}</p>
        )}

        {entry.tags.length === 0 ? null : (
          <ul className="flex flex-wrap gap-1">
            {entry.tags.map((tag) => (
              <li key={tag}>
                <span className="badge badge-outline badge-sm gap-1">
                  <TagIcon size={12} />
                  {tag}
                </span>
              </li>
            ))}
          </ul>
        )}

        <SystemProfiles system={entry.system} />

        <div className="flex flex-col gap-2 border-t border-base-300 pt-3">
          <Contacts entry={entry} />
          <p className="text-xs text-base-content/60">
            Details confirmed {describeAge(entry.confirmedAt, new Date())}.
          </p>
        </div>
      </div>
    </article>
  );
}

/**
 * The event view.
 *
 * @returns the screen
 * @author John Grimes
 */
export function EventView(): JSX.Element {
  const { slug } = useParams();
  const { data, operation } = useResource(
    slug === undefined ? null : `/api/events/${slug}/systems`,
    eventSystemsSchema,
    "Loading the event",
  );
  const [filter, setFilter] = useState<SystemFilter>(emptyFilter);

  const shown = useMemo(
    () => (data === null ? [] : filterSystems(data.systems, filter)),
    [data, filter],
  );
  const groups = useMemo(() => groupByKind(shown), [shown]);

  if (data === null) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-2xl font-bold sm:text-3xl">Event</h1>
        <OperationAlert operation={operation} />
      </div>
    );
  }

  const { event } = data;
  const tags = tagsOffered(event, data.systems);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold sm:text-3xl">{event.name}</h1>
          <span
            className={`badge badge-sm ${event.status === "open" ? "badge-success" : "badge-soft"}`}
          >
            {event.status}
          </span>
        </div>
        <p className="flex flex-wrap items-center gap-2 text-sm text-base-content/70">
          <CalendarIcon size={14} />
          {formatDateRange(event.startsOn, event.endsOn)}
          <span aria-hidden="true">-</span>
          <code className="font-mono text-xs">{event.slug}</code>
        </p>
        <p className="flex flex-wrap items-center gap-2 text-sm text-base-content/70">
          <ChecklistIcon size={14} />
          {data.systems.length === 1
            ? "1 system enrolled"
            : `${String(data.systems.length)} systems enrolled`}
          <span aria-hidden="true">-</span>
          showing {String(shown.length)}
        </p>
      </header>

      <OperationAlert operation={operation} />

      <section
        aria-label="Filters"
        className="flex flex-col gap-3 rounded-box border border-base-300 bg-base-200 p-4 sm:flex-row sm:items-end"
      >
        <div className="flex-1">
          <TextField
            label="Search"
            placeholder="Name, organisation, address or scope"
            value={filter.text}
            onChange={(text) => {
              setFilter({ ...filter, text });
            }}
          />
        </div>
        <div className="sm:w-56">
          <SelectField
            label="Kind"
            options={kindOptions}
            value={filter.kind}
            onChange={(kind) => {
              setFilter({
                ...filter,
                kind: kind === "server" || kind === "client" ? kind : "all",
              });
            }}
          />
        </div>
        <div className="sm:w-64">
          <SelectField
            label="Capability tag"
            options={[
              { value: "all", label: "Every tag" },
              ...tags.map((tag) => ({ value: tag, label: tag })),
            ]}
            value={filter.tag}
            onChange={(tag) => {
              setFilter({ ...filter, tag });
            }}
          />
        </div>
      </section>

      {shown.length === 0 ? (
        <p className="flex items-center gap-2 text-base-content/70">
          <SearchIcon size={16} />
          {data.systems.length === 0
            ? "Nothing is enrolled in this event yet."
            : "No enrolled system matches those filters."}
        </p>
      ) : null}

      {groups.map((group) => (
        <section
          key={group.kind}
          aria-label={group.label}
          className="flex flex-col gap-3"
        >
          {group.systems.length === 0 ? null : (
            <h2 className="text-xl font-semibold">
              {group.label}s{" "}
              <span className="text-base font-normal text-base-content/60">
                ({String(group.systems.length)})
              </span>
            </h2>
          )}
          <div className="flex flex-col gap-3">
            {group.systems.map((entry) => (
              <SystemCard key={entry.enrolmentId} entry={entry} event={event} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
