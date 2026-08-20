/*
 * Copyright © 2026 Commonwealth Scientific and Industrial Research Organisation
 * (CSIRO) ABN 41 687 119 230. Licensed under the Apache License, Version 2.0.
 */

import { succeeded } from "./operation.ts";
import { instantDetail } from "./systemDetails.ts";

import type { Operation } from "./operation.ts";
import type { Detail } from "./systemDetails.ts";
import type { TicketClaims, TicketRecord } from "@muster/contracts";

/**
 * What the ticket playground decides before it renders anything.
 *
 * Two things, both arithmetic rather than markup. A validity the member picks by
 * name - "eight hours" - becomes the instant the request carries, over an injected
 * clock so it can be tested; and the minted claims become rows under the profile's
 * own claim names, because a member comparing Muster's artefact with a data
 * holder's complaint is comparing claim names, not prose.
 *
 * The ceiling is deliberately not computed here. The server caps every ticket at
 * the event's end plus its grace days, and a console that computed the same cap
 * would be a second copy of a rule it does not own: choosing "until the event ends"
 * sends no instant at all and lets the server say what that means.
 *
 * @author John Grimes
 */

/** Milliseconds in an hour, for the relative validity choices. */
const oneHourMs = 60 * 60 * 1000;

/**
 * The scopes the playground offers.
 *
 * Patient compartment reads, because `patient-self-access` is the only ticket type
 * in scope: a ticket that let its holder write to somebody's record is not
 * self-access, and a scope Muster has published no profile for is a scope no data
 * holder can act on.
 */
export const offeredScopes: readonly string[] = [
  "patient/Patient.rs",
  "patient/Observation.rs",
  "patient/Condition.rs",
  "patient/MedicationRequest.rs",
  "patient/AllergyIntolerance.rs",
  "patient/Immunization.rs",
];

/** One validity the playground offers. */
export type ValidityChoice = {
  /** the value the select carries */
  readonly value: string;
  /** what it is called on screen */
  readonly label: string;
};

/**
 * How long each relative choice lasts, in hours.
 *
 * The event's own ceiling is not in here: it has no duration the console knows, and
 * that is the point.
 */
const validityHours: Record<string, number> = {
  oneHour: 1,
  eightHours: 8,
  oneDay: 24,
};

/**
 * The validity choices, in the order they are offered.
 *
 * The event's ceiling comes first because it is the default: a connectathon ticket
 * that lasts as long as the connectathon is what a member wants unless they are
 * deliberately testing expiry.
 */
export const validityChoices: readonly ValidityChoice[] = [
  { value: "event", label: "Until the event ends (the cap)" },
  { value: "oneHour", label: "One hour" },
  { value: "eightHours", label: "Eight hours" },
  { value: "oneDay", label: "One day" },
];

/**
 * Turns a validity choice into the instant to ask for.
 *
 * A choice this module does not recognise takes the ceiling rather than inventing a
 * lifetime, which is the same direction of failure the server takes.
 *
 * @param choice - the choice the member made
 * @param now - the current instant
 * @returns the instant to send, or undefined to take the server's cap
 * @example
 * ```ts
 * validUntilFor("eightHours", new Date("2026-08-19T02:00:00Z"));
 * // "2026-08-19T10:00:00.000Z"
 * ```
 */
export const validUntilFor = (
  choice: string,
  now: Date,
): string | undefined => {
  const hours = validityHours[choice];
  return hours === undefined
    ? undefined
    : new Date(now.getTime() + hours * oneHourMs).toISOString();
};

/**
 * Adds a scope to the chosen set, or removes it.
 *
 * The result is in the offered order rather than the clicking order, so the same
 * choices always produce the same `smart_scopes` claim - which matters when a
 * member is comparing two tickets to work out why one was refused.
 *
 * @param chosen - the scopes already chosen
 * @param scope - the scope the member toggled
 * @returns the scopes now chosen, in the offered order
 * @example
 * ```ts
 * toggleScope(["patient/Patient.rs"], "patient/Observation.rs");
 * // ["patient/Patient.rs", "patient/Observation.rs"]
 * ```
 */
export const toggleScope = (
  chosen: readonly string[],
  scope: string,
): readonly string[] => {
  const next = chosen.includes(scope)
    ? chosen.filter((one) => one !== scope)
    : [...chosen, scope];
  const offered = offeredScopes.filter((one) => next.includes(one));
  return [...offered, ...next.filter((one) => !offeredScopes.includes(one))];
};

/**
 * Renders the claims of a minted ticket as rows.
 *
 * Under the profile's own claim names, and in the profile's own order, so the
 * decoded view beside the compact form reads as the artefact rather than as a
 * summary of it (FR-034).
 *
 * @param claims - the claims the mint answered
 * @returns the rows to show
 * @example
 * ```tsx
 * <DetailList details={ticketClaimDetails(ticket.claims)} />
 * ```
 */
export const ticketClaimDetails = (claims: TicketClaims): readonly Detail[] => [
  { label: "iss", value: claims.iss, mono: true },
  { label: "jti", value: claims.jti, mono: true },
  instantDetail("iat", claims.iat),
  instantDetail("exp", claims.exp),
  { label: "ticket_type", value: claims.ticket_type, mono: true },
  {
    // Rendered as system|value, the way an identifier is written everywhere else
    // in FHIR: a member checking the subject is checking those two things.
    label: "subject",
    value: `${claims.subject.identifier.system}|${claims.subject.identifier.value}`,
    mono: true,
  },
  {
    label: "smart_scopes",
    value: claims.smart_scopes.split(" ").filter((scope) => scope !== ""),
    mono: true,
  },
  { label: "muster_event", value: claims.muster_event, mono: true },
];

/**
 * What to report about a mint that succeeded (FR-037).
 *
 * The validity is in the message because it is the thing the member is about to
 * rely on, and because a ticket capped shorter than they asked for has to say so
 * where they will read it.
 *
 * @param record - the ticket the mint answered
 * @param now - the current instant
 * @returns the operation to render
 * @example
 * ```ts
 * setOperation(ticketOperation(result.data.ticket, new Date()));
 * ```
 */
export const ticketOperation = (record: TicketRecord, now: Date): Operation => {
  const hours = Math.max(
    0,
    Math.round((Date.parse(record.expiresAt) - now.getTime()) / oneHourMs),
  );
  return succeeded(
    "Minting the ticket",
    `Minted, valid until ${record.expiresAt} - about ${String(hours)} hour${hours === 1 ? "" : "s"} from now.`,
  );
};
