/**
 * The pairing list: everything the caller's organisations are party to.
 *
 * Members only, and the only page in the console that is - every read surface in Muster is public
 * except this one and the contacts feed, because a pairing is a negotiation between two named
 * organisations rather than part of the directory (constitution principle V).
 *
 * Both directions in one table, as the wireframe shows it, with the state and direction chips
 * filtering in place. Which side the caller holds and what they may do about it are computed by
 * the server from the pairing state machine, so this page holds no copy of who may answer what -
 * a row shows a Respond action when the server said there was one.
 *
 * Author: John Grimes
 */

import { useState } from "react";
import { Link } from "react-router";

import {
  countByState,
  describePairingState,
  filterPairings,
  NO_PAIRING_FILTER,
  outstandingCount,
  PAIRING_STATE_CHIPS,
} from "./pairingFilters.js";
import { describeError, isUnauthenticated } from "../api/errors.js";
import { useMe, usePairings } from "../api/queries.js";
import {
  EmptyState,
  ErrorAlert,
  InfoAlert,
  Loading,
  PageHeader,
  Panel,
  Tag,
  TagToggle,
} from "../components/layout.js";
import { pairingPath, ROUTES } from "../routes.js";

import type { PairingFilter } from "./pairingFilters.js";
import type { PairingSummary } from "@muster/contracts";

/** Every pairing the caller is party to, filtered by state and direction. */
export function Pairings() {
  const me = useMe();
  const listing = usePairings();
  const [filter, setFilter] = useState<PairingFilter>(NO_PAIRING_FILTER);

  if (me.data?.account == null) {
    return (
      <article className="page">
        <PageHeader title="Pairings" />
        <EmptyState>
          Pairings are visible to the organisations party to them.{" "}
          <Link to={ROUTES.signIn}>Sign in</Link> to see yours.
        </EmptyState>
      </article>
    );
  }
  if (listing.isPending) {
    return <Loading label="Loading your pairings" />;
  }
  if (listing.error !== null) {
    return (
      <ErrorAlert
        message={
          isUnauthenticated(listing.error)
            ? "Sign in to see your pairings."
            : describeError(listing.error)
        }
      />
    );
  }

  const { pairings } = listing.data;
  // Derived during render rather than synced by an effect: the chips are state, the table is a
  // calculation over them.
  const counts = countByState(pairings);
  const shown = filterPairings(pairings, filter);
  const waiting = outstandingCount(pairings);

  return (
    <article className="page-wide">
      <PageHeader
        title="Pairings"
        subtitle="Every registration your organisations are party to, in both directions."
      />

      {waiting === 0 ? (
        <p className="note">Nothing is waiting on you.</p>
      ) : (
        <InfoAlert>
          {waiting === 1
            ? "One pairing is waiting for your answer."
            : `${String(waiting)} pairings are waiting for your answer.`}
        </InfoAlert>
      )}

      <Panel
        title="Filter"
        description="Chips filter the table in place; the counts move as pairings change state."
      >
        <div className="chips">
          {PAIRING_STATE_CHIPS.map((state) => (
            <TagToggle
              key={state}
              label={
                state === "all"
                  ? `All ${String(pairings.length)}`
                  : `${describePairingState(state)} ${String(counts[state])}`
              }
              pressed={filter.state === state}
              onToggle={() => {
                setFilter({ ...filter, state });
              }}
            />
          ))}
        </div>
        <div className="chips">
          <span className="quiet">Direction</span>
          {(
            [
              ["all", "Either side"],
              ["client", "As app owner"],
              ["server", "As server owner"],
            ] as const
          ).map(([direction, label]) => (
            <TagToggle
              key={direction}
              label={label}
              pressed={filter.direction === direction}
              onToggle={() => {
                setFilter({ ...filter, direction });
              }}
            />
          ))}
        </div>
      </Panel>

      <Panel title="Pairings">
        {shown.length === 0 ? (
          <EmptyState>
            {pairings.length === 0
              ? "No pairings yet. Request one from an enrolled server's page on the event view."
              : "No pairing matches the filter."}
          </EmptyState>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Client</th>
                <th>Server</th>
                <th>Event</th>
                <th>State</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((pairing) => (
                <PairingRow key={pairing.id} pairing={pairing} />
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </article>
  );
}

/** One row: the two systems, the event, where it has got to, and what to do about it. */
function PairingRow({
  pairing,
}: Readonly<{ readonly pairing: PairingSummary }>) {
  return (
    <tr>
      <td>
        <Link to={pairingPath(pairing.id)}>{pairing.client.name}</Link>
        <div className="quiet">{pairing.client.organisation.name}</div>
      </td>
      <td>
        {pairing.server.name}
        <div className="quiet">{pairing.server.organisation.name}</div>
      </td>
      <td>{pairing.event.name}</td>
      <td>
        <Tag>{describePairingState(pairing.state)}</Tag>
        {pairing.clientId === null ? null : (
          <div className="wrap">client_id {pairing.clientId}</div>
        )}
        {pairing.declineReason === null ? null : (
          <div className="quiet">{pairing.declineReason}</div>
        )}
        {pairing.actions.length === 0 ? null : (
          <div>
            <Link className="button" to={pairingPath(pairing.id)}>
              Respond
            </Link>
          </div>
        )}
      </td>
      <td className="wrap">{pairing.updatedAt}</td>
    </tr>
  );
}
