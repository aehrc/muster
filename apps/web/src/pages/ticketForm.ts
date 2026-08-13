/**
 * What the ticket playground offers, and what it sends.
 *
 * Plain functions rather than markup, for the reason the rest of this directory is arranged
 * that way: the constraints a member chooses end up inside a signed artefact, and a scope
 * list assembled inline in a component cannot have a test.
 *
 * Three decisions worth stating.
 *
 * **The suggested scopes are a starting point, not the set.** A member may need a resource
 * type nobody thought of, so the checkboxes are joined with a free-text field and the two
 * are merged here - deduplicated, in a stable order, so that ticking a box that is already
 * typed does not put the same scope in the claim twice.
 *
 * **The cap is shown before the mint, not discovered after it.** FR-033 caps validity at the
 * event's end plus its grace, and the server derives it - but a date picker that silently
 * ignored what was typed would fail Nielsen's first heuristic. {@link validityCapDay} is the
 * same arithmetic the server does, so the field can say what will actually happen.
 *
 * **A server's ticket support is what its check found.** Not what its owner declared: the
 * whole point of FR-034's "as observed by verification checks" is that a claim on the event
 * view is one Muster watched a server make.
 *
 * Author: John Grimes
 */

import { words } from "../forms/textLists.js";

import type { EnrolledSystem } from "@muster/contracts";

/**
 * The scopes the playground offers as checkboxes.
 *
 * The quickstart's two first, because they are the pair scenario 7 uses, and then the
 * resource types a patient self-access demonstration usually reaches for. All read-only:
 * a self-access ticket that permitted writes would be a different conversation.
 */
export const SUGGESTED_SCOPES: readonly string[] = [
  "patient/Patient.rs",
  "patient/Observation.rs",
  "patient/Condition.rs",
  "patient/MedicationRequest.rs",
  "patient/AllergyIntolerance.rs",
  "patient/Immunization.rs",
];

/** How one enrolled server reads in the "where can I use it?" list. */
export interface TicketSupport {
  readonly systemId: string;
  readonly systemName: string;
  readonly organisationName: string;
  /** Whether its latest check found it advertising the type being minted. */
  readonly supported: boolean;
  /** The badge's words. */
  readonly label: string;
  /** Why, in a sentence: what was observed, or that nothing has been observed. */
  readonly detail: string;
}

/** Milliseconds in a day. */
const DAY_MS = 86_400_000;

/**
 * The scopes a mint should ask for.
 *
 * @param ticked - The suggested scopes the member has ticked.
 * @param typed - The free-text field, whitespace separated.
 * @returns The scopes, deduplicated, ticked ones first in the order they are offered.
 * @example
 * ```ts
 * chosenScopes(["patient/Patient.rs"], "patient/Goal.rs patient/Patient.rs");
 * // ["patient/Patient.rs", "patient/Goal.rs"]
 * ```
 */
export function chosenScopes(
  ticked: readonly string[],
  typed: string,
): readonly string[] {
  return [...new Set([...ticked, ...words(typed)])];
}

/**
 * The last day a ticket for this event could possibly be good for (FR-033).
 *
 * The event's last day plus its whole grace days, as a calendar date - which is the day the
 * date picker should stop at, and the day the server's own cap works out to.
 *
 * @param eventEndsOn - The event's last day, as `YYYY-MM-DD`.
 * @param graceDays - Whole days of grace past that day.
 * @returns The last permitted day, as `YYYY-MM-DD`, or `undefined` when the event's end is
 *   not a date this console could have been sent.
 * @example
 * ```ts
 * validityCapDay("2026-09-19", 7); // "2026-09-26"
 * ```
 */
export function validityCapDay(
  eventEndsOn: string,
  graceDays: number,
): string | undefined {
  const day = Date.parse(`${eventEndsOn}T00:00:00.000Z`);
  if (Number.isNaN(day)) {
    return undefined;
  }
  // The whole of `endsOn + graceDays` is covered, so that day is the last one to offer.
  return new Date(day + graceDays * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Which enrolled servers advertise the ticket type being minted (FR-034, scenario 3).
 *
 * Servers only: a client holds no patients, so a ticket presented to one would have nothing
 * to release. The three states are kept apart deliberately - advertised, checked and not
 * advertised, and never checked - because the third is not a claim about the server.
 *
 * @param systems - The event's enrolled systems, as the public listing returns them.
 * @param ticketType - The type being minted.
 * @returns One row per enrolled server, in the listing's order.
 * @example
 * ```ts
 * const holders = ticketSupport(systems.data?.systems ?? [], "patient-self-access");
 * ```
 */
export function ticketSupport(
  systems: readonly EnrolledSystem[],
  ticketType: string,
): readonly TicketSupport[] {
  return systems
    .filter((system) => system.kinds.includes("server"))
    .map((system) => {
      const advertised = system.check?.permissionTicketTypesSupported ?? [];
      const supported = advertised.includes(ticketType);
      return {
        systemId: system.systemId,
        systemName: system.name,
        organisationName: system.organisation.name,
        supported,
        label: supported ? "Supported" : "No support detected",
        detail: describeSupport(system.check === null, supported, advertised),
      };
    });
}

/** The sentence beside the badge. */
function describeSupport(
  unchecked: boolean,
  supported: boolean,
  advertised: readonly string[],
): string {
  if (unchecked) {
    // Never checked. Saying "does not support" here would blame a server nobody has looked
    // at, which is the same mistake the coverage grid exists to avoid.
    return "No verification check has run against this server yet.";
  }
  if (supported) {
    return `Advertises smart_permission_ticket_types_supported: ${advertised.join(", ")}.`;
  }
  return advertised.length === 0
    ? "Its smart-configuration advertises no smart_permission_ticket_types_supported."
    : `Advertises only ${advertised.join(", ")}.`;
}
