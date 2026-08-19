import {
  authoriseEventOpen,
  authoriseWrite,
  refuse,
} from "../accounts/rules.ts";

import type {
  AccountFacts,
  AuthorisationDecision,
  Refusal,
} from "../accounts/rules.ts";
import type {
  EventStatus,
  RegistrationFields,
  RegistrationMode,
} from "@muster/contracts";

/**
 * The software statement: what it claims, and when Muster will mint one.
 *
 * This is the artefact a vendor implements against. Every claim name here is
 * `contracts/registration-profile.md`, and a server validates what this module
 * produces, so the shape of a claim is an interoperability contract rather than
 * an internal detail. Muster is the trust anchor: the statement is the whole of
 * what a trusting server is asked to believe, which is why the metadata is the
 * snapshot the pairing took and not whatever the client record says today.
 *
 * Minting is a vouching action, so it is deny by default (FR-025). Six
 * conditions must each be affirmatively true - an approved, verified, unrevoked
 * account; a member of the organisation that owns the client; an open event; a
 * pairing belonging to that event; metadata that validates; and vouching that
 * has not already expired - and anything absent or ambiguous is a refusal, never
 * a default. The whole decision is a pure function of facts passed in, so the
 * route handler cannot grant a right by forgetting to ask for it.
 *
 * @author John Grimes
 */

/**
 * The claims a software statement carries, per the registration profile.
 *
 * Named in the profile's own vocabulary - snake_case, as they appear on the wire
 * - because a claim renamed on the way out is a claim the server cannot find.
 */
export type StatementClaims = {
  /** the trust anchor's issuer identifier */
  readonly iss: string;
  /** Muster's identifier for the client, as the subject vouched for */
  readonly sub: string;
  /** the same identifier, under RFC 7591's own name for it */
  readonly software_id: string;
  /** the statement identifier; a server accepts it once */
  readonly jti: string;
  /** when the statement was minted, in seconds since the epoch */
  readonly iat: number;
  /** when vouching stops, in seconds since the epoch */
  readonly exp: number;
  /** the event slug the vouching is scoped to */
  readonly muster_event: string;
  /** what the client is called */
  readonly client_name: string;
  /** the redirect URIs vouched for; at least one */
  readonly redirect_uris: readonly string[];
  /** the grant types vouched for */
  readonly grant_types: readonly string[];
  /** how the client authenticates at the token endpoint */
  readonly token_endpoint_auth_method: string;
  /** the requested scopes, space-separated */
  readonly scope: string;
  /** the app's launch URL, for servers that launch apps */
  readonly smart_launch_url: string;
};

/**
 * What building a statement's claims needs to know.
 *
 * Separate from the rest of a mint's facts because the claims are content and the
 * rest is permission. The conformance harness vouches for a throwaway client of
 * its own rather than for a pairing, so it builds claims from these facts alone;
 * having to hand {@link statementClaims} a member and a pairing it does not have
 * would mean asserting things that are not true in order to produce a document.
 */
export type StatementContentFacts = {
  /** the trust anchor's issuer identifier */
  readonly issuer: string;
  /** the event slug the vouching is scoped to */
  readonly eventSlug: string;
  /** the event's last day, as `YYYY-MM-DD` */
  readonly eventEndsOn: string;
  /** days beyond the event's end that vouching artefacts may live */
  readonly graceDays: number;
  /** Muster's identifier for the client system */
  readonly softwareId: string;
  /** the statement identifier */
  readonly jti: string;
  /** the vetted metadata, as snapshot when the pairing was requested */
  readonly fields: RegistrationFields;
  /** the moment of minting */
  readonly now: Date;
};

/** What deciding and building a mint needs to know. */
export type StatementMintFacts = StatementContentFacts & {
  /** the account asking */
  readonly member: AccountFacts;
  /** whether that account belongs to the organisation owning the client */
  readonly ownsClient: boolean;
  /** the event's status */
  readonly eventStatus: EventStatus;
  /** whether the pairing belongs to that event */
  readonly pairingInEvent: boolean;
};

/** The outcome of a mint. */
export type StatementMintResult =
  | {
      /** the mint was granted */
      readonly ok: true;
      /** the claims to sign */
      readonly claims: StatementClaims;
      /** when vouching stops, as an instant */
      readonly expiresAt: Date;
    }
  | {
      /** the mint was refused */
      readonly ok: false;
      /** why, in words fit to show the member refused */
      readonly refusal: Refusal;
    };

/** What the event's last day and grace period say about an expiry. */
export type VouchingWindow = {
  /** the event's last day, as `YYYY-MM-DD` */
  readonly endsOn: string;
  /** days beyond the event's end that vouching artefacts may live */
  readonly graceDays: number;
};

/** One day, in milliseconds. */
const oneDayMs = 24 * 60 * 60 * 1000;

/**
 * The grant types Muster vouches for.
 *
 * The authorization code flow, and the refresh that a SMART app needs to survive
 * a token expiring mid-session. Not a per-client choice: the registration field
 * set does not carry one, and inventing one per statement would put a claim in
 * the statement that no human ever reviewed.
 */
export const statementGrantTypes: readonly string[] = [
  "authorization_code",
  "refresh_token",
];

/**
 * How each confidentiality authenticates at the token endpoint.
 *
 * A public client authenticates with nothing, because it has nowhere to keep a
 * secret; a confidential one uses the secret the server issues at registration,
 * which Muster relays once and never stores.
 */
const authMethodByConfidentiality = {
  public: "none",
  confidential: "client_secret_basic",
} as const;

/**
 * The instant vouching stops for an event.
 *
 * An event ends at the close of its last day, so the window runs to midnight
 * after `endsOn` and then the whole grace period beyond it. Stated once, here,
 * because statements and permission tickets are both capped by it and a cap that
 * two modules computed separately is a cap that will eventually disagree with
 * itself.
 *
 * @param window - the event's last day and its grace days
 * @returns the instant at which artefacts for the event stop being valid
 * @example
 * ```ts
 * vouchingExpiresAt({ endsOn: "2026-09-03", graceDays: 7 });
 * // 2026-09-11T00:00:00.000Z
 * ```
 */
export const vouchingExpiresAt = (window: VouchingWindow): Date =>
  new Date(
    Date.parse(`${window.endsOn}T00:00:00.000Z`) +
      (window.graceDays + 1) * oneDayMs,
  );

/**
 * Whether the metadata is fit to vouch for.
 *
 * The profile requires a name and at least one redirect URI, and a statement
 * needs an identifier a server can de-duplicate on. These are the conditions
 * Muster is accountable for; the server's own client validation is its business
 * (profile validation rule 5).
 *
 * @param facts - the metadata, and the statement identifier
 * @returns the decision
 */
const authoriseMetadata = (
  facts: StatementMintFacts,
): AuthorisationDecision => {
  if (facts.jti.trim() === "") {
    return refuse(
      "invalid_metadata",
      "A statement needs an identifier, and none was generated.",
    );
  }
  if (facts.fields.clientName.trim() === "") {
    return refuse(
      "invalid_metadata",
      "This client has no name, so there is nothing to vouch for.",
    );
  }
  if (facts.fields.redirectUris.length === 0) {
    return refuse(
      "invalid_metadata",
      "This client declares no redirect URI, which no server can register.",
    );
  }
  return { ok: true };
};

/**
 * Decides whether a statement may be minted.
 *
 * Every condition in order, each refused with its own reason so the member is
 * told which one they failed rather than being told no.
 *
 * @param facts - the member, the client's ownership, the event, the pairing, the
 *   metadata and the clock
 * @returns the decision
 * @example
 * ```ts
 * const decision = authoriseStatementMint(facts);
 * if (!decision.ok) {
 *   throw refusalError(decision.refusal);
 * }
 * ```
 */
export const authoriseStatementMint = (
  facts: StatementMintFacts,
): AuthorisationDecision => {
  const writing = authoriseWrite(facts.member);
  if (!writing.ok) {
    return writing;
  }
  if (!facts.ownsClient) {
    return refuse(
      "not_member",
      "Muster vouches for a client on behalf of the organisation that owns it, and this account is not a member of that organisation.",
    );
  }
  const openness = authoriseEventOpen(facts.eventStatus);
  if (!openness.ok) {
    return openness;
  }
  if (!facts.pairingInEvent) {
    return refuse(
      "not_in_event",
      "That pairing belongs to another event, so it cannot be vouched for in this one.",
    );
  }
  const metadata = authoriseMetadata(facts);
  if (!metadata.ok) {
    return metadata;
  }
  const expiresAt = vouchingExpiresAt({
    endsOn: facts.eventEndsOn,
    graceDays: facts.graceDays,
  });
  if (expiresAt.getTime() <= facts.now.getTime()) {
    return refuse(
      "vouching_expired",
      `Vouching for ${facts.eventSlug} ended on ${expiresAt.toISOString().slice(0, 10)}, so a statement minted now would already have expired.`,
    );
  }
  return { ok: true };
};

/** What deciding a directory-initiated registration needs to know. */
export type DirectoryRegistrationFacts = {
  /** how the server says it registers clients */
  readonly registrationMode: RegistrationMode;
  /** where it registers them, when it declares an endpoint */
  readonly registrationEndpoint: string | null;
};

/**
 * Decides whether Muster may present a statement to a server at all.
 *
 * A server that registers by hand has not asked to be trusted, and one that needs
 * no registration has nothing to be registered at. A trusted-DCR entry with no
 * endpoint is an incomplete entry: deny by default, because the alternative is
 * guessing at a URL and posting a signed statement to it.
 *
 * @param facts - the server's registration mode and endpoint
 * @returns the decision
 * @example
 * ```ts
 * const decision = authoriseDirectoryRegistration({
 *   registrationMode: profile.registrationMode,
 *   registrationEndpoint: profile.registrationEndpoint ?? null,
 * });
 * ```
 */
export const authoriseDirectoryRegistration = (
  facts: DirectoryRegistrationFacts,
): AuthorisationDecision => {
  if (facts.registrationMode === "open") {
    return refuse(
      "registration_not_needed",
      "That server needs no registration, so there is nothing to register.",
    );
  }
  if (facts.registrationMode === "manual") {
    return refuse(
      "manual_registration",
      "That server registers clients by hand, so its own organisation issues the client identifier rather than Muster.",
    );
  }
  if (facts.registrationEndpoint === null) {
    return refuse(
      "invalid_metadata",
      "That server accepts trusted registration but declares no registration endpoint.",
    );
  }
  return { ok: true };
};

/**
 * Builds the claims of a statement, without deciding whether to.
 *
 * @param facts - the issuer, the client's identifier, the event and the metadata
 * @returns the claims, ready to sign
 * @example
 * ```ts
 * const claims = statementClaims(facts);
 * ```
 */
export const statementClaims = (
  facts: StatementContentFacts,
): StatementClaims => {
  const expiresAt = vouchingExpiresAt({
    endsOn: facts.eventEndsOn,
    graceDays: facts.graceDays,
  });
  return {
    iss: facts.issuer,
    sub: facts.softwareId,
    software_id: facts.softwareId,
    jti: facts.jti,
    iat: Math.floor(facts.now.getTime() / 1000),
    exp: Math.floor(expiresAt.getTime() / 1000),
    muster_event: facts.eventSlug,
    client_name: facts.fields.clientName,
    redirect_uris: [...facts.fields.redirectUris],
    grant_types: [...statementGrantTypes],
    token_endpoint_auth_method:
      authMethodByConfidentiality[facts.fields.confidentiality],
    scope: facts.fields.scopes.join(" "),
    smart_launch_url: facts.fields.launchUrl,
  };
};

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
 * const result = mintStatement(facts);
 * if (!result.ok) {
 *   throw refusalError(result.refusal);
 * }
 * const jws = await signStatement(result.claims);
 * ```
 */
export const mintStatement = (
  facts: StatementMintFacts,
): StatementMintResult => {
  const decision = authoriseStatementMint(facts);
  if (!decision.ok) {
    return decision;
  }
  return {
    ok: true,
    claims: statementClaims(facts),
    expiresAt: vouchingExpiresAt({
      endsOn: facts.eventEndsOn,
      graceDays: facts.graceDays,
    }),
  };
};
