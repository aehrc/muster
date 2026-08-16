/**
 * The event view: the replacement for the participant table.
 *
 * Two tables, servers and clients, filtered live by kind, capability tag and free text. Public, and
 * it says so - an anonymous reader gets everything except contact details, and the banner tells
 * them that rather than leaving them wondering what they are missing (constitution principle V,
 * FR-010).
 *
 * A system that is both a server and a client appears in both tables, because it is both. The
 * filtering itself is `./eventFilters.js`, which is where its tests are.
 *
 * The status column is fed by the scheduled checks (FR-017): reachable with the time it was
 * checked, or unreachable with the time it last worked (scenario 2), or "not checked yet" for an
 * entry nothing has looked at - which is an absence rather than a claim. A drift flag count sits
 * beside it, and the flags themselves are on the system page where there is room to name both
 * values.
 *
 * The registration column carries the DCR-verified badge (FR-030), which is a different kind of
 * claim from the status beside it: the checks say what a server advertises now, and the badge
 * says what it did when the conformance harness last presented the profile's cases to it. It
 * links to that run, because a badge whose evidence cannot be read is an assertion.
 *
 * Author: John Grimes
 */

import { useState } from "react";
import { Link } from "react-router";

import { CheckStatusCell } from "./checkPanels.js";
import {
  describeRegistrationMode,
  filterSystems,
  NO_FILTER,
  summariseScopes,
  systemsOfKind,
  toggleTag,
} from "./eventFilters.js";
import { describeBadge } from "./harnessReport.js";
import { describeError } from "../api/errors.js";
import { useEventSystems, useMe } from "../api/queries.js";
import { SelectField, TextField } from "../components/fields.js";
import { StatusLabel } from "../components/icons.js";
import {
  EmptyState,
  ErrorAlert,
  InfoAlert,
  Loading,
  PageHeader,
  Panel,
  Tag,
  TagToggle,
} from "../components/layout.js";
import { EVENT_STATUS_STATES } from "../components/statusStates.js";
import { harnessPath, ROUTES, systemPath } from "../routes.js";

import type { EventFilter } from "./eventFilters.js";
import type { EnrolledSystem } from "@muster/contracts";
import type { ReactNode } from "react";

/** The event's enrolled systems, grouped and filterable. */
export function EventView({ slug }: Readonly<{ readonly slug: string }>) {
  const listing = useEventSystems(slug);
  const me = useMe();
  const [filter, setFilter] = useState<EventFilter>(NO_FILTER);

  if (listing.isPending) {
    return <Loading label="Loading the event" />;
  }
  if (listing.error !== null) {
    return <ErrorAlert message={describeError(listing.error)} />;
  }

  const { event, systems } = listing.data;
  // Derived during render rather than synced by an effect: the filter is state, the result is a
  // calculation over it.
  const shown = filterSystems(systems, filter);
  const servers = systemsOfKind(shown, "server");
  const clients = systemsOfKind(shown, "client");
  const signedIn = me.data?.account !== null && me.data?.account !== undefined;

  return (
    <article className="flex flex-col">
      <PageHeader
        title={event.name}
        status={
          <StatusLabel state={EVENT_STATUS_STATES[event.status]}>
            {event.status}
          </StatusLabel>
        }
        subtitle={`${event.startsOn} to ${event.endsOn}`}
      />

      {signedIn ? (
        <InfoAlert>
          Signed in as {me.data?.account?.displayName}. Contact details are
          shown on each system.
        </InfoAlert>
      ) : (
        <p className="text-base-content/70 mb-2 text-sm">
          Everything here is public. Contact details are visible to signed-in
          approved members only -{" "}
          <Link className="link" to={ROUTES.signIn}>
            sign in
          </Link>{" "}
          to see them.
        </p>
      )}

      <Panel
        title="Filter"
        description="Narrows both tables as you type. Tag chips combine, so two chips means a system carrying both."
      >
        <div className="flex flex-wrap items-start gap-4 [&>*]:flex-1 [&>*]:basis-48">
          <SelectField
            label="Kind"
            value={filter.kind}
            options={[
              { value: "all", label: "All" },
              { value: "server", label: "Servers" },
              { value: "client", label: "Clients" },
            ]}
            onChange={(kind) => {
              setFilter({ ...filter, kind: kind as EventFilter["kind"] });
            }}
          />
          <TextField
            label="Search"
            value={filter.search}
            placeholder="Search systems or organisations"
            onChange={(search) => {
              setFilter({ ...filter, search });
            }}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {event.capabilityTags.length === 0 ? (
            <EmptyState>This event defines no capability tags.</EmptyState>
          ) : (
            event.capabilityTags.map((tag) => (
              <TagToggle
                key={tag}
                label={tag}
                pressed={filter.tags.includes(tag)}
                onToggle={() => {
                  setFilter({ ...filter, tags: toggleTag(filter.tags, tag) });
                }}
              />
            ))
          )}
        </div>
      </Panel>

      <SystemsPanel
        title="Servers"
        headers={[
          "System",
          "Organisation",
          "FHIR base URL",
          "Registration",
          "Status",
          "Tags",
        ]}
        systems={servers}
        emptyMessage="No enrolled server matches the filter."
        renderCells={(system) => (
          <>
            <SystemCells slug={slug} system={system} />
            <td className="wrap-anywhere">
              {system.serverProfile?.fhirBaseUrl}
            </td>
            <td>
              {describeRegistrationMode(
                system.serverProfile?.registrationMode ?? "manual",
              )}
              <VerifiedBadge system={system} />
            </td>
            <td>
              <CheckStatusCell check={system.check} />
            </td>
            <td>
              <TagList tags={system.tags} />
            </td>
          </>
        )}
      />

      <SystemsPanel
        title="Clients"
        headers={[
          "System",
          "Organisation",
          "Launch URL",
          "Scopes summary",
          "Tags",
        ]}
        systems={clients}
        emptyMessage="No enrolled client matches the filter."
        renderCells={(system) => (
          <>
            <SystemCells slug={slug} system={system} />
            <td className="wrap-anywhere">{system.clientProfile?.launchUrl}</td>
            <td className="wrap-anywhere">
              {summariseScopes(system.clientProfile?.scopes ?? [])}
            </td>
            <td>
              <TagList tags={system.tags} />
            </td>
          </>
        )}
      />

      <div className="flex flex-wrap gap-4 [&>section]:flex-1 [&>section]:basis-64">
        <Panel title="Shared personas">
          <p>
            The event&apos;s shared test patients and which servers hold them.
            Arrives with the persona index.
          </p>
        </Panel>
        <Panel title="Documentation">
          <p>
            The registration profile, the signing keys and worked examples.
            Arrives with the trusted-DCR profile.
          </p>
        </Panel>
      </div>
    </article>
  );
}

/**
 * One of the event view's two tables.
 *
 * The tables differ only in their columns, so the scaffolding - the heading, the empty state, the
 * row keys - is written once. Two copies would drift, and the half that drifted would be the
 * empty state nobody looks at until an event has no clients.
 */
function SystemsPanel({
  title,
  headers,
  systems,
  emptyMessage,
  renderCells,
}: Readonly<{
  readonly title: string;
  readonly headers: readonly string[];
  readonly systems: readonly EnrolledSystem[];
  readonly emptyMessage: string;
  readonly renderCells: (system: EnrolledSystem) => ReactNode;
}>) {
  return (
    <Panel title={title}>
      {systems.length === 0 ? (
        <EmptyState>{emptyMessage}</EmptyState>
      ) : (
        // Six columns of URLs and tags: the table scrolls inside the card rather than
        // dragging the page sideways with it.
        <div className="overflow-x-auto">
          <table className="table table-zebra table-sm align-top">
            <thead>
              <tr>
                {headers.map((header) => (
                  <th key={header}>{header}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {systems.map((system) => (
                <tr key={`${title}-${system.enrolmentId}`}>
                  {renderCells(system)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

/** The two cells both tables begin with: the system, and who owns it. */
function SystemCells({
  slug,
  system,
}: Readonly<{ readonly slug: string; readonly system: EnrolledSystem }>) {
  return (
    <>
      <td>
        <Link className="link" to={systemPath(slug, system.systemId)}>
          {system.name}
        </Link>
      </td>
      <td>{system.organisation.name}</td>
    </>
  );
}

/**
 * The DCR-verified badge, with the date of the run that earned it (FR-030, scenario 2).
 *
 * A link to the run rather than a bare label: the claim is only as good as the evidence
 * behind it, and the evidence is public (SC-005). Absent for an entry whose latest run
 * failed and for one nothing has run against - which is an absence rather than a claim.
 */
function VerifiedBadge({
  system,
}: Readonly<{ readonly system: EnrolledSystem }>): ReactNode {
  const badge = describeBadge(system.dcrVerified);
  return badge === null ? null : (
    <div className="mt-1">
      <Link to={harnessPath(system.enrolmentId)}>
        <Tag>
          <StatusLabel state="ok">{badge}</StatusLabel>
        </Tag>
      </Link>
    </div>
  );
}

/** A row's capability tags. */
function TagList({
  tags,
}: Readonly<{ readonly tags: readonly string[] }>): ReactNode {
  return tags.length === 0 ? (
    <span className="text-base-content/60 text-sm">none</span>
  ) : (
    <div className="flex flex-wrap gap-1">
      {tags.map((tag) => (
        <Tag key={tag}>{tag}</Tag>
      ))}
    </div>
  );
}
