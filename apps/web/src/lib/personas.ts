import type {
  CoverageOutcome,
  EnrolledSystem,
  Persona,
  PersonaCoverage,
  PersonasResponse,
} from "@muster/contracts";

/**
 * How the persona set and its coverage grid read on screen.
 *
 * The grid's whole value is that a reader can tell the three answers apart, so the
 * wording is a pure function here rather than markup in the page. There are four
 * states, not three: a pair nothing has checked yet is its own state, because a
 * blank cell and a cell that says "not found" mean opposite things to a server
 * owner about to seed data.
 *
 * `unverifiable` is deliberately not coloured as a failure. It is not the server
 * owner's fault that their server needs authorization, and colouring it red would
 * have people "fixing" a server that is behaving correctly. The reason travels with
 * the cell for the same purpose - "requires authorization" and "Muster refused the
 * address" are the same word to a reader who is only shown the word.
 *
 * @author John Grimes
 */

/** What a reader is told about one (persona, server) pair. */
export type CoverageState = CoverageOutcome | "unchecked";

/** What the console calls each state. */
export const coverageWords: Record<CoverageState, string> = {
  found: "Found",
  missing: "Missing",
  unverifiable: "Unverifiable",
  unchecked: "Not checked",
};

/** How the console colours each state. */
export const coverageClass: Record<CoverageState, string> = {
  found: "badge-success",
  missing: "badge-warning",
  // Not an error: a server that requires authorization is behaving correctly, and
  // a red badge would send its owner looking for a fault that is not there.
  unverifiable: "badge-info",
  unchecked: "badge-soft",
};

/** What each state means for whoever is reading it. */
export const coverageMeaning: Record<CoverageState, string> = {
  found: "The server holds a patient with this persona's IHI.",
  missing: "The server was searched and holds no patient with this IHI.",
  unverifiable:
    "The server could not be searched - it requires authorization, or Muster refused its address - so nothing is claimed either way.",
  unchecked: "This pair has not been checked yet.",
};

/** One cell of the grid. */
export type CoverageCell = {
  /** the state to render */
  readonly state: CoverageState;
  /** why, in words fit to show the reader */
  readonly detail: string;
  /** when the pair was checked, null when it has not been */
  readonly checkedAt: string | null;
};

/** One row of the grid: a persona, and its cell at each server. */
export type CoverageRow = {
  /** the persona the row is about */
  readonly persona: Persona;
  /** one cell per server, in the order the servers are given */
  readonly cells: readonly CoverageCell[];
};

/** How many servers hold a persona, and how many could not be searched. */
export type CoverageTally = {
  /** servers holding a patient with the IHI */
  readonly found: number;
  /** servers searched that do not hold one */
  readonly missing: number;
  /** servers that could not be searched */
  readonly unverifiable: number;
  /** pairs nothing has checked yet */
  readonly unchecked: number;
};

/**
 * The key one cell is indexed under.
 *
 * @param personaId - the persona the cell is about
 * @param enrolmentId - the server enrolment the cell is about
 * @returns the key
 */
const cellKey = (personaId: string, enrolmentId: string): string =>
  `${personaId}:${enrolmentId}`;

/** The cell shown for a pair nothing has checked. */
const uncheckedCell: CoverageCell = {
  state: "unchecked",
  detail: coverageMeaning.unchecked,
  checkedAt: null,
};

/**
 * Indexes the coverage rows by the pair they are about.
 *
 * @param coverage - the latest outcome per pair, as the API returned it
 * @returns the cells, by persona and enrolment
 * @example
 * ```ts
 * const cells = coverageIndex(data.coverage);
 * ```
 */
export const coverageIndex = (
  coverage: readonly PersonaCoverage[],
): Map<string, PersonaCoverage> =>
  new Map(
    coverage.map((cell) => [cellKey(cell.personaId, cell.enrolmentId), cell]),
  );

/**
 * Reads one cell out of the index.
 *
 * A pair the index does not hold is `unchecked` rather than absent, so the grid
 * has a cell everywhere and no reader mistakes a gap for a "missing".
 *
 * @param index - the indexed coverage
 * @param personaId - the persona
 * @param enrolmentId - the server enrolment
 * @returns the cell to render
 * @example
 * ```ts
 * const cell = coverageCell(cells, persona.id, entry.enrolmentId);
 * ```
 */
export const coverageCell = (
  index: Map<string, PersonaCoverage>,
  personaId: string,
  enrolmentId: string,
): CoverageCell => {
  const found = index.get(cellKey(personaId, enrolmentId));
  return found === undefined
    ? uncheckedCell
    : {
        state: found.outcome,
        detail:
          found.detail === "" ? coverageMeaning[found.outcome] : found.detail,
        checkedAt: found.checkedAt,
      };
};

/**
 * Builds the grid's rows.
 *
 * @param response - the personas, the servers and the coverage, as the API returned
 * @returns one row per persona, with one cell per server
 * @example
 * ```ts
 * const rows = coverageRows(data);
 * ```
 */
export const coverageRows = (response: PersonasResponse): CoverageRow[] => {
  const index = coverageIndex(response.coverage);
  return response.personas.map((persona) => ({
    persona,
    cells: response.servers.map((entry) =>
      coverageCell(index, persona.id, entry.enrolmentId),
    ),
  }));
};

/**
 * Counts one row's cells by state.
 *
 * @param row - the row to count
 * @returns how many servers hold the persona, and how many could not be searched
 * @example
 * ```ts
 * const tally = coverageTally(row); // { found: 2, missing: 1, ... }
 * ```
 */
export const coverageTally = (row: CoverageRow): CoverageTally => ({
  found: row.cells.filter((cell) => cell.state === "found").length,
  missing: row.cells.filter((cell) => cell.state === "missing").length,
  unverifiable: row.cells.filter((cell) => cell.state === "unverifiable")
    .length,
  unchecked: row.cells.filter((cell) => cell.state === "unchecked").length,
});

/**
 * States one row's coverage in a sentence.
 *
 * The unverifiable count is named rather than folded into the total, because "found
 * at two of four" invites the reader to assume the other two do not hold it.
 *
 * @param row - the row to describe
 * @returns the sentence
 * @example
 * ```ts
 * coverageSentence(row);
 * // "Found at 1 of 3 enrolled servers; 1 could not be searched."
 * ```
 */
export const coverageSentence = (row: CoverageRow): string => {
  if (row.cells.length === 0) {
    return "No server is enrolled in this event yet.";
  }
  const tally = coverageTally(row);
  const searched = tally.found + tally.missing;
  const opening =
    searched === 0
      ? "No enrolled server has been searched for this persona yet"
      : `Found at ${String(tally.found)} of ${String(searched)} searched server${searched === 1 ? "" : "s"}`;
  const notes = [
    tally.unverifiable === 0
      ? null
      : `${String(tally.unverifiable)} could not be searched`,
    tally.unchecked === 0 ? null : `${String(tally.unchecked)} not checked yet`,
  ].filter((note): note is string => note !== null);
  return notes.length === 0
    ? `${opening}.`
    : `${opening}; ${notes.join(", ")}.`;
};

/**
 * Describes a persona's demographics in one line.
 *
 * @param persona - the persona
 * @returns the demographics, omitting whatever the source did not state
 * @example
 * ```ts
 * describePersona(persona); // "Born 1978-06-16, female"
 * ```
 */
export const describePersona = (persona: Persona): string => {
  const parts = [
    persona.display.birthDate === null
      ? null
      : `Born ${persona.display.birthDate}`,
    persona.display.gender,
  ].filter((part): part is string => part !== null && part !== "");
  return parts.length === 0
    ? "No demographics were recorded."
    : parts.join(", ");
};

/**
 * States what an admin needs to know about a persona's standing at its source.
 *
 * @param persona - the persona
 * @returns the notice, or null when the source still holds it
 * @example
 * ```ts
 * const notice = sourceNotice(persona);
 * ```
 */
export const sourceNotice = (persona: Persona): string | null =>
  persona.sourceStatus === "missing"
    ? "The source server no longer holds this patient with this IHI, so the persona needs re-curating."
    : null;

/**
 * Names the servers a grid's columns are, in the order they are shown.
 *
 * The event's own order is kept - the API lists enrolments as it lists them
 * elsewhere - so a reader who has seen the event view finds the columns where they
 * expect them.
 *
 * @param response - the personas response
 * @returns the enrolled servers, as columns
 * @example
 * ```ts
 * const columns = coverageColumns(data);
 * ```
 */
export const coverageColumns = (
  response: PersonasResponse,
): readonly EnrolledSystem[] => response.servers;
