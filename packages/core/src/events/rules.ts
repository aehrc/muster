/**
 * What an event's status permits, and which tags an enrolment may carry.
 *
 * Small rules, but each is asked from more than one place - the enrolment route, the
 * pairing route that User Story 2 adds, the admin edit that opens and closes an event -
 * and each is a refusal that has to be identical wherever it is made. A closed event
 * that accepted an enrolment from one route and refused it from another would be worse
 * than either behaviour on its own.
 *
 * Pure, per constitution principle II.
 *
 * Author: John Grimes
 */

/**
 * An event's lifecycle position.
 *
 * The same vocabulary as `eventStatusSchema` in `@muster/contracts`, declared here
 * because this package is the domain and may not depend on the package that validates
 * the wire.
 */
export type EventStatus = "draft" | "open" | "closed";

/**
 * The transitions an admin may make, as `from -> to`.
 *
 * One way only. Closing an event lapses its open pairings and stops statement and
 * ticket minting, and nothing undoes those; an event re-opened would carry lapsed
 * pairings its participants could neither continue nor re-request. A second gathering
 * is a second event.
 */
const ALLOWED_STATUS_TRANSITIONS: ReadonlySet<`${EventStatus}->${EventStatus}`> =
  new Set(["draft->open", "open->closed"]);

/**
 * Whether an admin may move an event from one status to another.
 *
 * @param from - The status the event holds.
 * @param to - The status the admin asked for.
 * @returns `true` when the transition is one the data model names.
 * @example
 * ```ts
 * canChangeEventStatus("open", "closed"); // true
 * canChangeEventStatus("closed", "open"); // false
 * ```
 */
export function canChangeEventStatus(
  from: EventStatus,
  to: EventStatus,
): boolean {
  return ALLOWED_STATUS_TRANSITIONS.has(`${from}->${to}`);
}

/**
 * Whether an event is accepting enrolments and pairing requests.
 *
 * Only while open. A draft event is one an admin is still assembling, and a closed one
 * keeps every record readable and takes nothing new (FR-011).
 *
 * @param status - The event's status.
 * @returns `true` when the event is open.
 */
export function acceptsEnrolments(status: EventStatus): boolean {
  return status === "open";
}

/**
 * The requested tags an event does not define.
 *
 * Returns the offending values rather than a boolean, because the participant has to be
 * told which of the tags they chose was wrong. Duplicates are collapsed: naming one tag
 * twice reads as two different problems.
 *
 * @param requested - The tags the enrolment asked for.
 * @param capabilityTags - The tags the event defines.
 * @returns The requested tags with no definition, in the order they were requested.
 * @example
 * ```ts
 * const unknown = unknownTags(input.tags, event.capabilityTags);
 * if (unknown.length > 0) {
 *   return jsonError(c, 422, "unknown_tags", `This event does not define ${unknown.join(", ")}`);
 * }
 * ```
 */
export function unknownTags(
  requested: readonly string[],
  capabilityTags: readonly string[],
): readonly string[] {
  const defined = new Set(capabilityTags);
  return [...new Set(requested)].filter((tag) => !defined.has(tag));
}
