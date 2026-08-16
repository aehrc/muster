/**
 * The shared personas of an event, and who holds them.
 *
 * Public, and that is the point rather than an oversight: the personas are fabricated test
 * patients that every participating server is asked to load, and a coverage claim about
 * somebody else's server is only useful if the person checking their own loading can read it
 * without an account (spec scenario 5, constitution principle V).
 *
 * The page is the wireframe's: a card per persona with demographics, IHI and a link to the
 * canonical record on the source server, and a grid of personas against enrolled servers.
 * Two things the wireframe implies and this page states outright. A cell nothing has checked
 * says so rather than being blank, because a blank cell reads as a rendering failure. And
 * `unverifiable` is visibly not `missing` - a different word and a different icon shape -
 * because FR-032 exists precisely so that "the server would not answer" is never read as
 * "the patient is not there".
 *
 * The event is chosen by the `event` query parameter so a link to one is shareable, and
 * defaults to an open event, which is the one somebody at a connectathon is looking at.
 *
 * Every cell pairs the word `personaGrid.ts` gives it with an Octicon whose shape differs by
 * state (FR-004), so the state survives both a colour-blind reader and a glance across a grid
 * as wide as the event has servers. The word carries the claim and the shape carries it
 * again; neither is decoration for the other.
 *
 * Author: John Grimes
 */

import { useSearchParams } from "react-router";

import {
  coverageIndex,
  coverageKey,
  describeCoverage,
  describeSourceStatus,
  openEventSlug,
} from "./personaGrid.js";
import { describeError } from "../api/errors.js";
import { useEvents, usePersonas } from "../api/queries.js";
import { EventPicker } from "../components/eventPicker.js";
import { StatusLabel } from "../components/icons.js";
import {
  DetailRow,
  EmptyState,
  ErrorAlert,
  Loading,
  PageHeader,
  Panel,
} from "../components/layout.js";
import {
  COVERAGE_STATES,
  PERSONA_SOURCE_STATES,
} from "../components/statusStates.js";
import { fullTime } from "../formatting/times.js";

import type {
  EventPersonas,
  PersonaCoverageCell,
  PersonaCoverageServer,
  PersonaView,
} from "@muster/contracts";

/** The persona cards and the coverage grid, for whichever event the reader chose. */
export function Personas() {
  const [params, setParams] = useSearchParams();
  const events = useEvents();
  const slug =
    openEventSlug(
      events.data?.events ?? [],
      params.get("event") ?? undefined,
    ) ?? "";
  const personas = usePersonas(slug);
  const failure = events.error ?? personas.error;

  return (
    <article className="flex flex-col">
      <PageHeader
        title="Shared personas"
        subtitle="The shared test patients every participating server is asked to load. Public: this is test data by design."
        actions={
          <EventPicker
            events={events.data?.events ?? []}
            chosen={slug}
            onChoose={(chosen) => {
              setParams({ event: chosen });
            }}
          />
        }
      />

      {failure === null ? null : (
        <ErrorAlert message={describeError(failure)} />
      )}
      {events.data?.events.length === 0 ? (
        <EmptyState>No events yet, so there are no personas.</EmptyState>
      ) : null}
      {events.isPending || (personas.isPending && slug.length > 0) ? (
        <Loading label="Loading the personas" />
      ) : null}
      {personas.data === undefined ? null : (
        <PersonaSet personas={personas.data} />
      )}
    </article>
  );
}

/** One event's cards and grid. */
function PersonaSet({
  personas,
}: Readonly<{ readonly personas: EventPersonas }>) {
  if (personas.personas.length === 0) {
    return (
      <EmptyState>
        No personas have been curated for {personas.event.name} yet. A track
        admin selects them from the event&apos;s source server.
      </EmptyState>
    );
  }
  return (
    <>
      {/* A card per persona, side by side while there is room and stacked when there is
          not. `basis-72` rather than a column count: the number of personas is the event's
          business, not the layout's. */}
      <div className="flex flex-wrap gap-4 [&>section]:flex-1 [&>section]:basis-72">
        {personas.personas.map((persona) => (
          <PersonaCard key={persona.id} persona={persona} />
        ))}
      </div>
      <CoverageGrid personas={personas} />
    </>
  );
}

/** One persona: demographics, IHI, and the canonical record it came from. */
function PersonaCard({ persona }: Readonly<{ readonly persona: PersonaView }>) {
  const source = describeSourceStatus(persona.sourceStatus);
  return (
    <Panel title={persona.display.name}>
      <DetailRow label="Date of birth">
        {persona.display.birthDate ?? "not recorded"}
      </DetailRow>
      <DetailRow label="IHI">
        <code className="font-mono">{persona.ihi}</code>
        <div className="text-base-content/60 wrap-anywhere text-sm">
          {persona.ihiSystem}
        </div>
      </DetailRow>
      {persona.canonicalUrl === null ? null : (
        <p className="text-sm">
          <a
            className="link"
            href={persona.canonicalUrl}
            rel="noreferrer"
            target="_blank"
          >
            Canonical record
          </a>
          <span className="text-base-content/60">
            {" "}
            - this persona&apos;s Patient resource on the source server.
          </span>
        </p>
      )}
      {source.flagged ? (
        <p className="text-sm" role="status">
          <StatusLabel state={PERSONA_SOURCE_STATES[persona.sourceStatus]}>
            {source.text}
            {persona.sourceCheckedAt === null
              ? ""
              : ` when the source was last read, ${fullTime(persona.sourceCheckedAt)}.`}
          </StatusLabel>
        </p>
      ) : (
        <p className="text-base-content/60 text-sm">
          <StatusLabel state={PERSONA_SOURCE_STATES[persona.sourceStatus]}>
            {source.text}
            {persona.sourceCheckedAt === null
              ? " (not re-checked yet)"
              : `, checked ${fullTime(persona.sourceCheckedAt)}`}
          </StatusLabel>
        </p>
      )}
    </Panel>
  );
}

/** Personas against enrolled servers: what each one answered, and when (FR-032). */
function CoverageGrid({
  personas,
}: Readonly<{ readonly personas: EventPersonas }>) {
  const index = coverageIndex(personas.coverage);
  return (
    <Panel
      title="Coverage"
      description="Each enrolled server is searched for a patient carrying the persona's IHI. A server that requires authorisation for patient search shows 'unverifiable' rather than a guess. Clients are not searched: they hold no patients."
    >
      {personas.servers.length === 0 ? (
        <EmptyState>
          No servers are enrolled in this event yet, so there is nothing to
          search.
        </EmptyState>
      ) : (
        // One column per enrolled server, so the grid widens with the event: it scrolls
        // inside the card rather than dragging the page sideways with it.
        <div className="overflow-x-auto">
          <table className="table table-zebra table-sm align-top">
            <thead>
              <tr>
                <th>Persona</th>
                {personas.servers.map((server) => (
                  <th key={server.enrolmentId}>
                    {server.systemName}
                    <div className="text-base-content/60 font-normal">
                      {server.organisation.name}
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {personas.personas.map((persona) => (
                <tr key={persona.id}>
                  <th scope="row">
                    {persona.display.name}
                    <div className="text-base-content/60 font-normal">
                      <code className="font-mono">{persona.ihi}</code>
                    </div>
                  </th>
                  {personas.servers.map((server) => (
                    <CoverageCell
                      key={server.enrolmentId}
                      cell={index.get(
                        coverageKey(persona.id, server.enrolmentId),
                      )}
                      server={server}
                    />
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

/** One cell: the outcome, the time it was decided, and the server's own reason. */
function CoverageCell({
  cell,
  server,
}: Readonly<{
  readonly cell: PersonaCoverageCell | undefined;
  readonly server: PersonaCoverageServer;
}>) {
  const described = describeCoverage(cell);
  return (
    <td
      // The outcome itself rather than the tone that paints it: `unverifiable` and `missing`
      // are different claims (FR-032), and the suite asserts on the claim (FR-008).
      data-state={cell?.outcome ?? "unchecked"}
      data-testid="coverage-cell"
      title={described.detail ?? `${server.systemName}: ${described.text}`}
    >
      <StatusLabel state={COVERAGE_STATES[cell?.outcome ?? "unchecked"]}>
        {described.text}
      </StatusLabel>
      {cell === undefined ? null : (
        <div className="text-base-content/60 text-xs">
          {fullTime(cell.checkedAt)}
        </div>
      )}
      {described.detail === null ? null : (
        <div className="text-base-content/60 wrap-anywhere text-xs">
          {described.detail}
        </div>
      )}
    </td>
  );
}
