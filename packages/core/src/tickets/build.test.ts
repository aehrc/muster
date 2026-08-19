import { describe, expect, test } from "bun:test";

import {
  authoriseTicketMint,
  mintTicket,
  ticketClaims,
  ticketExpiresAt,
  ticketTypes,
} from "./build.ts";
import { vouchingExpiresAt } from "../statements/build.ts";

import type { TicketMintFacts } from "./build.ts";

/**
 * The permission ticket's claims and the rules for minting one.
 *
 * The claim names, the subject shape and the validity rules here are
 * `contracts/ticket-profile.md`, which follows the SMART Permission Tickets draft
 * 0.1.0. A data holder validates what these functions produce, so each claim is
 * asserted by name rather than sampled: renaming one is renaming a field in an
 * interoperability contract.
 *
 * Minting a ticket is a vouching action, so the other half of this suite is the
 * deny-by-default boundary (FR-025, FR-033): an unapproved, unverified or revoked
 * member, an event that is not open, a persona belonging to another event, and
 * constraints that say nothing are each refused with their own reason.
 *
 * The subject is bound by IHI and by nothing else, because the IHI is the only
 * identifier that means the same thing at two participants' servers (FR-031).
 */

/** The event's last day, which caps every ticket in this suite. */
const endsOn = "2026-09-03";

/** The grace period the event allows beyond its last day. */
const graceDays = 7;

/** Everything a mint needs, with every condition satisfied. */
const facts: TicketMintFacts = {
  issuer: "https://muster.example.org",
  member: {
    status: "approved",
    emailVerifiedAt: new Date("2026-08-01T00:00:00Z"),
    isAdmin: false,
  },
  eventStatus: "open",
  eventSlug: "sparked-2026-09",
  eventEndsOn: endsOn,
  graceDays,
  personaInEvent: true,
  ticketType: "patient-self-access",
  ihiSystem: "http://ns.electronichealth.net.au/id/hi/ihi/1.0",
  ihi: "8003608500314687",
  scopes: ["patient/Patient.rs", "patient/Observation.rs"],
  validUntil: null,
  jti: "01J000000000000000000T",
  now: new Date("2026-09-01T09:30:00Z"),
};

// Mints with the happy-path facts, overridden as the test needs.
const mint = (overrides: Partial<TicketMintFacts> = {}) =>
  mintTicket({ ...facts, ...overrides });

// Mints and asserts it was granted, answering the claims.
const claimsOf = (overrides: Partial<TicketMintFacts> = {}) => {
  const result = mint(overrides);
  if (!result.ok) {
    throw new Error(`Expected a mint, refused: ${result.refusal.detail}`);
  }
  return result.claims;
};

// Mints and asserts it was refused, answering the refusal.
const refusalOf = (overrides: Partial<TicketMintFacts>) => {
  const result = mint(overrides);
  if (result.ok) {
    throw new Error("Expected a refusal, but the ticket was minted");
  }
  return result.refusal;
};

describe("the permission ticket's claims", () => {
  // The whole claim set the profile's table states, by name. A data holder
  // matches on these, so every one of them is asserted rather than sampled.
  test("carries every claim the ticket profile states", () => {
    const claims = claimsOf();

    expect(claims).toEqual({
      iss: "https://muster.example.org",
      jti: facts.jti,
      iat: Math.floor(facts.now.getTime() / 1000),
      exp: Math.floor(
        vouchingExpiresAt({ endsOn, graceDays }).getTime() / 1000,
      ),
      ticket_type: "patient-self-access",
      subject: {
        identifier: {
          system: "http://ns.electronichealth.net.au/id/hi/ihi/1.0",
          value: "8003608500314687",
        },
      },
      smart_scopes: "patient/Patient.rs patient/Observation.rs",
      muster_event: "sparked-2026-09",
    });
  });

  // The subject is an identifier, under the configured IHI system: a data holder
  // resolves it against its own patients, so a name would resolve to nothing.
  test("binds the subject by IHI under the configured system", () => {
    const claims = claimsOf({
      ihi: "8003608833357361",
      ihiSystem: "http://example.org/id/ihi",
    });

    expect(claims.subject.identifier).toEqual({
      system: "http://example.org/id/ihi",
      value: "8003608833357361",
    });
  });

  // The scope constraints travel space-separated, as the profile states, and in
  // the order the member chose them.
  test("states the scope constraints as a space-separated list", () => {
    const claims = claimsOf({
      scopes: ["patient/Patient.rs", "patient/Condition.rs"],
    });

    expect(claims.smart_scopes).toBe("patient/Patient.rs patient/Condition.rs");
  });

  // Surrounding space and blank entries are the console's, not the member's: a
  // ticket carrying an empty scope would be a constraint nothing can satisfy.
  test("drops blank scope entries and trims the rest", () => {
    const claims = claimsOf({
      scopes: [" patient/Patient.rs ", "", "  ", "patient/Observation.rs"],
    });

    expect(claims.smart_scopes).toBe(
      "patient/Patient.rs patient/Observation.rs",
    );
  });

  // Only the patient self-access type is in scope, and the vocabulary says so in
  // one place so that a second type is one module's change.
  test("names patient self-access as the only ticket type in scope", () => {
    expect(ticketTypes).toEqual(["patient-self-access"]);
  });

  // The event slug scopes the ticket, exactly as it scopes a software statement:
  // a data holder may pin the events it accepts.
  test("scopes the ticket to the event it was minted for", () => {
    expect(claimsOf({ eventSlug: "another-event" }).muster_event).toBe(
      "another-event",
    );
  });
});

describe("the validity a ticket is capped at", () => {
  // FR-033 and acceptance scenario 5: the ceiling is the event's end plus its
  // grace period, and a member asking for longer gets the ceiling.
  test("caps a longer request at the event's end plus its grace days", () => {
    expect(
      ticketExpiresAt({
        endsOn,
        graceDays,
        requested: new Date("2027-01-01T00:00:00Z"),
      }),
    ).toEqual(vouchingExpiresAt({ endsOn, graceDays }));
  });

  // A member who wants a short-lived ticket gets one: the cap is a ceiling, not
  // a fixed lifetime.
  test("honours a request that ends before the ceiling", () => {
    const requested = new Date("2026-09-01T17:00:00Z");

    expect(ticketExpiresAt({ endsOn, graceDays, requested })).toEqual(
      requested,
    );
  });

  // Nothing requested is the ceiling, because a ticket with no expiry is not a
  // ticket this profile describes.
  test("falls back to the ceiling when nothing is requested", () => {
    expect(ticketExpiresAt({ endsOn, graceDays, requested: null })).toEqual(
      vouchingExpiresAt({ endsOn, graceDays }),
    );
  });

  // The same instant a statement is capped at, from the same function: two
  // modules computing a cap separately is a cap that will disagree with itself.
  test("expires a minted ticket at the capped instant", () => {
    const result = mint({ validUntil: new Date("2027-01-01T00:00:00Z") });
    if (!result.ok) {
      throw new Error(`Expected a mint, refused: ${result.refusal.detail}`);
    }

    expect(result.expiresAt).toEqual(vouchingExpiresAt({ endsOn, graceDays }));
    expect(result.claims.exp).toBe(
      Math.floor(vouchingExpiresAt({ endsOn, graceDays }).getTime() / 1000),
    );
  });

  // An event whose grace period has already run out cannot be minted for at all,
  // rather than yielding a ticket that expired before it was shown.
  test("refuses to mint once the event's grace period has passed", () => {
    const refusal = refusalOf({ now: new Date("2026-09-20T00:00:00Z") });

    expect(refusal.reason).toBe("vouching_expired");
    expect(refusal.detail).toContain("sparked-2026-09");
  });

  // A requested expiry in the past is the member's own mistake, and is refused
  // with the reason rather than silently widened to the ceiling.
  test("refuses a requested expiry that has already passed", () => {
    const refusal = refusalOf({
      validUntil: new Date("2026-08-30T00:00:00Z"),
    });

    expect(refusal.reason).toBe("invalid_metadata");
    expect(refusal.detail).toContain("already");
  });
});

describe("who may mint a permission ticket", () => {
  // Acceptance scenario 4, and the constitution: minting is deny by default, and
  // each condition is refused with its own reason so the member is told which one
  // they failed.
  test("refuses a revoked account", () => {
    const refusal = refusalOf({
      member: { ...facts.member, status: "revoked" },
    });

    expect(refusal.reason).toBe("revoked");
  });

  test("refuses an account that is not approved yet", () => {
    const refusal = refusalOf({
      member: { ...facts.member, status: "pending" },
    });

    expect(refusal.reason).toBe("not_approved");
  });

  test("refuses an account whose address is not verified", () => {
    const refusal = refusalOf({
      member: { ...facts.member, emailVerifiedAt: null },
    });

    expect(refusal.reason).toBe("not_verified");
  });

  // A closed event mints nothing (FR-011): the playground is for the event that
  // is running.
  test("refuses a closed event", () => {
    const refusal = refusalOf({ eventStatus: "closed" });

    expect(refusal.reason).toBe("event_not_open");
  });

  test("refuses an event that is still a draft", () => {
    const refusal = refusalOf({ eventStatus: "draft" });

    expect(refusal.reason).toBe("event_not_open");
  });

  // A persona curated for another event is not this event's test patient, so a
  // ticket scoped to this event must not name it.
  test("refuses a persona that belongs to another event", () => {
    const refusal = refusalOf({ personaInEvent: false });

    expect(refusal.reason).toBe("not_in_event");
  });

  // Absent or ambiguous input is a refusal, never a default: a ticket with no
  // constraint would be a ticket granting whatever the holder asks for.
  test("refuses a ticket with no scope constraint", () => {
    const refusal = refusalOf({ scopes: [] });

    expect(refusal.reason).toBe("invalid_metadata");
    expect(refusal.detail).toContain("scope");
  });

  test("refuses a ticket whose scopes are all blank", () => {
    const refusal = refusalOf({ scopes: ["", "   "] });

    expect(refusal.reason).toBe("invalid_metadata");
  });

  // The subject is the whole point of the artefact, so an absent IHI is refused
  // rather than minted as an unbound subject.
  test("refuses a subject with no IHI", () => {
    const refusal = refusalOf({ ihi: "  " });

    expect(refusal.reason).toBe("no_ihi");
  });

  // A type outside the vocabulary is refused, so a caller cannot mint a ticket
  // shape Muster has not published a profile for.
  test("refuses a ticket type outside the profile's vocabulary", () => {
    const refusal = refusalOf({ ticketType: "provider-access" });

    expect(refusal.reason).toBe("invalid_metadata");
    expect(refusal.detail).toContain("patient-self-access");
  });

  test("refuses a ticket with no identifier of its own", () => {
    const refusal = refusalOf({ jti: "" });

    expect(refusal.reason).toBe("invalid_metadata");
  });

  // The decision is available without the claims, for a caller that wants to
  // know whether it may mint before it builds anything.
  test("authorises the happy path on its own", () => {
    expect(authoriseTicketMint(facts)).toEqual({ ok: true });
  });

  // And the claims are available without the decision, for the same reason the
  // statement module separates them: content is not permission.
  test("builds claims without deciding anything", () => {
    expect(ticketClaims(facts).ticket_type).toBe("patient-self-access");
  });
});
