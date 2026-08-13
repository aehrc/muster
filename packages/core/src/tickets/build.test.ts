/**
 * What a permission ticket claims, and who is allowed to cause one to exist.
 *
 * The claim vocabulary is checked against `contracts/ticket-profile.md` member by member,
 * because that table is what Signet's `002-trusted-dcr-tickets` reads: a renamed claim here
 * is a breaking change to somebody else's product, and a test that only checked "there is a
 * subject somewhere" would not catch it.
 *
 * The expiry cases are the ones worth reading first. FR-033 caps validity at the event's end
 * plus its grace, and the way that is guaranteed is by *deriving* the expiry rather than
 * validating a number a request supplied - so the cases ask what happens when a member asks
 * for longer, and the answer is the cap rather than a refusal.
 *
 * Author: John Grimes
 */

import { describe, expect, it } from "bun:test";

import {
  buildPermissionTicketClaims,
  isPatientCompartmentScope,
  isPermissionTicketType,
  permissionTicketRefusal,
  ticketExpirySeconds,
  PERMISSION_TICKET_TYPES,
} from "./build.js";

import type {
  PermissionTicketInput,
  PermissionTicketRequest,
} from "./build.js";

/** The IHI namespace the programme binds a subject by. */
const IHI_SYSTEM = "http://ns.electronichealth.net.au/id/hi/ihi/1.0";

/** The quickstart's persona. */
const CHARLOTTE_IHI = "8003608500314687";

/** The quickstart's scope constraints. */
const SCOPES = ["patient/Patient.rs", "patient/Observation.rs"] as const;

/** A mint during the event, with everything the quickstart uses. */
function mintInput(
  overrides: Partial<PermissionTicketInput> = {},
): PermissionTicketInput {
  return {
    issuer: "https://muster.example.org",
    jti: "9c1e4f52-3f0b-4a7d-8f6e-2d5b7a91c044",
    eventSlug: "sparked-2026-09",
    eventEndsOn: "2026-09-19",
    graceDays: 7,
    ticketType: "patient-self-access",
    ihi: CHARLOTTE_IHI,
    ihiSystem: IHI_SYSTEM,
    scopes: [...SCOPES],
    validUntil: null,
    now: new Date("2026-09-15T04:00:00.000Z"),
    ...overrides,
  };
}

/** An approved member minting during an open event. */
function mintRequest(
  overrides: Partial<PermissionTicketRequest> = {},
): PermissionTicketRequest {
  return {
    standing: {
      status: "approved",
      emailVerifiedAt: new Date("2026-08-01T00:00:00.000Z"),
    },
    eventStatus: "open",
    eventEndsOn: "2026-09-19",
    graceDays: 7,
    ticketType: "patient-self-access",
    ihi: CHARLOTTE_IHI,
    scopes: [...SCOPES],
    validUntil: null,
    now: new Date("2026-09-15T04:00:00.000Z"),
    ...overrides,
  };
}

describe("the ticket type vocabulary", () => {
  // The spec's assumptions put only patient self-access in scope, so the list is one long
  // and anything else is refused rather than passed through to a signed artefact.
  it("holds exactly the one type the spec puts in scope", () => {
    expect([...PERMISSION_TICKET_TYPES]).toEqual(["patient-self-access"]);
  });

  it("recognises the patient self-access type", () => {
    expect(isPermissionTicketType("patient-self-access")).toBe(true);
  });

  it("refuses a type nobody has specified", () => {
    expect(isPermissionTicketType("clinician-access")).toBe(false);
  });
});

describe("the claim set", () => {
  // Every member of `contracts/ticket-profile.md`'s table, spelled as the contract spells
  // it. This is the vendor-facing shape.
  it("carries exactly the claims the contract tabulates", () => {
    expect(
      Object.keys(buildPermissionTicketClaims(mintInput())).toSorted(),
    ).toEqual([
      "exp",
      "iat",
      "iss",
      "jti",
      "muster_event",
      "smart_scopes",
      "subject",
      "ticket_type",
    ]);
  });

  it("issues from the deployment's public URL and names the event", () => {
    const claims = buildPermissionTicketClaims(mintInput());
    expect(claims.iss).toBe("https://muster.example.org");
    expect(claims.muster_event).toBe("sparked-2026-09");
    expect(claims.jti).toBe("9c1e4f52-3f0b-4a7d-8f6e-2d5b7a91c044");
    expect(claims.ticket_type).toBe("patient-self-access");
  });

  // FR-033: the subject is bound by IHI, which is a system and a value rather than a value
  // on its own. A sixteen-digit string with no namespace names nothing.
  it("binds the subject by IHI system and value", () => {
    expect(buildPermissionTicketClaims(mintInput()).subject).toEqual({
      identifier: { system: IHI_SYSTEM, value: CHARLOTTE_IHI },
    });
  });

  // Space-separated, as OAuth spells a scope list and as the contract's table says.
  it("states the scope constraints as a space-separated list", () => {
    expect(buildPermissionTicketClaims(mintInput()).smart_scopes).toBe(
      "patient/Patient.rs patient/Observation.rs",
    );
  });

  it("stamps the mint time in whole seconds", () => {
    expect(buildPermissionTicketClaims(mintInput()).iat).toBe(
      Math.floor(Date.parse("2026-09-15T04:00:00.000Z") / 1000),
    );
  });
});

describe("the validity cap (FR-033, scenario 5)", () => {
  // An event ending on the 19th with seven days of grace covers the whole of the 26th, so
  // the expiry is the midnight that begins the 27th - the same arithmetic a software
  // statement uses, so the two artefacts cannot disagree about when an event is over.
  it("expires at the event's end plus its grace when nothing narrower is asked for", () => {
    expect(ticketExpirySeconds("2026-09-19", 7, null)).toBe(
      Date.parse("2026-09-27T00:00:00.000Z") / 1000,
    );
  });

  // The whole of the requested last day is covered, which is what a date on a form means.
  it("honours a validity narrower than the cap", () => {
    expect(ticketExpirySeconds("2026-09-19", 7, "2026-09-16")).toBe(
      Date.parse("2026-09-17T00:00:00.000Z") / 1000,
    );
  });

  // Derived, not validated: there is no path by which a longer validity could be obtained,
  // because nothing here reads the request's number except to take the smaller of the two.
  it("caps a validity beyond the event's grace at the cap", () => {
    expect(ticketExpirySeconds("2026-09-19", 7, "2027-01-01")).toBe(
      Date.parse("2026-09-27T00:00:00.000Z") / 1000,
    );
  });

  it("caps a validity beyond the cap even with no grace at all", () => {
    expect(ticketExpirySeconds("2026-09-19", 0, "2026-12-25")).toBe(
      Date.parse("2026-09-20T00:00:00.000Z") / 1000,
    );
  });

  it("refuses an event end that is not a calendar date", () => {
    expect(() => ticketExpirySeconds("the nineteenth", 7, null)).toThrow(
      TypeError,
    );
  });

  it("refuses a requested validity that is not a calendar date", () => {
    expect(() => ticketExpirySeconds("2026-09-19", 7, "next Tuesday")).toThrow(
      TypeError,
    );
  });

  // The built claims use the same derivation, so the artefact cannot outlive the cap.
  it("puts the capped expiry in the claims", () => {
    const claims = buildPermissionTicketClaims(
      mintInput({ validUntil: "2027-06-01" }),
    );
    expect(claims.exp).toBe(Date.parse("2026-09-27T00:00:00.000Z") / 1000);
    expect(claims.exp).toBeGreaterThan(claims.iat);
  });
});

describe("which scopes may constrain a patient self-access ticket", () => {
  it("accepts patient-compartment resource scopes", () => {
    expect(isPatientCompartmentScope("patient/Patient.rs")).toBe(true);
    expect(isPatientCompartmentScope("patient/Observation.rs")).toBe(true);
    expect(isPatientCompartmentScope("patient/*.rs")).toBe(true);
  });

  it("accepts the version 1 spellings of the same permissions", () => {
    expect(isPatientCompartmentScope("patient/Patient.read")).toBe(true);
    expect(isPatientCompartmentScope("patient/Observation.*")).toBe(true);
  });

  // The ticket says "this patient permits access to their own record". A scope outside the
  // patient compartment is not that, whoever asked for it.
  it("refuses scopes outside the patient compartment", () => {
    expect(isPatientCompartmentScope("system/*.cruds")).toBe(false);
    expect(isPatientCompartmentScope("user/Patient.rs")).toBe(false);
    expect(isPatientCompartmentScope("openid")).toBe(false);
  });

  it("refuses something that is not a scope at all", () => {
    expect(isPatientCompartmentScope("patient/Patient")).toBe(false);
    expect(isPatientCompartmentScope("")).toBe(false);
  });
});

describe("who may mint (FR-033, scenario 4)", () => {
  it("permits an approved member during an open event", () => {
    expect(permissionTicketRefusal(mintRequest())).toBeUndefined();
  });

  // Scenario 4, and the reason the rule is here rather than in the route: a revoked member
  // gets no ticket, whatever else is true of the request.
  it("refuses a revoked member", () => {
    expect(
      permissionTicketRefusal(
        mintRequest({
          standing: {
            status: "revoked",
            emailVerifiedAt: new Date("2026-08-01T00:00:00.000Z"),
          },
        }),
      ),
    ).toBe("revoked_member");
  });

  it("refuses an account still awaiting approval", () => {
    expect(
      permissionTicketRefusal(
        mintRequest({
          standing: {
            status: "pending",
            emailVerifiedAt: new Date("2026-08-01T00:00:00.000Z"),
          },
        }),
      ),
    ).toBe("awaiting_approval");
  });

  it("refuses an account that has not verified its address", () => {
    expect(
      permissionTicketRefusal(
        mintRequest({
          standing: { status: "approved", emailVerifiedAt: null },
        }),
      ),
    ).toBe("email_unverified");
  });

  it("refuses a closed event", () => {
    expect(
      permissionTicketRefusal(mintRequest({ eventStatus: "closed" })),
    ).toBe("event_not_open");
  });

  it("refuses a draft event", () => {
    expect(permissionTicketRefusal(mintRequest({ eventStatus: "draft" }))).toBe(
      "event_not_open",
    );
  });

  // Standing is answered before anything about the request, because nothing about a revoked
  // account is fixed by editing a scope.
  it("reports the standing rather than the request when both are wrong", () => {
    expect(
      permissionTicketRefusal(
        mintRequest({
          standing: {
            status: "revoked",
            emailVerifiedAt: new Date("2026-08-01T00:00:00.000Z"),
          },
          scopes: [],
        }),
      ),
    ).toBe("revoked_member");
  });
});

describe("what may be minted", () => {
  it("refuses a ticket type nobody has specified", () => {
    expect(
      permissionTicketRefusal(mintRequest({ ticketType: "clinician-access" })),
    ).toBe("unknown_ticket_type");
  });

  // A ticket bound to an empty identifier is bound to nothing, and a data holder resolving
  // it would either match everybody or nobody.
  it("refuses a subject with no identifier value", () => {
    expect(permissionTicketRefusal(mintRequest({ ihi: "   " }))).toBe(
      "no_subject_identifier",
    );
  });

  it("refuses a ticket with no scope constraints at all", () => {
    expect(permissionTicketRefusal(mintRequest({ scopes: [] }))).toBe(
      "no_scopes",
    );
  });

  it("refuses a scope outside the patient compartment", () => {
    expect(
      permissionTicketRefusal(
        mintRequest({ scopes: ["patient/Patient.rs", "system/*.cruds"] }),
      ),
    ).toBe("not_a_patient_scope");
  });

  // A mint after the event's grace has run out would produce a ticket that expired at the
  // moment it was signed, which is not a thing to hand anybody.
  it("refuses once the event's grace period has passed", () => {
    expect(
      permissionTicketRefusal(
        mintRequest({ now: new Date("2026-09-27T00:00:01.000Z") }),
      ),
    ).toBe("ticket_window_closed");
  });

  it("refuses a requested validity that has already passed", () => {
    expect(
      permissionTicketRefusal(
        mintRequest({
          validUntil: "2026-09-10",
          now: new Date("2026-09-15T04:00:00.000Z"),
        }),
      ),
    ).toBe("validity_in_the_past");
  });

  // The event's own window is reported ahead of the member's date, because the second is
  // something they can fix by editing the form and the first is not.
  it("reports the closed event window ahead of the requested date", () => {
    expect(
      permissionTicketRefusal(
        mintRequest({
          validUntil: "2026-09-10",
          now: new Date("2026-10-01T00:00:00.000Z"),
        }),
      ),
    ).toBe("ticket_window_closed");
  });

  it("permits a validity that ends today", () => {
    expect(
      permissionTicketRefusal(
        mintRequest({
          validUntil: "2026-09-15",
          now: new Date("2026-09-15T04:00:00.000Z"),
        }),
      ),
    ).toBeUndefined();
  });
});
