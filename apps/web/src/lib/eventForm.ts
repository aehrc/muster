import {
  createEventRequestSchema,
  updateEventRequestSchema,
} from "@muster/contracts";

import { joinList, parseRequest } from "./forms.ts";

import type { ParseOutcome } from "./forms.ts";
import type {
  CreateEventRequest,
  EventDetail,
  EventStatus,
  UpdateEventRequest,
} from "@muster/contracts";

/**
 * The event form: an event's dates, status and capability tags (FR-008).
 *
 * Capability tags are defined per event rather than fixed in the schema, and they
 * are phrases rather than identifiers ("form renderer host"), so they are read one
 * per line and the spaces inside them are kept - unlike a scope list, which
 * splits on whitespace.
 *
 * The slug is part of every public URL the event has, so it belongs to creation
 * only; an edit never carries it.
 *
 * @author John Grimes
 */

/** Every field of the event form, as text. */
export type EventFormValues = {
  /** the slug every public URL for the event derives from */
  readonly slug: string;
  /** the event's name */
  readonly name: string;
  /** the first day */
  readonly startsOn: string;
  /** the last day */
  readonly endsOn: string;
  /** where the event is in its lifecycle */
  readonly status: EventStatus;
  /** the capability tags, one per line */
  readonly capabilityTags: string;
  /** the FHIR server personas are curated from */
  readonly personaSourceUrl: string;
  /** how many days past the end artefacts stay valid */
  readonly graceDays: string;
};

/** An empty form. */
export const emptyEventForm: EventFormValues = {
  slug: "",
  name: "",
  startsOn: "",
  endsOn: "",
  status: "draft",
  capabilityTags: "",
  personaSourceUrl: "",
  graceDays: "",
};

/**
 * Reads capability tags from the text area.
 *
 * @param text - the tags as typed, one per line
 * @returns the tags, trimmed, with the blank lines dropped
 */
const tagsFrom = (text: string): string[] =>
  text
    .split("\n")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);

/**
 * The fields both contracts take.
 *
 * @param values - the form values
 * @returns the shared part of the body
 */
const sharedFields = (values: EventFormValues) => ({
  name: values.name,
  startsOn: values.startsOn,
  endsOn: values.endsOn,
  status: values.status,
  capabilityTags: tagsFrom(values.capabilityTags),
  // Blank is not zero: an unstated grace period is left to the server's default
  // rather than silently set to none. A value that is not a number reaches the
  // schema as NaN and is refused there, named.
  ...(values.graceDays.trim() === ""
    ? {}
    : { graceDays: Number(values.graceDays) }),
});

/**
 * Fills the form from a stored event.
 *
 * @param event - the event as stored
 * @returns the form values
 * @example
 * ```ts
 * const [values, setValues] = useState(eventFormFrom(event));
 * ```
 */
export const eventFormFrom = (event: EventDetail): EventFormValues => ({
  slug: event.slug,
  name: event.name,
  startsOn: event.startsOn,
  endsOn: event.endsOn,
  status: event.status,
  capabilityTags: joinList(event.capabilityTags),
  personaSourceUrl: event.personaSourceUrl ?? "",
  graceDays: String(event.graceDays),
});

/**
 * Builds a creation request.
 *
 * @param values - the form values
 * @returns the request, or one issue per offending field
 * @example
 * ```ts
 * const outcome = buildEventRequest(values);
 * if (outcome.ok) {
 *   await api.post("/api/admin/events", outcome.value, eventResponseSchema);
 * }
 * ```
 */
export const buildEventRequest = (
  values: EventFormValues,
): ParseOutcome<CreateEventRequest> =>
  parseRequest(createEventRequestSchema, {
    slug: values.slug,
    ...sharedFields(values),
    ...(values.personaSourceUrl.trim() === ""
      ? {}
      : { personaSourceUrl: values.personaSourceUrl.trim() }),
  });

/**
 * Builds an edit.
 *
 * @param values - the form values
 * @returns the patch, or one issue per offending field
 * @example
 * ```ts
 * const outcome = buildEventPatch({ ...values, status: "closed" });
 * ```
 */
export const buildEventPatch = (
  values: EventFormValues,
): ParseOutcome<UpdateEventRequest> =>
  parseRequest(updateEventRequestSchema, {
    ...sharedFields(values),
    // Emptying the field clears the persona source, which an omission would not.
    personaSourceUrl:
      values.personaSourceUrl.trim() === ""
        ? null
        : values.personaSourceUrl.trim(),
  });
