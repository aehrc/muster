import { eventSystemSchema } from "@muster/contracts";
import {
  ArrowLeftIcon,
  CalendarIcon,
  OrganizationIcon,
  PersonIcon,
  TagIcon,
} from "@primer/octicons-react";
import { Link, useParams } from "react-router";

import { useResource } from "../api/useResource.ts";
import { Contacts } from "../components/Contacts.tsx";
import { OperationAlert } from "../components/OperationAlert.tsx";
import { Panel } from "../components/Panel.tsx";
import { SystemProfiles } from "../components/SystemProfiles.tsx";
import { kindLabel } from "../lib/directory.ts";
import { describeAge, formatDateRange } from "../lib/format.ts";

import type { JSX } from "react";

/**
 * One enrolled system, in full.
 *
 * The public counterpart to the event view's card: the same record, with room for
 * everything rather than a summary, and the same contact gating (FR-007). A system
 * that is not enrolled in the event is not found in the event, whatever else is
 * true of it, and the page reports that as the refusal the server gave rather than
 * as an empty screen.
 *
 * @author John Grimes
 */

/**
 * The system detail screen.
 *
 * @returns the screen
 * @author John Grimes
 */
export function SystemDetail(): JSX.Element {
  const { slug, systemId } = useParams();
  const { data, operation } = useResource(
    slug === undefined || systemId === undefined
      ? null
      : `/api/events/${slug}/systems/${systemId}`,
    eventSystemSchema,
    "Loading the system",
  );

  if (data === null) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-2xl font-bold sm:text-3xl">System</h1>
        <OperationAlert operation={operation} />
        {slug === undefined ? null : (
          <Link to={`/events/${slug}`} className="btn btn-sm self-start">
            <ArrowLeftIcon size={16} />
            Back to the event
          </Link>
        )}
      </div>
    );
  }

  const { event, system: entry } = data;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link to={`/events/${event.slug}`} className="btn btn-ghost btn-sm">
          <ArrowLeftIcon size={16} />
          {event.name}
        </Link>
      </div>

      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold sm:text-3xl">
            {entry.system.name}
          </h1>
          <span className="badge badge-soft badge-sm">
            {kindLabel(entry.system.kinds)}
          </span>
        </div>
        <p className="flex flex-wrap items-center gap-2 text-sm text-base-content/70">
          <OrganizationIcon size={14} />
          {entry.organisation.name}
          <span aria-hidden="true">-</span>
          <CalendarIcon size={14} />
          enrolled in {event.name},{" "}
          {formatDateRange(event.startsOn, event.endsOn)}
        </p>
        {entry.system.description === "" ? null : (
          <p className="max-w-2xl">{entry.system.description}</p>
        )}
      </header>

      <OperationAlert operation={operation} />

      <Panel
        title="Capability tags"
        icon={<TagIcon size={18} />}
        description="Chosen from the event's own set when the system was enrolled."
      >
        {entry.tags.length === 0 ? (
          <p className="text-sm text-base-content/70">
            This enrolment carries no capability tags.
          </p>
        ) : (
          <ul className="flex flex-wrap gap-1">
            {entry.tags.map((tag) => (
              <li key={tag}>
                <span className="badge badge-outline badge-sm">{tag}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-base-content/60">
          Details confirmed {describeAge(entry.confirmedAt, new Date())}, by a
          member of {entry.organisation.name}.
        </p>
      </Panel>

      <Panel title="Connection details">
        <SystemProfiles system={entry.system} />
      </Panel>

      <Panel title="Contacts" icon={<PersonIcon size={18} />}>
        <Contacts entry={entry} />
      </Panel>
    </div>
  );
}
