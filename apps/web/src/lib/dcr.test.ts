import { describe, expect, test } from "bun:test";

import {
  acceptsVouching,
  claimDetails,
  describeRun,
  mayRegister,
  runOperation,
  stepClass,
  whyNoRun,
} from "./dcr.ts";

import type {
  DcrRunResponse,
  PairingSummary,
  StatementClaims,
} from "@muster/contracts";

/**
 * What the registration screen decides before it renders.
 *
 * Two things are being kept honest here. The screen offers the run only when the
 * server would accept one - which takes both the shared state machine and the
 * server's registration mode, since a server that registers by hand refuses a
 * vouched registration whatever state the pairing is in; and a run whose server
 * refused is reported as a failure even though
 * the request that carried it succeeded, because the operation the member started
 * was "register this client", not "send a request" (FR-037).
 */

// A pairing in the state the tests vary.
const pairing = (overrides: Partial<PairingSummary> = {}): PairingSummary => ({
  id: "pairing-1",
  eventSlug: "sparked-2026-09",
  eventStatus: "open",
  state: "requested",
  client: {
    enrolmentId: "client-enrolment",
    systemId: "client-system",
    systemName: "Smart Forms",
    organisation: { id: "csiro", name: "CSIRO" },
  },
  server: {
    enrolmentId: "server-enrolment",
    systemId: "server-system",
    systemName: "Stub Auth",
    organisation: { id: "vendor", name: "Stub Vendor" },
  },
  registrationMode: "trustedDcr",
  clientId: null,
  declineReason: null,
  requestedAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  sides: ["client"],
  ...overrides,
});

// The claims of a minted statement.
const claims: StatementClaims = {
  iss: "https://muster.example.org",
  sub: "client-system",
  software_id: "client-system",
  jti: "statement-1",
  iat: 1_788_000_000,
  exp: 1_788_432_000,
  muster_event: "sparked-2026-09",
  client_name: "Smart Forms",
  redirect_uris: ["https://smartforms.example.org/callback"],
  grant_types: ["authorization_code", "refresh_token"],
  token_endpoint_auth_method: "none",
  scope: "launch/patient openid",
  smart_launch_url: "https://smartforms.example.org/launch",
};

// A run, defaulting to one the server accepted.
const run = (overrides: Partial<DcrRunResponse> = {}): DcrRunResponse => ({
  pairing: {
    ...pairing({ state: "fulfilled", clientId: "stub-client-1" }),
    registrationFields: {
      clientName: "Smart Forms",
      launchUrl: "https://smartforms.example.org/launch",
      redirectUris: ["https://smartforms.example.org/callback"],
      scopes: ["launch/patient", "openid"],
      confidentiality: "public",
      launchContext: "patient",
      needsIntrospection: false,
    },
    timeline: [],
    scopeWarning: null,
    statement: null,
  },
  statement: {
    jti: "statement-1",
    keyId: "key-1",
    expiresAt: "2026-09-11T00:00:00.000Z",
    claims,
    downloadPath: "/api/pairings/pairing-1/statement",
  },
  steps: [
    { name: "Mint the software statement", outcome: "succeeded", detail: "" },
    { name: "Present it to Stub Auth", outcome: "succeeded", detail: "" },
    { name: "Record the outcome", outcome: "succeeded", detail: "" },
  ],
  clientId: "stub-client-1",
  registeredMetadata: { client_name: "Smart Forms" },
  serverError: null,
  ...overrides,
});

describe("mayRegister", () => {
  // A requested pairing at a trusted-DCR server is exactly what the run is for.
  test("offers the run on a requested pairing to the client's side", () => {
    expect(mayRegister(pairing())).toBe(true);
  });

  // A failed attempt is retried by running it again: the server route retries the
  // pairing first, so the screen offers it rather than leaving a dead end.
  test("offers the run again after a failure", () => {
    expect(mayRegister(pairing({ state: "failed" }))).toBe(true);
  });

  // The server's organisation does not drive somebody else's client's
  // registration, and a settled or lapsed pairing is not run at all.
  test("withholds the run from the server's side", () => {
    expect(mayRegister(pairing({ sides: ["server"] }))).toBe(false);
  });

  test("withholds the run from a settled pairing", () => {
    expect(mayRegister(pairing({ state: "fulfilled" }))).toBe(false);
    expect(mayRegister(pairing({ state: "declined" }))).toBe(false);
    expect(mayRegister(pairing({ state: "lapsed" }))).toBe(false);
  });

  // FR-011: a closed event vouches for nothing, so the screen does not offer it.
  test("withholds the run once the event has closed", () => {
    expect(mayRegister(pairing({ eventStatus: "closed" }))).toBe(false);
  });

  // The state machine has no registration-mode dimension, so asking it alone
  // offers a run at a server that registers by hand - which the server route
  // refuses, and whose own organisation issues the identifier. The mode is asked
  // as well, of the same rule the route asks.
  test("withholds the run from a server that registers by hand", () => {
    expect(mayRegister(pairing({ registrationMode: "manual" }))).toBe(false);
  });

  // FR-016: a server that needs no registration has nothing to register at.
  test("withholds the run from a server that needs no registration", () => {
    expect(mayRegister(pairing({ registrationMode: "open" }))).toBe(false);
  });
});

describe("acceptsVouching", () => {
  // The registration screen is about a server that takes what Muster vouches for.
  // For any other server there is nothing on that screen that is true, so the
  // screen refuses instead of describing a run that cannot happen - including when
  // it is reached by its address rather than by the link.
  test("holds for a server that asked to be trusted", () => {
    expect(acceptsVouching(pairing())).toBe(true);
    expect(acceptsVouching(pairing({ state: "fulfilled" }))).toBe(true);
  });

  test("fails for a server that registers by hand or needs no registration", () => {
    expect(acceptsVouching(pairing({ registrationMode: "manual" }))).toBe(
      false,
    );
    expect(acceptsVouching(pairing({ registrationMode: "open" }))).toBe(false);
  });
});

describe("whyNoRun", () => {
  // The reason a manual pairing has no run is the server's mode, not the
  // pairing's state, and the wording is the rule's own so the console and the
  // route say the same thing.
  test("blames the server's mode when it registers by hand", () => {
    expect(whyNoRun(pairing({ registrationMode: "manual" }))).toContain(
      "by hand",
    );
  });

  test("blames the server's mode when it needs no registration", () => {
    expect(whyNoRun(pairing({ registrationMode: "open" }))).toContain(
      "nothing to register",
    );
  });

  // A trusted-DCR pairing that has already settled has no run for a different
  // reason, and says which state it is in.
  test("blames the state when the server would have accepted a run", () => {
    expect(whyNoRun(pairing({ state: "fulfilled" }))).toContain("fulfilled");
  });
});

describe("describeRun and runOperation", () => {
  // A run the server accepted says what identifier it issued.
  test("reports a successful run with the identifier issued", () => {
    expect(describeRun(run())).toContain("stub-client-1");
    expect(runOperation(run()).state).toBe("succeeded");
  });

  // The request succeeded and the registration did not, and the screen says the
  // second thing: the member asked for a registration.
  test("reports a refused run as a failure carrying the server's error", () => {
    const refused = run({
      clientId: null,
      serverError: {
        error: "invalid_client_metadata",
        errorDescription: "redirect_uri must be https",
      },
      steps: [
        {
          name: "Mint the software statement",
          outcome: "succeeded",
          detail: "",
        },
        { name: "Present it to Stub Auth", outcome: "failed", detail: "" },
        { name: "Record the outcome", outcome: "succeeded", detail: "" },
      ],
    });

    const operation = runOperation(refused);
    expect(operation.state).toBe("failed");
    expect(describeRun(refused)).toContain("invalid_client_metadata");
    expect(describeRun(refused)).toContain("redirect_uri must be https");
  });

  // A refusal with no description of its own still reads as a sentence.
  test("reports a refusal that carried no description", () => {
    const refused = run({
      clientId: null,
      serverError: { error: "invalid_request" },
    });

    expect(describeRun(refused)).toContain("invalid_request");
  });
});

describe("stepClass", () => {
  // Each outcome is coloured distinctly, so a member scanning the list sees which
  // step failed without reading it.
  test("colours each outcome distinctly", () => {
    const classes = [
      stepClass("succeeded"),
      stepClass("failed"),
      stepClass("skipped"),
    ];

    expect(new Set(classes).size).toBe(3);
  });
});

describe("claimDetails", () => {
  // The decoded claim set, in the profile's own vocabulary: an implementer reading
  // this screen is checking the artefact against the published profile, so the
  // claim names are shown rather than translated.
  test("shows every claim under its own name", () => {
    const details = claimDetails(claims);

    expect(details.map((detail) => detail.label)).toEqual([
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
    ]);
  });

  // A claim holding a list is shown as a list, so a reader copying one redirect
  // URI can see where it ends.
  test("shows a list claim as a list", () => {
    const details = claimDetails(claims);
    const redirects = details.find(
      (detail) => detail.label === "redirect_uris",
    );

    expect(redirects?.value).toEqual(claims.redirect_uris);
  });

  // The two instants are shown as instants rather than as epoch seconds, which
  // nobody can read.
  test("shows the timestamps as instants", () => {
    const details = claimDetails(claims);

    expect(details.find((detail) => detail.label === "exp")?.value).toContain(
      new Date(claims.exp * 1000).toISOString(),
    );
  });
});
