/*
 * Copyright © 2026 Commonwealth Scientific and Industrial Research Organisation
 * (CSIRO) ABN 41 687 119 230. Licensed under the Apache License, Version 2.0.
 */

import type {
  EnrolledSystem,
  EventDetail,
  SystemKind,
} from "@muster/contracts";

/**
 * Grouping, filtering and reading the event view's enrolled systems.
 *
 * The event view is the participant table's replacement, so the work here is the
 * work the table could not do: group by kind, narrow by capability tag, and
 * search the text someone would actually type (FR-010). All of it is a pure
 * function of what the public API returned, which is why it is testable without
 * a browser.
 *
 * One distinction matters more than the rest. Contact details are absent from an
 * anonymous response because nothing looked them up (FR-007), and absent from a
 * signed-in response only when the organisation has no contactable members. On
 * the wire those look identical unless the missing field is read as a missing
 * field rather than as an empty list, which is what `contactsWithheld` does.
 *
 * @author John Grimes
 */

/** What the event view has been narrowed to. */
export type SystemFilter = {
  /** the kind to show, or `all` for every kind */
  readonly kind: SystemKind | "all";
  /** the capability tag to require, or `all` for every tag */
  readonly tag: string;
  /** free text to match */
  readonly text: string;
};

/** One kind's systems. */
export type KindGroup = {
  /** the kind */
  readonly kind: SystemKind;
  /** what to call it */
  readonly label: string;
  /** the systems of that kind */
  readonly systems: readonly EnrolledSystem[];
};

/** Nothing narrowed. */
export const emptyFilter: SystemFilter = { kind: "all", tag: "all", text: "" };

/** The kinds a group is made for, in the order the view shows them. */
const groupedKinds: readonly SystemKind[] = ["server", "client"];

/** What one kind is called on its own. */
const labelForKind: Record<SystemKind, string> = {
  server: "Server",
  client: "Client",
};

/**
 * Names what a system is.
 *
 * @param kinds - the kinds the system carries
 * @returns the label, which is never blank even for a system carrying no kind
 * @example
 * ```ts
 * kindLabel(["server", "client"]); // "Server and client"
 * ```
 */
export const kindLabel = (kinds: readonly SystemKind[]): string => {
  const labels = groupedKinds
    .filter((kind) => kinds.includes(kind))
    .map((kind) => labelForKind[kind]);
  if (labels.length === 0) {
    return "Unspecified";
  }
  return labels.length === 1
    ? (labels[0] ?? "Unspecified")
    : `${labels[0] ?? ""} and ${(labels[1] ?? "").toLowerCase()}`;
};

/**
 * Groups enrolled systems by kind.
 *
 * A system that is both a server and a client appears in both groups, because
 * someone looking for a server should find it under servers. Empty groups are
 * kept, so the view can say a kind has nothing enrolled rather than omitting it
 * and leaving the reader to wonder.
 *
 * @param systems - the event's enrolled systems
 * @returns one group per kind, in view order
 * @example
 * ```ts
 * groupByKind(systems).map((group) => group.label);
 * ```
 */
export const groupByKind = (
  systems: readonly EnrolledSystem[],
): readonly KindGroup[] =>
  groupedKinds.map((kind) => ({
    kind,
    label: labelForKind[kind],
    systems: systems.filter((entry) => entry.system.kinds.includes(kind)),
  }));

/**
 * The text one entry is searched against.
 *
 * @param entry - the enrolled system
 * @returns everything a search should match, folded to lower case
 */
const searchableText = (entry: EnrolledSystem): string =>
  [
    entry.system.name,
    entry.system.description,
    entry.organisation.name,
    ...entry.tags,
    entry.system.serverProfile?.fhirBaseUrl ?? "",
    entry.system.serverProfile?.registrationEndpoint ?? "",
    entry.system.clientProfile?.launchUrl ?? "",
    ...(entry.system.clientProfile?.redirectUris ?? []),
    ...(entry.system.clientProfile?.scopes ?? []),
  ]
    .join(" ")
    .toLowerCase();

/**
 * Narrows the enrolled systems.
 *
 * @param systems - the event's enrolled systems
 * @param filter - the kind, the tag and the text to narrow to
 * @returns the systems that match every criterion given
 * @example
 * ```ts
 * const shown = filterSystems(systems, { kind: "server", tag: "all", text: "" });
 * ```
 */
export const filterSystems = (
  systems: readonly EnrolledSystem[],
  filter: SystemFilter,
): readonly EnrolledSystem[] => {
  const text = filter.text.trim().toLowerCase();
  return systems.filter(
    (entry) =>
      (filter.kind === "all" || entry.system.kinds.includes(filter.kind)) &&
      (filter.tag === "all" || entry.tags.includes(filter.tag)) &&
      (text === "" || searchableText(entry).includes(text)),
  );
};

/**
 * The capability tags the filter should offer.
 *
 * The event's own tags, plus any tag an enrolment carries: a tag the event has
 * since dropped is still on the entries that were enrolled with it, and a filter
 * that cannot select it would leave those entries unreachable.
 *
 * @param event - the event and its capability tags
 * @param systems - the enrolled systems
 * @returns the tags, sorted, without repeats
 * @example
 * ```ts
 * tagsOffered(event, systems).map((tag) => <option key={tag}>{tag}</option>);
 * ```
 */
export const tagsOffered = (
  event: EventDetail,
  systems: readonly EnrolledSystem[],
): readonly string[] =>
  [
    ...new Set([
      ...event.capabilityTags,
      ...systems.flatMap((entry) => entry.tags),
    ]),
  ].sort((left, right) => left.localeCompare(right));

/**
 * Whether contact details were withheld from this reader.
 *
 * @param entry - the enrolled system as received
 * @returns true when the field is absent altogether, which is what an anonymous
 *   response looks like; false when it is present, even if empty
 * @example
 * ```ts
 * {contactsWithheld(entry) ? <SignInPrompt /> : <ContactList contacts={entry.contacts ?? []} />}
 * ```
 */
export const contactsWithheld = (entry: EnrolledSystem): boolean =>
  entry.contacts === undefined;

/**
 * The enrolments belonging to one organisation.
 *
 * @param systems - the event's enrolled systems
 * @param organisationId - the owning organisation
 * @returns its enrolments
 * @example
 * ```ts
 * const mine = systemsOwnedBy(systems, membership.organisationId);
 * ```
 */
export const systemsOwnedBy = (
  systems: readonly EnrolledSystem[],
  organisationId: string,
): readonly EnrolledSystem[] =>
  systems.filter((entry) => entry.organisation.id === organisationId);

/**
 * The enrolment of one system, if it has one.
 *
 * @param systems - the event's enrolled systems
 * @param systemId - the system to look for
 * @returns its enrolment, or undefined when the system is not enrolled
 * @example
 * ```ts
 * const enrolled = enrolmentFor(systems, system.id) !== undefined;
 * ```
 */
export const enrolmentFor = (
  systems: readonly EnrolledSystem[],
  systemId: string,
): EnrolledSystem | undefined =>
  systems.find((entry) => entry.system.id === systemId);
