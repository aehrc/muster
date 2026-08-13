/**
 * One enrolled system, in full.
 *
 * Public, with two exceptions, and both are the page's point. The contacts panel is a locked
 * placeholder for an anonymous reader and the owning organisation's members for a signed-in
 * approved one (FR-007, scenarios 5 and 6); the contacts are fetched separately and only when
 * there is a session, so an anonymous visitor's page makes no request that would be refused.
 *
 * The verification panel is the other one: it reports what the server said when Muster last
 * asked, including any drift between what its owner declared and what it advertises (FR-017,
 * FR-018). It is shown only for systems that act as servers, because a client has no address to
 * fetch.
 *
 * The pairing panel is the entry point to User Story 2: this is where somebody browsing the
 * directory decides they want to register a client with this server. For a server whose
 * registration mode is `open` it says no pairing is needed and offers nothing (FR-016). It is
 * shown only for systems that act as servers, because there is nothing to register with a client.
 *
 * Author: John Grimes
 */

import { Link } from "react-router";

import { VerificationPanel } from "./checkPanels.js";
import { describeRegistrationMode } from "./eventFilters.js";
import { describeBadge } from "./harnessReport.js";
import { RequestPairing } from "./RequestPairing.js";
import { describeError } from "../api/errors.js";
import { useContacts, useEventSystem, useMe } from "../api/queries.js";
import {
  DetailRow,
  EmptyState,
  ErrorAlert,
  Loading,
  PageHeader,
  Panel,
  Tag,
} from "../components/layout.js";
import { eventPath, harnessPath, ROUTES } from "../routes.js";

import type {
  ClientProfile,
  EnrolledSystemDetail,
  ServerProfile,
} from "@muster/contracts";

/** The system's structured details, its verification status and its contacts. */
export function SystemDetail({
  slug,
  systemId,
}: Readonly<{ readonly slug: string; readonly systemId: string }>) {
  const entry = useEventSystem(slug, systemId);
  const me = useMe();
  const signedIn = me.data?.account != null;
  const contacts = useContacts(
    entry.data?.system.organisation.id ?? "",
    signedIn && entry.data !== undefined,
  );

  if (entry.isPending) {
    return <Loading label="Loading the system" />;
  }
  if (entry.error !== null) {
    return <ErrorAlert message={describeError(entry.error)} />;
  }

  const { event, system } = entry.data;

  return (
    <article className="page-wide">
      <p className="back">
        <Link to={eventPath(slug)}>&larr; Back to {event.name}</Link>
      </p>

      <PageHeader title={system.name} subtitle={system.organisation.name} />

      <div className="chips">
        {system.kinds.map((kind) => (
          <Tag key={kind}>{kind === "server" ? "Server" : "Client"}</Tag>
        ))}
        {system.tags.map((tag) => (
          <Tag key={tag}>{tag}</Tag>
        ))}
      </div>

      {system.description.length === 0 ? null : (
        <p className="lede">{system.description}</p>
      )}

      <div className="detail-columns">
        <div className="detail-main">
          {system.serverProfile === null ? null : (
            <ServerDetails profile={system.serverProfile} />
          )}
          {system.clientProfile === null ? null : (
            <ClientDetails profile={system.clientProfile} />
          )}
        </div>

        <div className="detail-side">
          {system.serverProfile === null ? null : (
            <RequestPairing event={event} signedIn={signedIn} system={system} />
          )}

          {system.serverProfile === null ? null : (
            <ConformancePanel system={system} />
          )}

          {system.serverProfile === null ? (
            <Panel title="Verification">
              <EmptyState>
                Nothing to verify: this entry is a client, and a client has no
                address for Muster to fetch.
              </EmptyState>
              <DetailRow label="Details confirmed by its owner">
                {system.confirmedAt}
              </DetailRow>
            </Panel>
          ) : (
            <VerificationPanel
              check={system.check}
              history={system.checkHistory}
              confirmedAt={system.confirmedAt}
            />
          )}

          <Panel title="Contacts">
            {signedIn ? (
              <ContactList
                pending={contacts.isPending}
                error={contacts.error}
                members={contacts.data?.members ?? []}
              />
            ) : (
              <EmptyState>
                Locked. <Link to={ROUTES.signIn}>Sign in</Link> as an approved
                member to see who to talk to about this system.
              </EmptyState>
            )}
          </Panel>
        </div>
      </div>
    </article>
  );
}

/**
 * What the conformance harness has proved about this entry (FR-030).
 *
 * Public, like the badge it explains: a vendor's evidence is theirs to share (SC-005). The link
 * is offered whatever the outcome, because "not verified" is a thing a reader needs to be able
 * to look into - and because it is where the entry's owner starts a run.
 */
function ConformancePanel({
  system,
}: Readonly<{ readonly system: EnrolledSystemDetail }>) {
  const badge = describeBadge(system.dcrVerified);
  const trusted = system.serverProfile?.registrationMode === "trustedDcr";

  return (
    <Panel
      title="Trusted DCR conformance"
      description="What this server did when Muster last presented the registration profile's cases to it."
    >
      {trusted ? (
        <>
          <DetailRow label="Badge">
            {badge === null ? (
              <span className="quiet">
                Not verified: no fully passing run stands.
              </span>
            ) : (
              <Tag>&#10003; {badge}</Tag>
            )}
          </DetailRow>
          <p>
            <Link to={harnessPath(system.enrolmentId)}>
              Conformance harness and its evidence
            </Link>
          </p>
        </>
      ) : (
        <EmptyState>
          Nothing to prove: this entry&apos;s registration mode is{" "}
          {describeRegistrationMode(
            system.serverProfile?.registrationMode ?? "manual",
          ).toLowerCase()}
          , so there is no registration profile for it to conform to.
        </EmptyState>
      )}
    </Panel>
  );
}

/** What the system declares as a server. */
function ServerDetails({
  profile,
}: Readonly<{ readonly profile: ServerProfile }>) {
  return (
    <Panel title="Server details">
      <DetailRow label="FHIR base URL">
        <span className="wrap">{profile.fhirBaseUrl}</span>
      </DetailRow>
      <DetailRow label="Authorization">
        {profile.authorizationMode === "smart"
          ? "SMART App Launch"
          : "Open - no authorization"}
      </DetailRow>
      <DetailRow label="Registration mode">
        {describeRegistrationMode(profile.registrationMode)}
      </DetailRow>
      {profile.registrationEndpoint === null ? null : (
        <DetailRow label="Registration endpoint">
          <span className="wrap">{profile.registrationEndpoint}</span>
        </DetailRow>
      )}
      {profile.notes.length === 0 ? null : (
        <DetailRow label="Notes">{profile.notes}</DetailRow>
      )}
    </Panel>
  );
}

/** What the system declares as a client. */
function ClientDetails({
  profile,
}: Readonly<{ readonly profile: ClientProfile }>) {
  return (
    <Panel title="Client details">
      <DetailRow label="Launch URL">
        <span className="wrap">{profile.launchUrl}</span>
      </DetailRow>
      <DetailRow label="Redirect URIs">
        <ul className="plain-list">
          {profile.redirectUris.map((uri) => (
            <li className="wrap" key={uri}>
              {uri}
            </li>
          ))}
        </ul>
      </DetailRow>
      <DetailRow label="Scopes">
        <span className="wrap">{profile.scopes.join(" ")}</span>
      </DetailRow>
      <DetailRow label="Confidentiality">
        {profile.confidentiality === "confidential" ? "Confidential" : "Public"}
      </DetailRow>
      <DetailRow label="Launch context">
        {profile.launchContext.length === 0
          ? "None stated"
          : profile.launchContext}
      </DetailRow>
      <DetailRow label="Token introspection">
        {profile.needsIntrospection ? "Required" : "Not required"}
      </DetailRow>
    </Panel>
  );
}

/** The owning organisation's members, once they have loaded. */
function ContactList({
  pending,
  error,
  members,
}: Readonly<{
  readonly pending: boolean;
  readonly error: unknown;
  readonly members: readonly {
    readonly accountId: string;
    readonly displayName: string;
    readonly email: string;
  }[];
}>) {
  if (pending) {
    return <Loading label="Loading the contacts" />;
  }
  if (error !== null && error !== undefined) {
    return <ErrorAlert message={describeError(error)} />;
  }
  if (members.length === 0) {
    return (
      <EmptyState>
        This organisation has no members. Its entries are unmanageable until a
        track admin reassigns it.
      </EmptyState>
    );
  }
  return (
    <ul className="plain-list">
      {members.map((member) => (
        <li key={member.accountId}>
          {member.displayName} - <span className="wrap">{member.email}</span>
        </li>
      ))}
    </ul>
  );
}
