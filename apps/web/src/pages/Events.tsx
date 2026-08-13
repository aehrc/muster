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
import {
  EmptyState,
  ErrorAlert,
  Loading,
  PageHeader,
  Tag,
} from "../components/layout.js";

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
    <article className="page-wide">
      <PageHeader
        title="Events"
        subtitle="Every connectathon Muster holds a directory for. Open one to see the systems enrolled in it."
      />

      {events.data.events.length === 0 ? (
        <EmptyState>
          No events yet. A track admin creates the first one.
        </EmptyState>
      ) : (
        <table className="table">
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
                  <Link to={`/events/${event.slug}`}>{event.name}</Link>
                </td>
                <td>
                  {event.startsOn} to {event.endsOn}
                </td>
                <td>
                  <Tag>{event.status}</Tag>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </article>
  );
}
