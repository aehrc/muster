/**
 * What the persona page says about coverage.
 *
 * Plain functions rather than markup, for the reason the rest of this directory is arranged
 * that way: what the console claims about somebody else's server is worth a test, and a
 * sentence assembled inside a component cannot have one.
 *
 * The distinction these functions exist to preserve is FR-032's. A cell that says the patient
 * is absent and a cell that says nothing could be established are different claims, and a
 * reader has to be able to tell them apart without reading the tooltip - so they get
 * different words, and `Personas.tsx` pairs each word with an Octicon of its own shape. A
 * pair nothing has checked is a fourth thing again, and saying so beats a blank cell that
 * reads as a rendering failure.
 *
 * The words are the whole of what these functions decide. The symbol used to be baked into
 * the text here, back when a glyph was the only mark a cell had; the icon is that mark now,
 * and a cell carrying both showed a tick beside a tick.
 *
 * Author: John Grimes
 */

import type {
  EventSummary,
  PersonaCoverageCell,
  PersonaCoverageOutcome,
  PersonaSourceStatus,
} from "@muster/contracts";

/** How one cell of the grid reads. */
export interface CoverageDescription {
  /** The cell's text: the claim in one word, beside the icon the page pairs with it. */
  readonly text: string;
  /** The server's own reason, for the cell's title. Null when there is nothing to add. */
  readonly detail: string | null;
}

/** How a persona's standing at its source reads. */
export interface SourceDescription {
  readonly flagged: boolean;
  readonly text: string;
}

/** What each outcome reads as in the grid. */
const OUTCOMES: Readonly<Record<PersonaCoverageOutcome, string>> = {
  found: "found",
  missing: "missing",
  // Deliberately its own word rather than a shade of "missing". "We could not tell" is not
  // "it is not there".
  unverifiable: "unverifiable",
};

/**
 * The event the persona page opens on.
 *
 * An open event by preference, because that is the one a reader at a connectathon is looking
 * at, and the first event otherwise so that the page has something to show rather than an
 * empty picker.
 *
 * @param events - Every event, as the API lists them.
 * @param requested - The slug the reader asked for, if any.
 * @returns The slug to show, or `undefined` when there are no events at all.
 * @example
 * ```ts
 * const slug = openEventSlug(events.data?.events ?? [], params.get("event") ?? undefined);
 * ```
 */
export function openEventSlug(
  events: readonly EventSummary[],
  requested?: string,
): string | undefined {
  const named = events.find((event) => event.slug === requested);
  // A stale link lands on something useful rather than on an empty page.
  return (named ?? events.find((event) => event.status === "open") ?? events[0])
    ?.slug;
}

/**
 * The key a cell is found by.
 *
 * @param personaId - The persona, which is a row of the grid.
 * @param enrolmentId - The enrolled server, which is a column.
 * @returns The composite key.
 * @example
 * ```ts
 * const cell = index.get(coverageKey(persona.id, server.enrolmentId));
 * ```
 */
export function coverageKey(personaId: string, enrolmentId: string): string {
  return `${personaId}|${enrolmentId}`;
}

/**
 * The cells, by persona and server.
 *
 * @param cells - Every cell the API sent, which is the latest outcome per pair.
 * @returns The index. A pair nothing has checked is absent rather than present with an
 *   invented outcome.
 * @example
 * ```ts
 * const index = coverageIndex(personas.data.coverage);
 * ```
 */
export function coverageIndex(
  cells: readonly PersonaCoverageCell[],
): ReadonlyMap<string, PersonaCoverageCell> {
  return new Map(
    cells.map((cell) => [coverageKey(cell.personaId, cell.enrolmentId), cell]),
  );
}

/**
 * What one cell says (FR-032, scenario 3).
 *
 * @param cell - The latest outcome for the pair, or `undefined` when nothing has checked it.
 * @returns The text and the server's own reason.
 * @example
 * ```ts
 * const described = describeCoverage(index.get(coverageKey(persona.id, server.enrolmentId)));
 * ```
 */
export function describeCoverage(
  cell: PersonaCoverageCell | undefined,
): CoverageDescription {
  if (cell === undefined) {
    return { text: "not checked yet", detail: null };
  }
  return { text: OUTCOMES[cell.outcome], detail: cell.detail };
}

/**
 * What a persona's standing at its source says (FR-032's edge case).
 *
 * @param status - The recorded standing.
 * @returns Whether to flag it, and the words to flag it with.
 * @example
 * ```ts
 * const source = describeSourceStatus(persona.sourceStatus);
 * ```
 */
export function describeSourceStatus(
  status: PersonaSourceStatus,
): SourceDescription {
  return status === "missing"
    ? {
        flagged: true,
        text: "missing at source - flagged",
      }
    : { flagged: false, text: "present at source" };
}
