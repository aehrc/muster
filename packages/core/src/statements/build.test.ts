/**
 * That the claim set is the contract's, and that vouching is refused by default.
 *
 * Two subjects, and they are the two halves of the most security-critical decision Muster
 * makes. The claim set is asserted against `contracts/registration-profile.md` claim by
 * claim, because Signet's `002-trusted-dcr-tickets` implements against that table and a
 * renamed claim here is a broken vendor integration. The refusals are asserted one at a
 * time from a request that is otherwise valid, because a deny-by-default rule that
 * accidentally short-circuits reads as working right up until the one case it lets past.
 *
 * Author: John Grimes
 */

import { describe, expect, it } from "bun:test";

import {
  buildSoftwareStatementClaims,
  dcrRunAdmissible,
  grantTypesFor,
  softwareStatementRefusal,
  tokenEndpointAuthMethodFor,
  vouchingExpirySeconds,
} from "./build.js";

import type {
  SoftwareStatementInput,
  SoftwareStatementRequest,
} from "./build.js";
import type { RegistrationFields } from "../pairing/registrationFields.js";

/** A time during the seeded event, so nothing is refused for being out of season. */
const NOW = new Date("2026-09-16T04:05:06.000Z");

/** The snapshot a pairing carries: complete, so a refusal has to come from elsewhere. */
const FIELDS: RegistrationFields = {
  clientName: "Smart Forms",
  launchUrl: "https://smartforms.csiro.au/launch",
  redirectUris: [
    "https://smartforms.csiro.au/callback",
    "https://smartforms.csiro.au/",
  ],
  scopes: ["launch", "openid", "fhirUser", "patient/Questionnaire.rs"],
  confidentiality: "public",
  launchContext: "patient",
  needsIntrospection: false,
};

/** A mint request with everything in order. Each case spoils exactly one thing. */
const REQUEST: SoftwareStatementRequest = {
  standing: { status: "approved", emailVerifiedAt: new Date("2026-08-01") },
  ownsClientSide: true,
  eventStatus: "open",
  eventEndsOn: "2026-09-19",
  graceDays: 7,
  pairingState: "requested",
  serverRegistrationMode: "trustedDcr",
  registrationEndpoint: "https://auth.example.org/register",
  fields: FIELDS,
  now: NOW,
};

/** Claim-builder input matching {@link REQUEST}. */
const INPUT: SoftwareStatementInput = {
  issuer: "https://muster.example.org",
  softwareId: "3f2a9c66-7c6f-4f0a-9d1e-1f9c5a2b8e40",
  jti: "e0a0e0ba-6d43-4f1a-8f75-2b8f4c1c9a11",
  eventSlug: "sparked-2026-09",
  eventEndsOn: "2026-09-19",
  graceDays: 7,
  fields: FIELDS,
  now: NOW,
};

describe("the software statement claim set", () => {
  it("carries every claim the registration profile tabulates", () => {
    const claims = buildSoftwareStatementClaims(INPUT);

    // The contract's table, in the contract's order. A missing claim is a server that
    // cannot register the client; a renamed one is a server that refuses the statement.
    expect(Object.keys(claims).toSorted()).toEqual(
      [
        "iss",
        "sub",
        "software_id",
        "jti",
        "iat",
        "exp",
        "muster_event",
        "client_name",
        "redirect_uris",
        "grant_types",
        "token_endpoint_auth_method",
        "scope",
        "smart_launch_url",
      ].toSorted(),
    );
  });

  it("names the anchor, the client and the event", () => {
    const claims = buildSoftwareStatementClaims(INPUT);

    expect(claims.iss).toBe("https://muster.example.org");
    // `sub` and `software_id` are the same identifier under two names, because RFC 7591
    // names the software and JWT names the subject, and they are the same thing here.
    expect(claims.sub).toBe(INPUT.softwareId);
    expect(claims.software_id).toBe(INPUT.softwareId);
    expect(claims.jti).toBe(INPUT.jti);
    expect(claims.muster_event).toBe("sparked-2026-09");
  });

  it("carries the vetted metadata as submitted", () => {
    const claims = buildSoftwareStatementClaims(INPUT);

    expect(claims.client_name).toBe("Smart Forms");
    expect(claims.redirect_uris).toEqual([
      "https://smartforms.csiro.au/callback",
      "https://smartforms.csiro.au/",
    ]);
    // Space-separated, per the contract: `scope` is one string, not an array.
    expect(claims.scope).toBe(
      "launch openid fhirUser patient/Questionnaire.rs",
    );
    expect(claims.smart_launch_url).toBe("https://smartforms.csiro.au/launch");
  });

  it("stamps the mint time from the injected clock", () => {
    const claims = buildSoftwareStatementClaims(INPUT);

    expect(claims.iat).toBe(Math.floor(NOW.getTime() / 1000));
  });

  it("expires no later than the event's end plus its grace period", () => {
    const claims = buildSoftwareStatementClaims(INPUT);

    // The event's last day is the 19th and the grace is seven days, so the vouching
    // covers the whole of the 26th and stops at midnight beginning the 27th (FR-023,
    // scenario 1).
    expect(new Date(claims.exp * 1000).toISOString()).toBe(
      "2026-09-27T00:00:00.000Z",
    );
    expect(claims.exp).toBeGreaterThan(claims.iat);
  });

  it("expires at the end of the last day when there is no grace", () => {
    const claims = buildSoftwareStatementClaims({ ...INPUT, graceDays: 0 });

    // End of the 19th, not the start of it: an event still running on its last afternoon
    // must still be able to vouch.
    expect(new Date(claims.exp * 1000).toISOString()).toBe(
      "2026-09-20T00:00:00.000Z",
    );
  });

  it("caps the expiry from the event alone, whatever the mint time", () => {
    const early = buildSoftwareStatementClaims({
      ...INPUT,
      now: new Date("2026-09-15T00:00:00.000Z"),
    });
    const late = buildSoftwareStatementClaims({
      ...INPUT,
      now: new Date("2026-09-19T23:00:00.000Z"),
    });

    // Derived rather than validated: there is no input by which a longer expiry could be
    // asked for, so the cap cannot be argued with.
    expect(early.exp).toBe(late.exp);
  });

  it("refuses an unparseable event end rather than vouching indefinitely", () => {
    expect(() => vouchingExpirySeconds("not-a-date", 7)).toThrow(
      /calendar date/,
    );
  });
});

describe("the grant types and authentication method", () => {
  it("asks for the authorization code grant alone by default", () => {
    expect(grantTypesFor(["launch", "openid"])).toEqual(["authorization_code"]);
  });

  it("adds the refresh token grant when the client asked for offline access", () => {
    expect(grantTypesFor(["launch", "offline_access"])).toEqual([
      "authorization_code",
      "refresh_token",
    ]);
  });

  it("adds it for online access too", () => {
    expect(grantTypesFor(["online_access"])).toEqual([
      "authorization_code",
      "refresh_token",
    ]);
  });

  it("authenticates a public client with nothing", () => {
    expect(tokenEndpointAuthMethodFor("public")).toBe("none");
  });

  it("authenticates a confidential client with the secret the server issues", () => {
    // `private_key_jwt` is the profile's other option and is not offered: the field set
    // carries no key for a server to verify an assertion against.
    expect(tokenEndpointAuthMethodFor("confidential")).toBe(
      "client_secret_basic",
    );
  });

  it("reflects the confidentiality in the claim set", () => {
    const claims = buildSoftwareStatementClaims({
      ...INPUT,
      fields: { ...FIELDS, confidentiality: "confidential" },
    });

    expect(claims.token_endpoint_auth_method).toBe("client_secret_basic");
  });
});

describe("whether a trusted-DCR run may be attempted", () => {
  it("admits a pairing awaiting an answer", () => {
    expect(dcrRunAdmissible("requested")).toBe(true);
  });

  it("admits a failed pairing, which is the retry", () => {
    expect(dcrRunAdmissible("failed")).toBe(true);
  });

  it.each(["fulfilled", "declined", "lapsed"] as const)(
    "refuses a %s pairing",
    (state) => {
      expect(dcrRunAdmissible(state)).toBe(false);
    },
  );
});

describe("refusing to mint", () => {
  it("mints when everything holds", () => {
    expect(softwareStatementRefusal(REQUEST)).toBeUndefined();
  });

  it("refuses a revoked member (scenario 4)", () => {
    expect(
      softwareStatementRefusal({
        ...REQUEST,
        standing: {
          status: "revoked",
          emailVerifiedAt: new Date("2026-08-01"),
        },
      }),
    ).toBe("revoked_member");
  });

  it("refuses a member awaiting approval", () => {
    expect(
      softwareStatementRefusal({
        ...REQUEST,
        standing: {
          status: "pending",
          emailVerifiedAt: new Date("2026-08-01"),
        },
      }),
    ).toBe("awaiting_approval");
  });

  it("refuses a member who has not verified their address", () => {
    expect(
      softwareStatementRefusal({
        ...REQUEST,
        standing: { status: "approved", emailVerifiedAt: null },
      }),
    ).toBe("email_unverified");
  });

  it("refuses somebody who does not own the client (FR-025)", () => {
    // Vouching for somebody else's app is not a thing a member may do for them.
    expect(
      softwareStatementRefusal({ ...REQUEST, ownsClientSide: false }),
    ).toBe("not_the_app_owner");
  });

  it.each(["draft", "closed"] as const)(
    "refuses a %s event (FR-025)",
    (eventStatus) => {
      expect(softwareStatementRefusal({ ...REQUEST, eventStatus })).toBe(
        "event_not_open",
      );
    },
  );

  it.each(["fulfilled", "declined", "lapsed"] as const)(
    "refuses a pairing that is already %s",
    (pairingState) => {
      expect(softwareStatementRefusal({ ...REQUEST, pairingState })).toBe(
        "pairing_not_open",
      );
    },
  );

  it.each(["manual", "open"] as const)(
    "refuses a server whose registration mode is %s",
    (serverRegistrationMode) => {
      expect(
        softwareStatementRefusal({ ...REQUEST, serverRegistrationMode }),
      ).toBe("not_trusted_dcr");
    },
  );

  it("refuses a trusted-DCR server that declares nowhere to present the statement", () => {
    expect(
      softwareStatementRefusal({ ...REQUEST, registrationEndpoint: null }),
    ).toBe("no_registration_endpoint");
  });

  it("refuses once the event's grace period has run out", () => {
    // A statement minted here would be expired at the moment it was signed.
    expect(
      softwareStatementRefusal({
        ...REQUEST,
        now: new Date("2026-09-27T00:00:01.000Z"),
      }),
    ).toBe("vouching_window_closed");
  });

  it("still mints in the last second of the grace period", () => {
    expect(
      softwareStatementRefusal({
        ...REQUEST,
        now: new Date("2026-09-26T23:59:59.000Z"),
      }),
    ).toBeUndefined();
  });

  it.each([
    ["no_client_name", { clientName: "  " }],
    ["no_launch_url", { launchUrl: "" }],
    ["no_redirect_uris", { redirectUris: [] }],
    ["no_scopes", { scopes: [] }],
  ] as const)(
    "refuses %s when the client's details fail validation (FR-025)",
    (expected, overrides) => {
      expect(
        softwareStatementRefusal({
          ...REQUEST,
          fields: { ...FIELDS, ...overrides },
        }),
      ).toBe(expected);
    },
  );

  it("reports the standing before anything a person could edit", () => {
    // Order matters to the reader: nothing about a revoked account is fixed by adding a
    // redirect URI, so the standing is what they are told about.
    expect(
      softwareStatementRefusal({
        ...REQUEST,
        standing: { status: "revoked", emailVerifiedAt: null },
        ownsClientSide: false,
        eventStatus: "closed",
        fields: { ...FIELDS, redirectUris: [] },
      }),
    ).toBe("revoked_member");
  });
});
