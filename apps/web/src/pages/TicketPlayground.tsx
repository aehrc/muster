/**
 * The ticket playground: choose a persona and some constraints, get a signed ticket.
 *
 * The wireframe's three regions, and each is a requirement rather than a layout choice.
 *
 * **The compact JWT sits beside its decoded claims** (FR-034). Both, at once, because they
 * answer different questions: the compact form is what a member pastes into their client,
 * and the decoded form is how they check that what they asked for is what was minted -
 * particularly the subject, which is bound by IHI system and value rather than by any
 * identifier local to a server.
 *
 * **The ticket is shown once and the page says so.** It lives in this component's state and
 * nowhere else: Muster does not store it and cannot show it again (`data-model.md`,
 * constitution principle IV), so leaving the page loses it and the remedy is to mint
 * another. That is the same bargain the DCR run's client secret makes, and it is stated in
 * the same place - beside the value, before the reader navigates away.
 *
 * It is not masked, though, and the client secret is. The difference is what they are for: a
 * secret is a long-lived credential its holder must never reveal, and a ticket is a
 * short-lived artefact about a fabricated test patient that a member is about to paste into
 * a terminal at a connectathon. Hiding it would cost the reader the thing they came for.
 *
 * **The cap is shown before the mint, not discovered after it.** The date field stops at the
 * event's last day plus its grace and says so, because a picker that silently ignored what
 * was typed would leave a reader believing they had a ticket for January (Nielsen's first
 * heuristic, and FR-037).
 *
 * **"Where can I use it?" is fed by the checks** (FR-034, scenario 3). What a server
 * advertises is what Muster watched it advertise, and a server nobody has checked says so
 * rather than being reported as unsupported.
 *
 * Author: John Grimes
 */

import { useState } from "react";

import { openEventSlug } from "./personaGrid.js";
import {
  chosenScopes,
  ticketSupport,
  validityCapDay,
  SUGGESTED_SCOPES,
} from "./ticketForm.js";
import { describeError } from "../api/errors.js";
import {
  useEvents,
  useEventSystems,
  useMintTicket,
  usePersonas,
} from "../api/queries.js";
import { EventPicker } from "../components/eventPicker.js";
import { CheckField, TextField } from "../components/fields.js";
import {
  DetailRow,
  EmptyState,
  ErrorAlert,
  Loading,
  PageHeader,
  Panel,
  Tag,
} from "../components/layout.js";
import { fullTime } from "../formatting/times.js";

import type { TicketSupport } from "./ticketForm.js";
import type { EventDetail, MintedTicket, PersonaView } from "@muster/contracts";
import type { ReactNode } from "react";

/** The only ticket type in scope (spec assumptions). */
const TICKET_TYPE = "patient-self-access";

/** The playground: mint a ticket for a persona, and see where it can be presented. */
export function TicketPlayground(): ReactNode {
  const events = useEvents();
  const [slug, setSlug] = useState<string | undefined>();
  const chosenSlug = openEventSlug(events.data?.events ?? [], slug) ?? "";
  const personas = usePersonas(chosenSlug);
  const systems = useEventSystems(chosenSlug);
  const failure = events.error ?? personas.error ?? systems.error;

  return (
    <article className="page-wide">
      <PageHeader
        title="Ticket playground"
        subtitle="Mint a SMART permission ticket for a shared persona, and present it to a data holder that accepts one. The subject is bound by IHI, never by an identifier local to one server."
        actions={
          <EventPicker
            events={events.data?.events ?? []}
            chosen={chosenSlug}
            onChoose={setSlug}
          />
        }
      />

      {failure === null ? null : (
        <ErrorAlert message={describeError(failure)} />
      )}
      {events.isPending ? <Loading label="Loading the events" /> : null}
      {events.data?.events.length === 0 ? (
        <EmptyState>No events yet, so there is nothing to mint for.</EmptyState>
      ) : null}
      {personas.data === undefined ? null : (
        <Playground
          event={personas.data.event}
          personas={personas.data.personas}
          support={ticketSupport(systems.data?.systems ?? [], TICKET_TYPE)}
          checksPending={systems.isPending}
        />
      )}
    </article>
  );
}

/** The mint form, the minted ticket, and where it can be presented. */
function Playground({
  event,
  personas,
  support,
  checksPending,
}: Readonly<{
  readonly event: EventDetail;
  readonly personas: readonly PersonaView[];
  readonly support: readonly TicketSupport[];
  readonly checksPending: boolean;
}>): ReactNode {
  const mint = useMintTicket(event.slug);
  const [personaId, setPersonaId] = useState<string>("");
  const [ticked, setTicked] = useState<readonly string[]>(
    SUGGESTED_SCOPES.slice(0, 2),
  );
  const [typed, setTyped] = useState("");
  const [validUntil, setValidUntil] = useState("");
  // Held here and nowhere else: a refetch cannot displace the artefact while the reader is
  // still copying it, and navigating away loses it, which is the point.
  const [minted, setMinted] = useState<MintedTicket | null>(null);

  const persona = personas.find((row) => row.id === personaId) ?? personas[0];
  const cap = validityCapDay(event.endsOn, event.graceDays);
  const scopes = chosenScopes(ticked, typed);

  if (personas.length === 0) {
    return (
      <EmptyState>
        No personas have been curated for {event.name} yet, and a ticket needs a
        subject. A track admin selects them from the event&apos;s source server.
      </EmptyState>
    );
  }

  function handleMint(submitted: React.FormEvent) {
    submitted.preventDefault();
    if (persona === undefined) {
      return;
    }
    mint.mutate(
      {
        personaId: persona.id,
        ticketType: TICKET_TYPE,
        scopes: [...scopes],
        validUntil: validUntil.length === 0 ? null : validUntil,
      },
      {
        onSuccess: (result) => {
          setMinted(result.ticket);
        },
      },
    );
  }

  return (
    <>
      <div className="card-row">
        <Panel
          title="Mint a permission ticket"
          description="Everything here is a constraint on what the ticket permits. The data holder grants the intersection of what is asked for and what this says."
        >
          <form onSubmit={handleMint}>
            <label className="field">
              <span className="field-label">Persona</span>
              <select
                value={persona?.id ?? ""}
                onChange={(changed) => {
                  setPersonaId(changed.target.value);
                }}
              >
                {personas.map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.display.name} - IHI {row.ihi}
                  </option>
                ))}
              </select>
            </label>

            <label className="field">
              <span className="field-label">Ticket type</span>
              <select disabled value={TICKET_TYPE}>
                <option value={TICKET_TYPE}>Patient self-access</option>
              </select>
              <span className="field-hint">
                The only ticket type currently defined.
              </span>
            </label>

            <fieldset className="field">
              <legend className="field-label">Scope constraints</legend>
              {SUGGESTED_SCOPES.map((scope) => (
                <CheckField
                  key={scope}
                  label={scope}
                  checked={ticked.includes(scope)}
                  onChange={(on) => {
                    setTicked(
                      on
                        ? [...ticked, scope]
                        : ticked.filter((held) => held !== scope),
                    );
                  }}
                />
              ))}
            </fieldset>

            <TextField
              label="Other scopes"
              value={typed}
              onChange={setTyped}
              hint="Whitespace separated. Patient-compartment scopes only: the subject is permitting access to their own record."
            />

            <label className="field">
              <span className="field-label">Valid until</span>
              <input
                type="date"
                value={validUntil}
                {...(cap === undefined ? {} : { max: cap })}
                onChange={(changed) => {
                  setValidUntil(changed.target.value);
                }}
              />
              <span className="field-hint">
                {cap === undefined
                  ? "Capped at the event's end plus its grace period."
                  : `Capped at ${cap}: ${event.name} ends on ${event.endsOn} and allows ${String(event.graceDays)} days of grace. Leave it empty for the cap.`}
              </span>
            </label>

            {mint.error === null ? null : (
              <ErrorAlert message={describeError(mint.error)} />
            )}

            <button
              type="submit"
              className="button button-primary"
              disabled={mint.isPending || scopes.length === 0}
            >
              {mint.isPending ? "Minting…" : "Mint ticket"}
            </button>
            {scopes.length === 0 ? (
              <p className="note">
                Choose at least one scope: a ticket that permits nothing is a
                ticket a data holder must refuse.
              </p>
            ) : null}
          </form>
        </Panel>

        <MintedPanel minted={minted} personas={personas} />
      </div>

      <Panel
        title="Where can I use it?"
        description="Fed by live verification checks: what each enrolled server advertises in its own smart-configuration, not what its owner declared."
      >
        {checksPending ? (
          <Loading label="Loading the enrolled servers" />
        ) : null}
        {!checksPending && support.length === 0 ? (
          <EmptyState>
            No servers are enrolled in {event.name} yet, so there is nowhere to
            present a ticket.
          </EmptyState>
        ) : null}
        <ul className="plain-list">
          {support.map((row) => (
            <li key={row.systemId}>
              <strong>{row.systemName}</strong>{" "}
              <span className="quiet">{row.organisationName}</span>{" "}
              <Tag>{row.label}</Tag>
              <div className="quiet wrap">{row.detail}</div>
            </li>
          ))}
        </ul>
      </Panel>
    </>
  );
}

/** The minted ticket: the compact form, and the decoded claims beside it (FR-034). */
function MintedPanel({
  minted,
  personas,
}: Readonly<{
  readonly minted: MintedTicket | null;
  readonly personas: readonly PersonaView[];
}>): ReactNode {
  const [copied, setCopied] = useState(false);

  if (minted === null) {
    return (
      <Panel title="Minted ticket">
        <p className="note">
          Nothing minted yet. The ticket will be a signed JWS carrying the
          persona&apos;s IHI as its subject, the scopes chosen here, and an
          expiry no later than the event&apos;s end plus its grace period.
        </p>
      </Panel>
    );
  }

  const subject = personas.find((row) => row.id === minted.personaId);

  function handleCopy() {
    void navigator.clipboard.writeText(minted?.jwt ?? "").then(() => {
      setCopied(true);
    });
  }

  return (
    <Panel
      title="Minted ticket"
      description="Shown once. Muster records that it was minted and does not store the ticket itself, so it cannot be shown again - copy it before you leave this page."
    >
      <div className="secret-row">
        <label className="field-label" htmlFor="permission-ticket">
          Compact JWS
        </label>
        <input
          className="secret-value"
          id="permission-ticket"
          readOnly
          type="text"
          value={minted.jwt}
        />
        <button type="button" className="button" onClick={handleCopy}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>

      <DetailRow label="Subject">
        {subject === undefined
          ? minted.claims.subject.identifier.value
          : `${subject.display.name} - IHI ${subject.ihi}`}
      </DetailRow>
      <DetailRow label="Signed with">
        <span className="wrap">{minted.keyId}</span>
      </DetailRow>
      <DetailRow label="Minted">{fullTime(minted.mintedAt)}</DetailRow>
      <DetailRow label="Expires">{fullTime(minted.expiresAt)}</DetailRow>

      <p className="field-label">Decoded</p>
      <pre className="code-block" data-testid="ticket-claims">
        {JSON.stringify(minted.claims, null, 2)}
      </pre>
      <p className="quiet">
        The subject is bound by IHI system and value, not by an identifier local
        to any one server. Verify the signature against{" "}
        <a href="/.well-known/jwks.json">/.well-known/jwks.json</a>.
      </p>
    </Panel>
  );
}
