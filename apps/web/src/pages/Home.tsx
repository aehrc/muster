import { eventsResponseSchema } from "@muster/contracts";
import {
  CalendarIcon,
  PlugIcon,
  PulseIcon,
  ServerIcon,
} from "@primer/octicons-react";
import { Link } from "react-router";

import { useResource } from "../api/useResource.ts";
import { OperationAlert } from "../components/OperationAlert.tsx";
import { Panel } from "../components/Panel.tsx";
import { formatDateRange } from "../lib/format.ts";

import type { JSX } from "react";

/**
 * The public landing page: what Muster is, and the events to browse.
 *
 * The list of events is the way in to everything readable without an account, so
 * it is on the landing page rather than behind a menu, and it reports its own
 * state while it loads or when it is refused (FR-037).
 *
 * @author John Grimes
 */

/** What reading the events is called in its messages. */
const what = "Loading the events";

/**
 * The events on offer.
 *
 * @returns the panel listing them
 */
function Events(): JSX.Element {
  const { data, operation } = useResource(
    "/api/events",
    eventsResponseSchema,
    what,
  );

  return (
    <Panel
      title="Events"
      icon={<CalendarIcon size={18} />}
      description="Each event's view lists the systems enrolled in it, readable without an account."
    >
      <OperationAlert operation={operation} />
      {data === null ? null : data.events.length === 0 ? (
        <p className="text-sm text-base-content/70">
          No events yet. A track admin creates them.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {data.events.map((event) => (
            <li
              key={event.slug}
              className="flex flex-wrap items-center justify-between gap-2 rounded-box border border-base-300 bg-base-100 p-3"
            >
              <div className="flex flex-col">
                <Link
                  to={`/events/${event.slug}`}
                  className="link link-hover font-medium"
                >
                  {event.name}
                </Link>
                <span className="text-sm text-base-content/70">
                  {formatDateRange(event.startsOn, event.endsOn)}
                </span>
              </div>
              <span
                className={`badge badge-sm ${event.status === "open" ? "badge-success" : "badge-soft"}`}
              >
                {event.status}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/**
 * The landing page.
 *
 * @returns the landing page
 * @author John Grimes
 */
export function Home(): JSX.Element {
  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-4">
        <h1 className="text-3xl font-bold sm:text-4xl">
          The connectathon participant directory
        </h1>
        <p className="max-w-2xl text-base-content/80">
          Muster replaces the participant table. Organisations describe their
          systems once, enrol them into each event, and connect an app to a
          server without an email round trip.
        </p>
      </section>

      <Events />

      <section className="flex flex-col gap-4 sm:flex-row">
        <article className="card flex-1 bg-base-200">
          <div className="card-body gap-2">
            <h2 className="card-title text-lg">
              <ServerIcon size={20} />A standing registry
            </h2>
            <p className="text-sm text-base-content/80">
              Systems are servers, clients, or both, described with the fields a
              pairing actually needs. Enrolment carries a fresh confirmation
              that the details are current.
            </p>
          </div>
        </article>

        <article className="card flex-1 bg-base-200">
          <div className="card-body gap-2">
            <h2 className="card-title text-lg">
              <PlugIcon size={20} />
              Pairings, tracked
            </h2>
            <p className="text-sm text-base-content/80">
              A pairing request moves through explicit states, and both
              organisations see the same timeline. Servers that accept a signed
              software statement need no human at all.
            </p>
          </div>
        </article>

        <article className="card flex-1 bg-base-200">
          <div className="card-body gap-2">
            <h2 className="card-title text-lg">
              <PulseIcon size={20} />
              Checked, not assumed
            </h2>
            <p className="text-sm text-base-content/80">
              Enrolled servers are fetched on a schedule, and the directory
              shows what each one actually advertises, when it was last
              reachable, and where that drifts from what was declared.
            </p>
          </div>
        </article>
      </section>
    </div>
  );
}
