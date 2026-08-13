/**
 * The event form, as data.
 *
 * Small, but the same reason as the system form: an event's capability tags are a list a person
 * builds one chip at a time, and its grace period is a number typed as text. Both conversions
 * belong somewhere testable.
 *
 * Author: John Grimes
 */

import type { EventDetail } from "@muster/contracts";

/** The event form's fields. */
export interface EventForm {
  readonly slug: string;
  readonly name: string;
  readonly startsOn: string;
  readonly endsOn: string;
  readonly graceDays: string;
  readonly personaSourceUrl: string;
  readonly capabilityTags: readonly string[];
}

/** An empty form, for an event being created. */
export const EMPTY_EVENT_FORM: EventForm = {
  slug: "",
  name: "",
  startsOn: "",
  endsOn: "",
  graceDays: "7",
  personaSourceUrl: "",
  capabilityTags: [],
};

/** The form an event's current state fills. */
export function eventForm(event: EventDetail): EventForm {
  return {
    slug: event.slug,
    name: event.name,
    startsOn: event.startsOn,
    endsOn: event.endsOn,
    graceDays: String(event.graceDays),
    personaSourceUrl: event.personaSourceUrl ?? "",
    capabilityTags: event.capabilityTags,
  };
}

/**
 * The body that creates an event.
 *
 * An unparseable grace period is sent as `NaN`, deliberately: the server refuses it and names the
 * field, where a console substituting a default would create an event with a grace period nobody
 * chose - and the grace period is what caps how long a minted credential outlives the event.
 */
export function createEventRequest(form: EventForm): Record<string, unknown> {
  return {
    slug: form.slug.trim(),
    name: form.name.trim(),
    startsOn: form.startsOn,
    endsOn: form.endsOn,
    graceDays: Number(form.graceDays),
    personaSourceUrl:
      form.personaSourceUrl.trim().length === 0
        ? null
        : form.personaSourceUrl.trim(),
    capabilityTags: [...form.capabilityTags],
  };
}

/**
 * The body that edits an event.
 *
 * The slug is absent: every public address for an event is built from it, so changing one would
 * break the links already handed out.
 */
export function editEventRequest(form: EventForm): Record<string, unknown> {
  const { slug: _slug, ...rest } = createEventRequest(form);
  return rest;
}

/**
 * Adds a tag, folded and trimmed the way the contract requires.
 *
 * Folded here rather than refused, because a participant typing `Smart-App-Host` means the tag
 * that already exists, and two spellings of one tag split every filter that uses it.
 *
 * @param tags - The tags already defined.
 * @param candidate - What was typed.
 * @returns The new list. Unchanged when the candidate is blank or already present.
 */
export function addCapabilityTag(
  tags: readonly string[],
  candidate: string,
): readonly string[] {
  const tag = candidate.trim().toLowerCase();
  if (tag.length === 0 || tags.includes(tag)) {
    return tags;
  }
  return [...tags, tag];
}

/** Removes a tag. */
export function removeCapabilityTag(
  tags: readonly string[],
  tag: string,
): readonly string[] {
  return tags.filter((held) => held !== tag);
}
