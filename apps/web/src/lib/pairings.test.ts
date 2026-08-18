import { describe, expect, test } from "bun:test";

import {
  buildPairingRequest,
  describeTimelineEntry,
  existingPairing,
  filterPairings,
  mayTake,
  ownClients,
  pairableServers,
  pairingFormFor,
} from "./pairings.ts";

import type {
  EnrolledSystem,
  PairingEvent,
  PairingState,
  PairingSummary,
  RegistrationMode,
} from "@muster/contracts";

/**
 * What the console makes of a pairing.
 *
 * Two claims are under test. The console offers exactly the actions the server
 * would accept, because it asks the same state machine rather than restating its
 * rules; and the request form starts from the client's own record, which is what
 * FR-012 asks for and what makes a pairing request a click rather than a retyping
 * exercise.
 */

// An enrolled client, as the event view returns it.
const client = (
  overrides: {
    readonly enrolmentId?: string;
    readonly organisationId?: string;
  } = {},
): EnrolledSystem => ({
  enrolmentId: overrides.enrolmentId ?? "enrolment-client",
  tags: [],
  confirmedAt: "2026-08-18T00:00:00.000Z",
  check: null,
  organisation: { id: overrides.organisationId ?? "org-csiro", name: "CSIRO" },
  system: {
    id: "system-smart-forms",
    organisationId: overrides.organisationId ?? "org-csiro",
    name: "Smart Forms",
    description: "",
    kinds: ["client"],
    serverProfile: null,
    clientProfile: {
      launchUrl: "https://smartforms.csiro.au/launch",
      redirectUris: ["https://smartforms.csiro.au/callback"],
      scopes: ["launch/patient", "patient/Observation.rs"],
      confidentiality: "public",
      launchContext: "patient",
      needsIntrospection: false,
    },
  },
});

// An enrolled server, with the registration mode under test.
const server = (registrationMode: RegistrationMode): EnrolledSystem => ({
  enrolmentId: `enrolment-${registrationMode}`,
  tags: [],
  confirmedAt: "2026-08-18T00:00:00.000Z",
  check: null,
  organisation: { id: "org-medirecords", name: "MediRecords" },
  system: {
    id: `system-${registrationMode}`,
    organisationId: "org-medirecords",
    name: `A ${registrationMode} server`,
    description: "",
    kinds: ["server"],
    serverProfile: {
      fhirBaseUrl: "https://fhir.medirecords.example.org",
      authorizationMode: "smart",
      registrationMode,
      notes: "",
    },
    clientProfile: null,
  },
});

// A pairing, defaulting to one the reader is the server side of.
const pairing = (
  overrides: {
    readonly state?: PairingState;
    readonly sides?: readonly ("client" | "server")[];
    readonly eventStatus?: "draft" | "open" | "closed";
  } = {},
): PairingSummary => ({
  id: "pairing-1",
  eventSlug: "sparked-2026-09",
  eventStatus: overrides.eventStatus ?? "open",
  state: overrides.state ?? "requested",
  client: {
    enrolmentId: "enrolment-client",
    systemId: "system-smart-forms",
    systemName: "Smart Forms",
    organisation: { id: "org-csiro", name: "CSIRO" },
  },
  server: {
    enrolmentId: "enrolment-manual",
    systemId: "system-manual",
    systemName: "MediRecords FHIR",
    organisation: { id: "org-medirecords", name: "MediRecords" },
  },
  registrationMode: "manual",
  clientId: null,
  declineReason: null,
  requestedAt: "2026-08-18T00:00:00.000Z",
  updatedAt: "2026-08-18T00:00:00.000Z",
  sides: [...(overrides.sides ?? ["server"])],
});

describe("pairableServers", () => {
  // FR-016: an open server needs no registration, so the console does not offer a
  // request against it.
  test("offers manual and trusted-DCR servers but not open ones", () => {
    const offered = pairableServers([
      server("manual"),
      server("open"),
      server("trustedDcr"),
      client(),
    ]);

    expect(offered.map((entry) => entry.system.name)).toEqual([
      "A manual server",
      "A trustedDcr server",
    ]);
  });
});

describe("ownClients", () => {
  // A pairing is requested for one's own client, so only the reader's own
  // organisations' clients are offered.
  test("offers only the reader's own enrolled clients", () => {
    const offered = ownClients(
      [
        client(),
        client({ enrolmentId: "someone-else", organisationId: "org-other" }),
        server("manual"),
      ],
      ["org-csiro"],
    );

    expect(offered.map((entry) => entry.enrolmentId)).toEqual([
      "enrolment-client",
    ]);
  });
});

describe("pairingFormFor", () => {
  // FR-012: the field set arrives prefilled from the client's record, with the
  // lists in the shape a text area holds.
  test("prefills the form from the client's own record", () => {
    const values = pairingFormFor(client(), "enrolment-manual");

    expect(values).toEqual({
      clientEnrolmentId: "enrolment-client",
      serverEnrolmentId: "enrolment-manual",
      clientName: "Smart Forms",
      launchUrl: "https://smartforms.csiro.au/launch",
      redirectUris: "https://smartforms.csiro.au/callback",
      scopes: "launch/patient\npatient/Observation.rs",
      confidentiality: "public",
      launchContext: "patient",
      needsIntrospection: false,
    });
  });

  // A system with no client profile cannot be the client side, and the form says
  // nothing about it rather than inventing values.
  test("leaves the form empty for a system that is not a client", () => {
    const values = pairingFormFor(server("manual"), "enrolment-manual");

    expect(values.clientName).toBe("");
    expect(values.clientEnrolmentId).toBe("");
    expect(values.serverEnrolmentId).toBe("enrolment-manual");
  });
});

describe("buildPairingRequest", () => {
  // The lists are split however the person pasted them, and the result is what
  // the contract asks for.
  test("builds a request from the edited form", () => {
    const outcome = buildPairingRequest("sparked-2026-09", {
      ...pairingFormFor(client(), "b7c3f9de-6d5b-4a0e-93a8-2f1c6e4d5a70"),
      clientEnrolmentId: "0f4a1c2d-3b5e-4f60-8a91-2c3d4e5f6a7b",
      clientName: "Smart Forms (connectathon)",
      redirectUris:
        "https://smartforms.csiro.au/callback\nhttps://x.example.org/cb",
    });

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value.eventSlug).toBe("sparked-2026-09");
      expect(outcome.value.registrationFields.clientName).toBe(
        "Smart Forms (connectathon)",
      );
      expect(outcome.value.registrationFields.redirectUris).toEqual([
        "https://smartforms.csiro.au/callback",
        "https://x.example.org/cb",
      ]);
    }
  });

  // The refusal names the field, while the person is still looking at it, rather
  // than being relayed from the server.
  test("names the offending field when a redirect URI is not an https URL", () => {
    const outcome = buildPairingRequest("sparked-2026-09", {
      ...pairingFormFor(client(), "b7c3f9de-6d5b-4a0e-93a8-2f1c6e4d5a70"),
      clientEnrolmentId: "0f4a1c2d-3b5e-4f60-8a91-2c3d4e5f6a7b",
      redirectUris: "http://smartforms.csiro.au/callback",
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.issues.join(" ")).toContain("redirectUris");
    }
  });

  test("refuses a request that names no server", () => {
    const outcome = buildPairingRequest("sparked-2026-09", {
      ...pairingFormFor(client(), ""),
      clientEnrolmentId: "0f4a1c2d-3b5e-4f60-8a91-2c3d4e5f6a7b",
    });

    expect(outcome.ok).toBe(false);
  });
});

describe("mayTake", () => {
  // The server's organisation is offered the two actions it has, on a pairing that
  // is still open, in an event that is still open.
  test("offers fulfilment and decline to the server's organisation", () => {
    expect(mayTake(pairing(), "fulfil")).toBe(true);
    expect(mayTake(pairing(), "decline")).toBe(true);
  });

  // The app owner is offered neither: they asked, and the answer is not theirs to
  // give (FR-014).
  test("offers neither to the client's organisation", () => {
    expect(mayTake(pairing({ sides: ["client"] }), "fulfil")).toBe(false);
    expect(mayTake(pairing({ sides: ["client"] }), "decline")).toBe(false);
  });

  // A settled pairing offers nothing, so the console does not show a button that
  // would be refused as an illegal transition.
  test("offers nothing on a pairing that has settled", () => {
    expect(mayTake(pairing({ state: "fulfilled" }), "fulfil")).toBe(false);
    expect(mayTake(pairing({ state: "declined" }), "decline")).toBe(false);
    expect(mayTake(pairing({ state: "lapsed" }), "fulfil")).toBe(false);
  });

  // FR-011: a closed event takes nothing, whoever is asking.
  test("offers nothing once the event has closed", () => {
    expect(mayTake(pairing({ eventStatus: "closed" }), "fulfil")).toBe(false);
  });
});

describe("filterPairings", () => {
  test("shows every pairing when no state is chosen", () => {
    const pairings = [pairing(), pairing({ state: "declined" })];

    expect(filterPairings(pairings, "all")).toHaveLength(2);
  });

  test("narrows to one state", () => {
    const pairings = [pairing(), pairing({ state: "declined" })];

    expect(
      filterPairings(pairings, "declined").map((one) => one.state),
    ).toEqual(["declined"]);
  });
});

describe("existingPairing", () => {
  // FR-015: rather than sending a request that would be refused, the console can
  // offer the pairing that already exists.
  test("finds the pairing that already joins a client and a server", () => {
    const found = existingPairing(
      [pairing()],
      "enrolment-client",
      "enrolment-manual",
    );

    expect(found?.id).toBe("pairing-1");
  });

  test("finds nothing for a pair that has none", () => {
    expect(
      existingPairing([pairing()], "enrolment-client", "enrolment-other"),
    ).toBeUndefined();
  });
});

describe("describeTimelineEntry", () => {
  // An entry says who acted and for which organisation, so a member of both
  // organisations can see which side each action was taken as.
  const entry = (overrides: Partial<PairingEvent> = {}): PairingEvent => ({
    id: "event-1",
    at: "2026-08-18T01:00:00.000Z",
    fromState: "requested",
    toState: "fulfilled",
    actorDisplayName: "A Member",
    actingFor: { id: "org-medirecords", name: "MediRecords" },
    detail: { clientId: "smart-forms-test-1" },
    ...overrides,
  });

  test("names the state, the actor and the organisation acted for", () => {
    expect(describeTimelineEntry(entry())).toBe(
      "Fulfilled by A Member for MediRecords",
    );
  });

  // A lapse belongs to no organisation, because an event closing is Muster's own
  // doing rather than a party's.
  test("names no organisation for a lapse", () => {
    expect(
      describeTimelineEntry(
        entry({
          toState: "lapsed",
          actingFor: null,
          actorDisplayName: null,
          detail: { reason: "The event closed." },
        }),
      ),
    ).toBe("Lapsed");
  });
});
