/*
 * Copyright © 2026 Commonwealth Scientific and Industrial Research Organisation
 * (CSIRO) ABN 41 687 119 230. Licensed under the Apache License, Version 2.0.
 */

import { personasResponseSchema } from "@muster/contracts";
import {
  AlertIcon,
  ArrowLeftIcon,
  CalendarIcon,
  LinkExternalIcon,
  OrganizationIcon,
  PeopleIcon,
  ServerIcon,
} from "@primer/octicons-react";
import { useMemo } from "react";
import { Link, useParams } from "react-router";

import { useResource } from "../api/useResource.ts";
import { OperationAlert } from "../components/OperationAlert.tsx";
import { Panel } from "../components/Panel.tsx";
import { describeAge } from "../lib/format.ts";
import {
  coverageClass,
  coverageMeaning,
  coverageRows,
  coverageSentence,
  coverageWords,
  describePersona,
  sourceNotice,
} from "../lib/personas.ts";

import type {
  CoverageCell,
  CoverageRow,
  CoverageState,
} from "../lib/personas.ts";
import type { EnrolledSystem, EventDetail } from "@muster/contracts";
import type { JSX } from "react";

/**
 * The event's shared personas, and the coverage grid over its enrolled servers.
 *
 * Public, and deliberately so: these are test patients on a test server, and a
 * page about published fiction that needed a sign-in would be theatre (SC-006).
 *
 * The grid is what the page is for. Three things about it are deliberate. Every
 * pair has a cell, including the pairs nothing has checked, because a gap and a
 * "not found" mean opposite things to a server owner about to seed data. Each cell
 * carries its check time, so a reader knows how old the answer is. And
 * `unverifiable` is not coloured as a failure: a server that requires
 * authorization is behaving correctly, and Muster refuses to guess on its behalf
 * (FR-032).
 *
 * The legend is on the page rather than in a tooltip. A three-valued grid that
 * does not say what its values mean is a puzzle.
 *
 * @author John Grimes
 */

/** The states the legend explains, in the order it explains them. */
const legendStates: readonly CoverageState[] = [
  "found",
  "missing",
  "unverifiable",
  "unchecked",
];

/**
 * Renders one cell of the grid.
 *
 * @param props - the cell to render
 * @returns the cell
 */
function CoverageBadge({
  cell,
}: Readonly<{
  /** the cell to render */
  cell: CoverageCell;
}>): JSX.Element {
  return (
    <div className="flex flex-col items-start gap-1">
      <span
        className={`badge badge-sm ${coverageClass[cell.state]}`}
        title={cell.detail}
      >
        {coverageWords[cell.state]}
      </span>
      <span className="text-xs text-base-content/60">
        {cell.checkedAt === null
          ? "no check yet"
          : describeAge(cell.checkedAt, new Date())}
      </span>
    </div>
  );
}

/**
 * Renders one persona's card.
 *
 * @param props - the persona and its coverage row
 * @returns the card
 */
function PersonaCard({
  row,
}: Readonly<{
  /** the persona and its cells */
  row: CoverageRow;
}>): JSX.Element {
  const { persona } = row;
  const notice = sourceNotice(persona);
  return (
    <article className="card border border-base-300 bg-base-100">
      <div className="card-body gap-2 p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <h3 className="card-title text-base">{persona.display.name}</h3>
          {notice === null ? (
            <span className="badge badge-soft badge-sm">at source</span>
          ) : (
            <span className="badge badge-sm badge-error gap-1">
              <AlertIcon size={12} />
              missing at source
            </span>
          )}
        </div>
        <p className="text-sm text-base-content/70">
          {describePersona(persona)}
        </p>
        <p className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-base-content/70">IHI</span>
          <code className="font-mono">{persona.ihi}</code>
        </p>
        <p className="text-sm">{coverageSentence(row)}</p>
        {notice === null ? null : (
          <p className="text-sm text-error">{notice}</p>
        )}
        <p className="text-xs text-base-content/60">
          {persona.sourceCheckedAt === null
            ? "The source has not been re-read since this persona was added."
            : `Source last read ${describeAge(persona.sourceCheckedAt, new Date())}.`}
        </p>
        <a
          className="link link-hover flex items-center gap-1 text-sm"
          href={persona.sourceUrl}
          target="_blank"
          rel="noreferrer"
        >
          <LinkExternalIcon size={14} />
          The canonical record
        </a>
      </div>
    </article>
  );
}

/**
 * Renders the grid's column heading for one server.
 *
 * @param props - the enrolled server and the event it is in
 * @returns the heading cell
 */
function ServerHeading({
  entry,
  event,
}: Readonly<{
  /** the enrolled server */
  entry: EnrolledSystem;
  /** the event it is enrolled in */
  event: EventDetail;
}>): JSX.Element {
  return (
    <th scope="col" className="align-bottom">
      <div className="flex flex-col gap-1">
        <Link
          to={`/events/${event.slug}/systems/${entry.system.id}`}
          className="link link-hover"
        >
          {entry.system.name}
        </Link>
        <span className="flex items-center gap-1 text-xs font-normal text-base-content/60">
          <OrganizationIcon size={12} />
          {entry.organisation.name}
        </span>
      </div>
    </th>
  );
}

/**
 * The personas page.
 *
 * @returns the screen
 * @author John Grimes
 */
export function Personas(): JSX.Element {
  const { slug } = useParams();
  const { data, operation } = useResource(
    slug === undefined ? null : `/api/events/${slug}/personas`,
    personasResponseSchema,
    "Loading the personas",
  );

  const rows = useMemo(() => (data === null ? [] : coverageRows(data)), [data]);

  if (data === null) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-2xl font-bold sm:text-3xl">Personas</h1>
        <OperationAlert operation={operation} />
      </div>
    );
  }

  const { event } = data;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <Link
          to={`/events/${event.slug}`}
          className="link link-hover flex w-fit items-center gap-1 text-sm"
        >
          <ArrowLeftIcon size={14} />
          {event.name}
        </Link>
        <h1 className="text-2xl font-bold sm:text-3xl">
          Personas and coverage
        </h1>
        <p className="flex flex-wrap items-center gap-2 text-sm text-base-content/70">
          <CalendarIcon size={14} />
          <code className="font-mono text-xs">{event.slug}</code>
          <span aria-hidden="true">-</span>
          <PeopleIcon size={14} />
          {data.personas.length === 1
            ? "1 persona"
            : `${String(data.personas.length)} personas`}
          <span aria-hidden="true">-</span>
          <ServerIcon size={14} />
          {data.servers.length === 1
            ? "1 enrolled server"
            : `${String(data.servers.length)} enrolled servers`}
        </p>
        <p className="text-sm text-base-content/70">
          Shared test patients for this event, curated from its source server
          and identified by IHI. This page needs no account: the personas are
          test data and are public by design.
        </p>
        {event.personaSourceUrl === null ? null : (
          <p className="flex flex-wrap items-center gap-1 text-sm text-base-content/70">
            Curated from
            <a
              className="link link-hover inline-flex items-center gap-1"
              href={event.personaSourceUrl}
              target="_blank"
              rel="noreferrer"
            >
              <code className="font-mono text-xs">
                {event.personaSourceUrl}
              </code>
              <LinkExternalIcon size={12} />
            </a>
          </p>
        )}
      </header>

      <OperationAlert operation={operation} />

      {data.personas.length === 0 ? (
        <p className="flex items-center gap-2 text-base-content/70">
          <PeopleIcon size={16} />
          No persona has been curated for this event yet.
        </p>
      ) : (
        <>
          <div className="flex flex-col gap-3">
            {rows.map((row) => (
              <PersonaCard key={row.persona.id} row={row} />
            ))}
          </div>

          <Panel
            title="Coverage"
            icon={<ServerIcon size={18} />}
            description="Whether each enrolled server holds a patient with the persona's IHI, and when it was last looked for."
          >
            {data.servers.length === 0 ? (
              <p className="text-sm text-base-content/70">
                No server is enrolled in this event yet, so there is nothing to
                search.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="table table-sm">
                  <thead>
                    <tr>
                      <th scope="col">Persona</th>
                      {data.servers.map((entry) => (
                        <ServerHeading
                          key={entry.enrolmentId}
                          entry={entry}
                          event={event}
                        />
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.persona.id}>
                        <th scope="row" className="whitespace-nowrap">
                          <span className="block">
                            {row.persona.display.name}
                          </span>
                          <code className="font-mono text-xs font-normal text-base-content/60">
                            {row.persona.ihi}
                          </code>
                        </th>
                        {row.cells.map((cell, index) => (
                          <td key={data.servers[index]?.enrolmentId ?? index}>
                            <CoverageBadge cell={cell} />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <ul className="flex flex-col gap-1 border-t border-base-300 pt-3">
              {legendStates.map((state) => (
                <li key={state} className="flex flex-wrap items-baseline gap-2">
                  <span className={`badge badge-sm ${coverageClass[state]}`}>
                    {coverageWords[state]}
                  </span>
                  <span className="text-sm text-base-content/70">
                    {coverageMeaning[state]}
                  </span>
                </li>
              ))}
            </ul>
          </Panel>
        </>
      )}
    </div>
  );
}
