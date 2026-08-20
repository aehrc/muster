import {
  personasResponseSchema,
  ticketResponseSchema,
} from "@muster/contracts";
import {
  ArrowLeftIcon,
  BookIcon,
  CheckCircleIcon,
  CopyIcon,
  KeyIcon,
  PeopleIcon,
  ShieldLockIcon,
} from "@primer/octicons-react";
import { useState } from "react";
import { Link, useParams } from "react-router";

import { muster } from "../api/muster.ts";
import { useResource } from "../api/useResource.ts";
import { DetailList } from "../components/DetailList.tsx";
import { CheckboxField, SelectField } from "../components/Fields.tsx";
import { OperationAlert } from "../components/OperationAlert.tsx";
import { Panel } from "../components/Panel.tsx";
import { StandingNotice } from "../components/StandingNotice.tsx";
import { standingFor } from "../lib/account.ts";
import { busy, failed, idle, pending } from "../lib/operation.ts";
import { describePersona } from "../lib/personas.ts";
import {
  offeredScopes,
  ticketClaimDetails,
  ticketOperation,
  toggleScope,
  validityChoices,
  validUntilFor,
} from "../lib/tickets.ts";
import { useSession } from "../session/sessionContext.ts";

import type { Operation } from "../lib/operation.ts";
import type { Persona, TicketResponse } from "@muster/contracts";
import type { JSX } from "react";

/**
 * The permission ticket playground (US8).
 *
 * A member picks one of the event's personas, says what the ticket may be used to
 * read and for how long, and Muster mints a signed ticket binding that persona by
 * IHI. The screen then shows the compact artefact beside its decoded claims
 * (FR-034), because the compact form is what gets pasted into a client and the
 * decoded form is what a data holder's refusal will be about.
 *
 * Three things on this screen are deliberate. The persona list comes from the
 * event's own set rather than from a free-text field, because a ticket for an IHI
 * nobody has seeded is a ticket nothing will resolve. The validity offers the
 * event's cap as its default and never computes the cap itself - the server owns
 * that rule, and the answer reports what was actually granted. And the ticket is
 * shown once, with that said plainly: it is a bearer artefact, and Muster stores
 * only its claims.
 *
 * @author John Grimes
 */

/**
 * Renders the ticket and its decoded claims.
 *
 * @param props - the minted ticket
 * @returns the panels
 */
function MintedTicket({
  minted,
}: Readonly<{
  /** the ticket the mint answered */
  minted: TicketResponse;
}>): JSX.Element {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
      <div className="flex flex-1 flex-col gap-3">
        <Panel
          title="The ticket, this once"
          icon={<ShieldLockIcon size={18} />}
          description="Whoever holds this can present it as the persona's authorisation, so Muster shows it here and stores only its claims. Mint another if you lose it."
        >
          <div className="flex flex-col gap-3">
            <code className="block overflow-x-auto rounded border border-warning bg-base-100 p-3 font-mono text-xs break-all">
              {minted.jwt}
            </code>
            <button
              type="button"
              className="btn btn-sm self-start"
              onClick={() => {
                void navigator.clipboard.writeText(minted.jwt).then(() => {
                  setCopied(true);
                });
              }}
            >
              <CopyIcon size={16} />
              {copied ? "Copied" : "Copy the ticket"}
            </button>
            <p className="text-xs text-base-content/60">
              Signed with key{" "}
              <code className="font-mono">{minted.ticket.keyId}</code>, valid
              until {minted.ticket.expiresAt}. The key is published at{" "}
              <a className="link" href="/.well-known/jwks.json">
                /.well-known/jwks.json
              </a>
              .
            </p>
          </div>
        </Panel>
      </div>

      <div className="flex flex-1 flex-col gap-3">
        <Panel
          title="Its decoded claims"
          icon={<CheckCircleIcon size={18} />}
          description="What a data holder validates: the issuer, the subject bound by IHI, the scope constraints and the validity."
        >
          <div className="flex flex-col gap-4">
            <DetailList details={ticketClaimDetails(minted.ticket.claims)} />
            <pre className="overflow-x-auto rounded bg-base-100 p-3 text-xs">
              <code>{JSON.stringify(minted.ticket.claims, undefined, 2)}</code>
            </pre>
          </div>
        </Panel>
      </div>
    </div>
  );
}

/**
 * The ticket playground screen.
 *
 * @returns the screen
 * @author John Grimes
 */
export function TicketPlayground(): JSX.Element {
  const { slug } = useParams();
  const { data, operation: read } = useResource(
    slug === undefined ? null : `/api/events/${slug}/personas`,
    personasResponseSchema,
    "Loading the personas",
  );
  const { session, operation: sessionOperation } = useSession();
  const standing = standingFor(session);

  const [personaId, setPersonaId] = useState("");
  const [scopes, setScopes] = useState<readonly string[]>([
    "patient/Patient.rs",
  ]);
  const [validity, setValidity] = useState("event");
  const [minted, setMinted] = useState<TicketResponse | null>(null);
  const [operation, setOperation] = useState<Operation>(idle);

  const personas: readonly Persona[] = data?.personas ?? [];
  const chosen = personas.find((persona) => persona.id === personaId) ?? null;

  const handleMint = async (): Promise<void> => {
    const what = "Minting the ticket";
    setMinted(null);
    setOperation(pending(what));
    const validUntil = validUntilFor(validity, new Date());
    const result = await muster.post(
      `/api/events/${String(slug)}/tickets`,
      {
        personaId,
        ticketType: "patient-self-access",
        scopes,
        ...(validUntil === undefined ? {} : { validUntil }),
      },
      ticketResponseSchema,
    );
    if (!result.ok) {
      setOperation(failed(what, result.failure));
      return;
    }
    setMinted(result.data);
    setOperation(ticketOperation(result.data.ticket, new Date()));
  };

  const heading = (
    <header className="flex flex-col gap-2">
      <Link
        to={`/events/${String(slug)}`}
        className="link link-hover flex w-fit items-center gap-1 text-sm"
      >
        <ArrowLeftIcon size={14} />
        Back to the event
      </Link>
      <h1 className="text-2xl font-bold sm:text-3xl">Ticket playground</h1>
      <p className="max-w-2xl text-sm text-base-content/70">
        Mint a <code className="font-mono">patient-self-access</code> permission
        ticket for one of this event&apos;s personas, then present it to a data
        holder&apos;s token endpoint. Muster signs the ticket with its
        ticket-purpose key and caps its validity at the event&apos;s end plus
        its grace period.
      </p>
      <p className="text-sm">
        <Link
          to="/docs/ticket-profile"
          className="link flex items-center gap-2"
        >
          <BookIcon size={14} /> What a data holder checks
        </Link>
      </p>
    </header>
  );

  if (!standing.canWrite) {
    return (
      <div className="flex flex-col gap-4">
        {heading}
        <OperationAlert operation={sessionOperation} />
        <StandingNotice standing={standing} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {heading}

      <OperationAlert operation={read} />
      <OperationAlert operation={operation} />

      <Panel
        title="What the ticket says"
        icon={<KeyIcon size={18} />}
        description="The persona is the subject, bound by IHI. The scopes are the constraint a data holder intersects with what the client asks for."
      >
        <div className="flex flex-col gap-4">
          {personas.length === 0 ? (
            <p className="flex items-center gap-2 text-sm text-base-content/70">
              <PeopleIcon size={16} />
              This event has no personas yet, so there is no subject to mint
              for. A track admin curates them from the event&apos;s source
              server.
            </p>
          ) : (
            <SelectField
              label="Persona"
              hint={
                chosen === null
                  ? "The subject the ticket is about."
                  : `IHI ${chosen.ihi} - ${describePersona(chosen)}`
              }
              options={[
                { value: "", label: "Choose a persona" },
                ...personas.map((persona) => ({
                  value: persona.id,
                  label: `${persona.display.name} (${persona.ihi})`,
                })),
              ]}
              value={personaId}
              onChange={setPersonaId}
            />
          )}

          <fieldset className="flex flex-col gap-1">
            <legend className="label font-medium mb-2">
              Scope constraints
            </legend>
            <div className="flex flex-col gap-1 sm:grid sm:grid-cols-2">
              {offeredScopes.map((scope) => (
                <CheckboxField
                  key={scope}
                  label={scope}
                  checked={scopes.includes(scope)}
                  onChange={() => {
                    setScopes(toggleScope(scopes, scope));
                  }}
                />
              ))}
            </div>
            <p className="text-xs text-base-content/60 mt-2">
              Patient compartment reads only: a self-access ticket authorises
              the patient&apos;s own record, and nothing else.
            </p>
          </fieldset>

          <SelectField
            label="Valid until"
            hint="Muster caps this at the event's end plus its grace days, whatever is asked for."
            options={validityChoices.map((choice) => ({
              value: choice.value,
              label: choice.label,
            }))}
            value={validity}
            onChange={setValidity}
          />

          <button
            type="button"
            className="btn btn-primary btn-sm self-start"
            disabled={
              busy(operation) || personaId === "" || scopes.length === 0
            }
            onClick={() => {
              void handleMint();
            }}
          >
            <KeyIcon size={16} />
            Mint the ticket
          </button>
          {personaId === "" || scopes.length === 0 ? (
            <p className="text-xs text-base-content/60">
              Choose a persona and at least one scope: a ticket that constrains
              nothing is not one Muster will sign.
            </p>
          ) : null}
        </div>
      </Panel>

      {minted === null ? null : <MintedTicket minted={minted} />}
    </div>
  );
}
