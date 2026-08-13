/**
 * Filtering the event view.
 *
 * The wireframe's filter bar - a kind dropdown, tag chips that toggle, and a search box - filters
 * both tables live without a page reload. That is three interacting conditions over a list, which
 * is the kind of thing that is either a pure function with tests or a source of "why is this row
 * still showing" reports. It is a pure function.
 *
 * The search deliberately matches the organisation's name as well as the system's: two
 * organisations may hold systems with the same name, so "which of these is MediRecords'?" is a
 * question the search has to be able to answer.
 *
 * The wording of the event view's other derived cells lives here too, for the same reason: what
 * a status cell or a drift notice says is a claim about somebody else's server, and a claim is
 * worth a test. Only the wording - the times are formatted by the caller, so they stay in the
 * reader's own zone while the sentences stay testable.
 *
 * Author: John Grimes
 */

import type { EnrolledSystem, SystemKind } from "@muster/contracts";

/** What the filter bar is currently asking for. */
export interface EventFilter {
  /** `all`, or one kind. */
  readonly kind: "all" | SystemKind;
  /** The tags whose chips are on. Empty means no tag filter. */
  readonly tags: readonly string[];
  /** Free text, matched against the system, its description and its organisation. */
  readonly search: string;
}

/** Nothing filtered. */
export const NO_FILTER: EventFilter = { kind: "all", tags: [], search: "" };

/**
 * Whether a system is of the kind the filter asks for.
 *
 * A system that is both a server and a client matches either, because it is both - and the
 * event view lists it in both tables for that reason.
 */
function matchesKind(
  system: EnrolledSystem,
  kind: EventFilter["kind"],
): boolean {
  return kind === "all" || system.kinds.includes(kind);
}

/**
 * Whether a system carries every tag whose chip is on.
 *
 * Every, not any. The chips are a narrowing tool: somebody who turns on `form-renderer-host` and
 * `smart-app-host` is looking for a server that does both, and answering with the union would
 * make the second click widen the result.
 */
function matchesTags(system: EnrolledSystem, tags: readonly string[]): boolean {
  return tags.every((tag) => system.tags.includes(tag));
}

/** Whether the search text appears in anything a reader would search by. */
function matchesSearch(system: EnrolledSystem, search: string): boolean {
  const needle = search.trim().toLowerCase();
  if (needle.length === 0) {
    return true;
  }
  return [system.name, system.description, system.organisation.name].some(
    (field) => field.toLowerCase().includes(needle),
  );
}

/**
 * The systems the filter admits.
 *
 * @param systems - Every enrolled system.
 * @param filter - What the filter bar is asking for.
 * @returns The subset to render, in the order it arrived.
 * @example
 * ```ts
 * const shown = filterSystems(systems, { kind: "server", tags: ["smart-app-host"], search: "" });
 * ```
 */
export function filterSystems(
  systems: readonly EnrolledSystem[],
  filter: EventFilter,
): readonly EnrolledSystem[] {
  return systems.filter(
    (system) =>
      matchesKind(system, filter.kind) &&
      matchesTags(system, filter.tags) &&
      matchesSearch(system, filter.search),
  );
}

/**
 * The systems acting as one kind, for one of the event view's two tables.
 *
 * Separate from {@link filterSystems} because the kind dropdown and the table a row belongs in
 * are different questions: with the dropdown on `all`, a system that is both appears in both
 * tables.
 *
 * @param systems - The systems the filter admitted.
 * @param kind - Which table is being filled.
 * @returns The systems that act as that kind.
 */
export function systemsOfKind(
  systems: readonly EnrolledSystem[],
  kind: SystemKind,
): readonly EnrolledSystem[] {
  return systems.filter((system) => system.kinds.includes(kind));
}

/**
 * Turns a tag chip on or off.
 *
 * @param tags - The tags currently on.
 * @param tag - The chip that was clicked.
 * @returns The new set, in a stable order so the chips do not move as they are clicked.
 */
export function toggleTag(
  tags: readonly string[],
  tag: string,
): readonly string[] {
  return tags.includes(tag)
    ? tags.filter((held) => held !== tag)
    : [...tags, tag];
}

/**
 * A summary of a client's scopes, short enough for a table cell.
 *
 * Truncated by count rather than by characters, so the cell never cuts a scope in half and
 * leaves `patient/Observatio`.
 *
 * @param scopes - The client's requested scopes.
 * @param limit - How many to show before summarising the rest.
 * @returns The summary.
 * @example
 * ```ts
 * summariseScopes(["launch", "openid", "fhirUser", "patient/*.rs"], 3);
 * // "launch, openid, fhirUser and 1 more"
 * ```
 */
export function summariseScopes(scopes: readonly string[], limit = 5): string {
  if (scopes.length <= limit) {
    return scopes.join(", ");
  }
  const remaining = scopes.length - limit;
  return `${scopes.slice(0, limit).join(", ")} and ${String(remaining)} more`;
}

/** How confident the entry's status is, for the class name the cell carries. */
export type CheckTone = "unknown" | "ok" | "bad";

/** A status as a table cell shows it. */
export interface CheckDescription {
  readonly tone: CheckTone;
  readonly text: string;
}

/**
 * How each failure mode reads.
 *
 * `timeout` and `refused` are deliberately different sentences: the spec's own edge case is
 * that a slow server and a dead one are distinct, and collapsing them on the page would undo
 * the distinction the check took care to record. `guarded` does not say "unreachable" at all,
 * because Muster never asked - the address was refused, and the entry is what needs fixing.
 */
const FAILURE_LABELS: Readonly<Record<string, string>> = {
  timeout: "Unreachable (timed out)",
  refused: "Unreachable",
  guarded: "Address refused",
  invalid: "Unreachable (unusable answer)",
};

/**
 * The status sentence for one enrolled server (FR-017, scenario 2).
 *
 * The time formatter is passed in rather than called here, so the wording is a pure function
 * with tests while the times stay in the reader's own zone - which is what the wireframe's
 * annotation asks for.
 *
 * @param check - The latest check, or null when none has run.
 * @param formatTime - Renders an ISO timestamp as a reader sees it.
 * @returns The tone and the sentence.
 * @example
 * ```ts
 * const status = describeCheckStatus(system.check, (iso) =>
 *   new Date(iso).toLocaleTimeString(),
 * );
 * ```
 */
export function describeCheckStatus(
  check: {
    readonly checkedAt: string;
    readonly reachable: boolean;
    readonly failureMode: string | null;
    readonly lastSuccessAt: string | null;
  } | null,
  formatTime: (iso: string) => string,
): CheckDescription {
  if (check === null) {
    // Not a failure. A server nobody has looked at has not been found unreachable.
    return { tone: "unknown", text: "Not checked yet" };
  }
  if (check.reachable) {
    return {
      tone: "ok",
      text: `Reachable, checked ${formatTime(check.checkedAt)}`,
    };
  }
  const label = FAILURE_LABELS[check.failureMode ?? ""] ?? "Unreachable";
  return {
    tone: "bad",
    text:
      check.lastSuccessAt === null
        ? `${label}, never reachable, checked ${formatTime(check.checkedAt)}`
        : `${label} since ${formatTime(check.lastSuccessAt)}`,
  };
}

/** How each declared field reads in a drift notice. */
const DRIFT_FIELD_LABELS: Readonly<Record<string, string>> = {
  fhirBaseUrl: "FHIR base URL",
  authorizationMode: "authorization mode",
  authorizationEndpoint: "authorization endpoint",
  tokenEndpoint: "token endpoint",
  registrationEndpoint: "registration endpoint",
};

/**
 * How a drift flag's field reads (FR-018).
 *
 * The wireframe's notice says "declared token endpoint differs from advertised", so the field
 * has to be a phrase. A field this table does not know is spaced out rather than shown as an
 * identifier, so a comparison added later still reads as English.
 *
 * @param field - The field the flag names.
 * @returns The phrase to put in the notice.
 * @example
 * ```ts
 * `Declared ${describeDriftField(flag.field)} differs from advertised`;
 * ```
 */
export function describeDriftField(field: string): string {
  return (
    DRIFT_FIELD_LABELS[field] ??
    field.replaceAll(/([a-z])([A-Z])/g, "$1 $2").toLowerCase()
  );
}

/** How a registration mode reads in a table. */
export function describeRegistrationMode(mode: string): string {
  switch (mode) {
    case "open": {
      return "Open - no registration needed";
    }
    case "manual": {
      return "Manual request";
    }
    default: {
      return "Trusted DCR";
    }
  }
}
