import { describe, expect, test } from "bun:test";

import {
  authoriseStatementMint,
  mintStatement,
  statementGrantTypes,
  vouchingExpiresAt,
} from "./build.ts";

import type { StatementMintFacts } from "./build.ts";
import type { RegistrationFields } from "@muster/contracts";

/**
 * The software statement's claims and the rules for minting one.
 *
 * The claim names, the expiry semantics and the refusals here are
 * `contracts/registration-profile.md`, which is the artefact a vendor implements
 * against: a server validates what these functions produce, so a change in the
 * shape of a claim is a change in an interoperability contract rather than an
 * internal detail. Each claim is therefore asserted by name.
 *
 * Minting is a vouching action, so the other half of this suite is the
 * deny-by-default boundary: an unapproved, unverified or revoked member, a
 * member of another organisation, a closed event, a pairing in a different
 * event, and metadata that does not validate are each refused with their own
 * reason (FR-025).
 */

/** The vetted metadata a pairing snapshot carries. */
const fields: RegistrationFields = {
  clientName: "Smart Forms",
  launchUrl: "https://smartforms.example.org/launch",
  redirectUris: [
    "https://smartforms.example.org/callback",
    "https://smartforms.example.org/other",
  ],
  scopes: ["launch/patient", "patient/Observation.rs", "openid"],
  confidentiality: "public",
  launchContext: "patient",
  needsIntrospection: false,
};

/** Everything a mint needs, all conditions satisfied. */
const facts: StatementMintFacts = {
  issuer: "https://muster.example.org",
  member: {
    status: "approved",
    emailVerifiedAt: new Date("2026-08-01T00:00:00Z"),
    isAdmin: false,
  },
  ownsClient: true,
  eventStatus: "open",
  eventSlug: "sparked-2026-09",
  eventEndsOn: "2026-09-03",
  graceDays: 7,
  pairingInEvent: true,
  softwareId: "3f8d8b0e-0d64-4d0a-9c62-0c2a1f0f7f11",
  jti: "01J0000000000000000000",
  fields,
  now: new Date("2026-09-01T09:30:00Z"),
};

// Mints with the happy-path facts, overridden as the test needs.
const mint = (overrides: Partial<StatementMintFacts> = {}) =>
  mintStatement({ ...facts, ...overrides });

// Mints and asserts it was granted, answering the claims.
const claimsOf = (overrides: Partial<StatementMintFacts> = {}) => {
  const result = mint(overrides);
  if (!result.ok) {
    throw new Error(`Expected a mint, refused: ${result.refusal.detail}`);
  }
  return result.claims;
};

// Mints and asserts it was refused, answering the refusal.
const refusalOf = (overrides: Partial<StatementMintFacts>) => {
  const result = mint(overrides);
  if (result.ok) {
    throw new Error("Expected a refusal, but the statement was minted");
  }
  return result.refusal;
};

describe("the software statement's claims", () => {
  // The full claim set the profile's table states, by name. A server matches on
  // these, so every one of them is asserted rather than sampled.
  test("carries every claim the registration profile states", () => {
    const claims = claimsOf();

    expect(claims).toEqual({
      iss: "https://muster.example.org",
      sub: facts.softwareId,
      software_id: facts.softwareId,
      jti: facts.jti,
      iat: Math.floor(facts.now.getTime() / 1000),
      exp: Math.floor(
        vouchingExpiresAt({ endsOn: "2026-09-03", graceDays: 7 }).getTime() /
          1000,
      ),
      muster_event: "sparked-2026-09",
      client_name: "Smart Forms",
      redirect_uris: fields.redirectUris,
      grant_types: statementGrantTypes,
      token_endpoint_auth_method: "none",
      scope: "launch/patient patient/Observation.rs openid",
      smart_launch_url: fields.launchUrl,
    });
  });

  // `sub` and `software_id` are both Muster's identifier for the client, so a
  // server keyed on either resolves to the same system.
  test("identifies the client by Muster's own system identifier", () => {
    const claims = claimsOf();

    expect(claims.sub).toBe(facts.softwareId);
    expect(claims.software_id).toBe(facts.softwareId);
  });

  // A client that can keep a secret authenticates with one; a public client
  // authenticates with nothing, and must never be handed a secret to lose.
  test("states the authentication method the client's confidentiality allows", () => {
    expect(claimsOf().token_endpoint_auth_method).toBe("none");
    expect(
      claimsOf({ fields: { ...fields, confidentiality: "confidential" } })
        .token_endpoint_auth_method,
    ).toBe("client_secret_basic");
  });

  // Scopes are space-separated in the claim, as the profile states, and arrive
  // in the order the app owner asked for them.
  test("renders the requested scopes as a space-separated list", () => {
    expect(claimsOf({ fields: { ...fields, scopes: ["openid"] } }).scope).toBe(
      "openid",
    );
  });
});

describe("the vouching expiry", () => {
  // The event ends at the close of its last day, and the grace period is whole
  // days beyond that.
  test("is the end of the event's last day plus the grace days", () => {
    expect(
      vouchingExpiresAt({ endsOn: "2026-09-03", graceDays: 7 }).toISOString(),
    ).toBe("2026-09-11T00:00:00.000Z");
  });

  // No grace still leaves the whole of the last day usable.
  test("covers the whole of the last day when there is no grace", () => {
    expect(
      vouchingExpiresAt({ endsOn: "2026-09-03", graceDays: 0 }).toISOString(),
    ).toBe("2026-09-04T00:00:00.000Z");
  });

  // FR-023: the statement's expiry is the cap, whatever anybody would prefer.
  test("caps the statement's expiry", () => {
    const claims = claimsOf({ graceDays: 0 });

    expect(claims.exp).toBe(
      Math.floor(Date.parse("2026-09-04T00:00:00.000Z") / 1000),
    );
    expect(claims.exp).toBeGreaterThan(claims.iat);
  });

  // An event whose grace has already run out cannot be vouched for: the
  // statement would be born expired, which is worse than a refusal.
  test("refuses to mint once the event's grace has passed", () => {
    const refusal = refusalOf({ now: new Date("2026-09-20T00:00:00Z") });

    expect(refusal.reason).toBe("vouching_expired");
    expect(refusal.detail).toContain("sparked-2026-09");
  });
});

describe("minting a statement", () => {
  // FR-025 and the constitution: the account must be approved and verified.
  test("refuses a revoked member", () => {
    expect(
      refusalOf({ member: { ...facts.member, status: "revoked" } }).reason,
    ).toBe("revoked");
  });

  test("refuses a member awaiting approval", () => {
    expect(
      refusalOf({ member: { ...facts.member, status: "pending" } }).reason,
    ).toBe("not_approved");
  });

  test("refuses a member whose address is unverified", () => {
    expect(
      refusalOf({ member: { ...facts.member, emailVerifiedAt: null } }).reason,
    ).toBe("not_verified");
  });

  // Muster vouches for a client on behalf of the organisation that owns it, so
  // a member of some other organisation cannot ask it to.
  test("refuses a member who does not own the client", () => {
    expect(refusalOf({ ownsClient: false }).reason).toBe("not_member");
  });

  // Event scoping is the anchor's job: a closed event mints nothing.
  test("refuses a closed event", () => {
    expect(refusalOf({ eventStatus: "closed" }).reason).toBe("event_not_open");
    expect(refusalOf({ eventStatus: "draft" }).reason).toBe("event_not_open");
  });

  // The pairing must belong to the event being vouched for, or the statement
  // would scope the vouching to an event the pairing is not in.
  test("refuses a pairing that belongs to another event", () => {
    expect(refusalOf({ pairingInEvent: false }).reason).toBe("not_in_event");
  });

  // FR-025: the client's details must validate. A statement with no redirect
  // URI is one no server can honour, and the profile requires at least one.
  test("refuses metadata with no redirect URI", () => {
    expect(refusalOf({ fields: { ...fields, redirectUris: [] } }).reason).toBe(
      "invalid_metadata",
    );
  });

  test("refuses metadata with no client name", () => {
    expect(refusalOf({ fields: { ...fields, clientName: "  " } }).reason).toBe(
      "invalid_metadata",
    );
  });

  // Absent input is a refusal, never a default: an empty statement identifier
  // would produce a statement no server could de-duplicate.
  test("refuses a blank statement identifier", () => {
    expect(refusalOf({ jti: "" }).reason).toBe("invalid_metadata");
  });

  // The authorisation half is separately callable, so a route can decide whether
  // to offer the action without building the claims.
  test("decides authorisation without building the claims", () => {
    expect(authoriseStatementMint(facts).ok).toBe(true);
    expect(authoriseStatementMint({ ...facts, ownsClient: false }).ok).toBe(
      false,
    );
  });
});
