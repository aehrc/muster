/**
 * The list of events.
 *
 * The way in to the event view, for a reader who arrived at Muster rather than at a link. Public:
 * no account, no sign-in prompt.
 *
 * Author: John Grimes
 */

import { Link } from "react-router";

import { describeError } from "../api/errors.js";
import { useEvents } from "../api/queries.js";
import { StatusLabel } from "../components/icons.js";
import {
  EmptyState,
  ErrorAlert,
  Loading,
  PageHeader,
} from "../components/layout.js";
import { EVENT_STATUS_STATES } from "../components/statusStates.js";

/** Every event, the one starting soonest first. */
export function Events() {
  const events = useEvents();

  if (events.isPending) {
    return <Loading label="Loading the events" />;
  }
  if (events.error !== null) {
    return <ErrorAlert message={describeError(events.error)} />;
  }

  return (
    <article className="flex flex-col">
      <PageHeader
        title="Events"
        subtitle="Every connectathon Muster holds a directory for. Open one to see the systems enrolled in it."
      />

      {events.data.events.length === 0 ? (
        <EmptyState>
          No events yet. A track admin creates the first one.
        </EmptyState>
      ) : (
        // Its own scroller, so three columns of dates never widen the page itself.
        <div className="overflow-x-auto">
          <table className="table table-zebra">
            <thead>
              <tr>
                <th>Event</th>
                <th>Dates</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {events.data.events.map((event) => (
                <tr key={event.slug}>
                  <td>
                    <Link className="link" to={`/events/${event.slug}`}>
                      {event.name}
                    </Link>
                  </td>
                  <td>
                    {event.startsOn} to {event.endsOn}
                  </td>
                  <td>
                    <StatusLabel state={EVENT_STATUS_STATES[event.status]}>
                      {event.status}
                    </StatusLabel>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </article>
  );
}
