/**
 * Choosing which event a page is about.
 *
 * Two pages need it - the public persona page and the admin persona table - and the project's
 * React guidelines are explicit that a shared style belongs in a component. There is a second
 * reason here: the two pickers must offer the same events in the same order, because an admin
 * curating personas and a participant reading them are looking at the same list and a
 * disagreement about which event is "the" event would be invisible and confusing.
 *
 * Built from {@link SelectField} rather than from its own markup, so that the picker is
 * labelled, spaced and themed exactly as every other choice in the console is: a control that
 * looked like a page's own would be the first hint that the console has two vocabularies.
 *
 * Renders nothing when there are no events. A `select` with no options is a control that
 * looks broken.
 *
 * Author: John Grimes
 */

import { SelectField } from "./fields.js";

import type { EventSummary } from "@muster/contracts";
import type { ReactNode } from "react";

/**
 * A labelled `select` over the events.
 *
 * @param props - What to render.
 * @param props.events - Every event, in the order the API lists them.
 * @param props.chosen - The slug currently selected.
 * @param props.onChoose - Called with the slug the reader picked.
 * @returns The picker, or nothing when there is nothing to pick.
 */
export function EventPicker({
  events,
  chosen,
  onChoose,
}: Readonly<{
  readonly events: readonly EventSummary[];
  readonly chosen: string;
  readonly onChoose: (slug: string) => void;
}>): ReactNode {
  if (events.length === 0) {
    return null;
  }
  return (
    <SelectField
      label="Event"
      value={chosen}
      options={events.map((event) => ({
        value: event.slug,
        label: event.name,
      }))}
      onChange={onChoose}
    />
  );
}
