import {
  authoriseEventOpen,
  authoriseWrite,
  refuse,
} from "../accounts/rules.ts";
import { vouchingExpiresAt } from "../statements/build.ts";

import type {
  AccountFacts,
  AuthorisationDecision,
  Refusal,
} from "../accounts/rules.ts";
import type { EventStatus } from "@muster/contracts";

/**
 * The permission ticket: what it claims, and when Muster will mint one.
 *
 * This is the playground's artefact, and a data holder validates it, so every
 * claim name here is `contracts/ticket-profile.md` - which follows the SMART
 * Permission Tickets draft 0.1.0. The names are centralised in this module for the
 * reason the contract states: the draft will move, and a claim renamed in one
 * place is a one-module change rather than a search across a codebase.
 *
 * Minting a ticket is a vouching action, so it is deny by default (FR-025,
 * FR-033). Muster is telling somebody else's server that the holder of this token
 * may read a real patient's record, which is a larger claim than a software
 * statement makes: five conditions must each be affirmatively true - an approved,
 * verified, unrevoked account; an open event; a persona belonging to that event;
 * constraints that actually constrain something; and a validity that has not
 * already passed - and anything absent or ambiguous is a refusal.
 *
 * Two things are deliberately narrow. Only the patient self-access type exists,
 * because that is the only shape the draft and the companion Signet feature agree
 * on; and the subject is bound by IHI alone, because a name matches nothing across
 * two participants' servers while a national identifier matches exactly one
 * patient at each (FR-031).
 *
 * @author John Grimes
 */

/**
 * The ticket types Muster mints.
 *
 * One entry, deliberately. The playground sits on a 0.1.0 draft, and a type
 * Muster has published no profile for is a type no data holder can validate
 * against, so anything outside this list is refused rather than signed.
 */
export const ticketTypes: readonly string[] = ["patient-self-access"];

/**
 * The subject of a ticket, bound by identifier.
 *
 * The profile's own shape - a nested identifier rather than a bare string -
 * because a data holder resolves it against its own patients, and it needs the
 * system as well as the value to know what it is resolving.
 */
export type TicketSubject = {
  /** the identifier the subject is bound by */
  readonly identifier: {
    /** the identifier system the value is asserted under */
    readonly system: string;
    /** the identifier value */
    readonly value: string;
  };
};

/**
 * The claims a permission ticket carries, per the ticket profile.
 *
 * Named in the profile's own vocabulary - snake_case, as they appear on the wire -
 * because a claim renamed on the way out is a claim the data holder cannot find.
 */
export type TicketClaims = {
  /** the issuer identifier, which is Muster's public URL */
  readonly iss: string;
  /** the ticket identifier, unique per mint */
  readonly jti: string;
  /** when the ticket was minted, in seconds since the epoch */
  readonly iat: number;
  /** when it stops being valid, in seconds since the epoch */
  readonly exp: number;
  /** the ticket type; `patient-self-access` is the only one in scope */
  readonly ticket_type: string;
  /** the patient the ticket is about, bound by IHI */
  readonly subject: TicketSubject;
  /** the scope constraints, space-separated */
  readonly smart_scopes: string;
  /** the event slug the ticket is scoped to */
  readonly muster_event: string;
};

/**
 * What building a ticket's claims needs to know.
 *
 * Separate from the rest of a mint's facts for the same reason the statement
 * module separates them: the claims are content and the rest is permission, and a
 * caller that needs to show what would be minted should not have to assert a
 * right it does not have in order to see it.
 */
export type TicketContentFacts = {
  /** the trust anchor's issuer identifier */
  readonly issuer: string;
  /** the event slug the ticket is scoped to */
  readonly eventSlug: string;
  /** the event's last day, as `YYYY-MM-DD` */
  readonly eventEndsOn: string;
  /** days beyond the event's end that artefacts for it may live */
  readonly graceDays: number;
  /** the ticket type asked for */
  readonly ticketType: string;
  /** the identifier system the persona's IHI is asserted under */
  readonly ihiSystem: string;
  /** the persona's IHI, which is what binds the subject */
  readonly ihi: string;
  /** the scope constraints chosen at mint */
  readonly scopes: readonly string[];
  /** the validity asked for, or null to take the ceiling */
  readonly validUntil: Date | null;
  /** the ticket identifier */
  readonly jti: string;
  /** the moment of minting */
  readonly now: Date;
};

/** What deciding and building a mint needs to know. */
export type TicketMintFacts = TicketContentFacts & {
  /** the account asking */
  readonly member: AccountFacts;
  /** the event's status */
  readonly eventStatus: EventStatus;
  /** whether the persona named belongs to that event */
  readonly personaInEvent: boolean;
};

/** The outcome of a mint. */
export type TicketMintResult =
  | {
      /** the mint was granted */
      readonly ok: true;
      /** the claims to sign */
      readonly claims: TicketClaims;
      /** when the ticket stops being valid, as an instant */
      readonly expiresAt: Date;
    }
  | {
      /** the mint was refused */
      readonly ok: false;
      /** why, in words fit to show the member refused */
      readonly refusal: Refusal;
    };

/** What the validity of a ticket is reckoned from. */
export type TicketValidity = {
  /** the event's last day, as `YYYY-MM-DD` */
  readonly endsOn: string;
  /** days beyond the event's end that artefacts for it may live */
  readonly graceDays: number;
  /** the validity the member asked for, or null to take the ceiling */
  readonly requested: Date | null;
};

/**
 * Drops the blanks from a list of scopes and trims what is left.
 *
 * @param scopes - the scopes as chosen
 * @returns the scopes worth signing
 */
const usableScopes = (scopes: readonly string[]): readonly string[] =>
  scopes.map((scope) => scope.trim()).filter((scope) => scope !== "");

/**
 * The instant a ticket stops being valid.
 *
 * The ceiling is the event's end plus its grace period - the same instant a
 * software statement is capped at, from the same function, because a cap two
 * modules computed separately is a cap that will eventually disagree with itself.
 * A member asking for less gets less; a member asking for more gets the ceiling
 * (FR-033).
 *
 * @param validity - the event's window and the validity asked for
 * @returns the instant the ticket expires
 * @example
 * ```ts
 * ticketExpiresAt({ endsOn: "2026-09-03", graceDays: 7, requested: null });
 * // 2026-09-11T00:00:00.000Z
 * ```
 */
export const ticketExpiresAt = (validity: TicketValidity): Date => {
  const ceiling = vouchingExpiresAt({
    endsOn: validity.endsOn,
    graceDays: validity.graceDays,
  });
  return validity.requested !== null &&
    validity.requested.getTime() < ceiling.getTime()
    ? validity.requested
    : ceiling;
};

/**
 * Whether the constraints are fit to mint a ticket from.
 *
 * A ticket is its constraints: the type says what shape it is, the scopes say what
 * it permits, and the identifier is what a data holder refuses a replay by. None
 * of the three has a sensible default, so an absence is a refusal.
 *
 * @param facts - the type, the scopes and the identifier
 * @returns the decision
 */
const authoriseConstraints = (
  facts: TicketMintFacts,
): AuthorisationDecision => {
  if (!ticketTypes.includes(facts.ticketType)) {
    return refuse(
      "invalid_metadata",
      `Muster mints ${ticketTypes.join(", ")} tickets, and ${facts.ticketType} is not one of them.`,
    );
  }
  if (facts.jti.trim() === "") {
    return refuse(
      "invalid_metadata",
      "A ticket needs an identifier, and none was generated.",
    );
  }
  if (usableScopes(facts.scopes).length === 0) {
    return refuse(
      "invalid_metadata",
      "A permission ticket has to name at least one scope, or it constrains nothing.",
    );
  }
  if (facts.ihi.trim() === "") {
    return refuse(
      "no_ihi",
      "This persona carries no IHI, so there is no subject to bind the ticket to.",
    );
  }
  return { ok: true };
};

/**
 * Whether the ticket would be valid for any time at all.
 *
 * Both ends of it: an event whose grace period has run out mints nothing, and a
 * validity the member asked for that has already passed is their own mistake,
 * reported rather than quietly widened to the ceiling.
 *
 * @param facts - the event's window, the validity asked for and the clock
 * @returns the decision
 */
const authoriseValidity = (facts: TicketMintFacts): AuthorisationDecision => {
  const ceiling = vouchingExpiresAt({
    endsOn: facts.eventEndsOn,
    graceDays: facts.graceDays,
  });
  if (ceiling.getTime() <= facts.now.getTime()) {
    return refuse(
      "vouching_expired",
      `Tickets for ${facts.eventSlug} stopped being valid on ${ceiling.toISOString().slice(0, 10)}, so one minted now would already have expired.`,
    );
  }
  if (
    facts.validUntil !== null &&
    facts.validUntil.getTime() <= facts.now.getTime()
  ) {
    return refuse(
      "invalid_metadata",
      `That validity has already passed: ${facts.validUntil.toISOString()} is not in the future.`,
    );
  }
  return { ok: true };
};

/**
 * Decides whether a permission ticket may be minted.
 *
 * Every condition in order, each refused with its own reason so the member is told
 * which one they failed rather than being told no.
 *
 * @param facts - the member, the event, the persona, the constraints and the clock
 * @returns the decision
 * @example
 * ```ts
 * const decision = authoriseTicketMint(facts);
 * if (!decision.ok) {
 *   throw refusalError(decision.refusal);
 * }
 * ```
 */
export const authoriseTicketMint = (
  facts: TicketMintFacts,
): AuthorisationDecision => {
  const writing = authoriseWrite(facts.member);
  if (!writing.ok) {
    return writing;
  }
  const openness = authoriseEventOpen(facts.eventStatus);
  if (!openness.ok) {
    return openness;
  }
  if (!facts.personaInEvent) {
    return refuse(
      "not_in_event",
      "That persona belongs to another event, so no ticket for this event can name it.",
    );
  }
  const constraints = authoriseConstraints(facts);
  if (!constraints.ok) {
    return constraints;
  }
  return authoriseValidity(facts);
};

/**
 * Builds the claims of a ticket, without deciding whether to.
 *
 * @param facts - the issuer, the event, the persona and the constraints
 * @returns the claims, ready to sign
 * @example
 * ```ts
 * const claims = ticketClaims(facts);
 * ```
 */
export const ticketClaims = (facts: TicketContentFacts): TicketClaims => ({
  iss: facts.issuer,
  jti: facts.jti,
  iat: Math.floor(facts.now.getTime() / 1000),
  exp: Math.floor(
    ticketExpiresAt({
      endsOn: facts.eventEndsOn,
      graceDays: facts.graceDays,
      requested: facts.validUntil,
    }).getTime() / 1000,
  ),
  ticket_type: facts.ticketType,
  subject: { identifier: { system: facts.ihiSystem, value: facts.ihi } },
  smart_scopes: usableScopes(facts.scopes).join(" "),
  muster_event: facts.eventSlug,
});

/**
 * Decides a mint and, when it is granted, builds the claims.
 *
 * One entry point rather than two, because a caller that built the claims first
 * and asked permission afterwards would have already produced the artefact it was
 * not allowed to produce.
 *
 * @param facts - everything the decision and the claims need
 * @returns the claims and the expiry, or the refusal to report
 * @example
 * ```ts
 * const result = mintTicket(facts);
 * if (!result.ok) {
 *   throw refusalError(result.refusal);
 * }
 * const jwt = await signJws(key, { ...result.claims });
 * ```
 */
export const mintTicket = (facts: TicketMintFacts): TicketMintResult => {
  const decision = authoriseTicketMint(facts);
  if (!decision.ok) {
    return decision;
  }
  return {
    ok: true,
    claims: ticketClaims(facts),
    expiresAt: ticketExpiresAt({
      endsOn: facts.eventEndsOn,
      graceDays: facts.graceDays,
      requested: facts.validUntil,
    }),
  };
};
