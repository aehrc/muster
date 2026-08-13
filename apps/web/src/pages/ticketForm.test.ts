/**
 * What the ticket playground offers and claims.
 *
 * The support rows are the ones worth reading: FR-034 says the console surfaces which
 * enrolled servers advertise ticket support *as observed by verification checks*, and the
 * three states a reader has to be able to tell apart are "it said yes", "it said nothing"
 * and "nobody has asked". A page that collapsed the last two would blame a server nobody has
 * looked at.
 *
 * Author: John Grimes
 */

import { describe, expect, it } from "bun:test";

import {
  chosenScopes,
  ticketSupport,
  validityCapDay,
  SUGGESTED_SCOPES,
} from "./ticketForm.js";

import type { EnrolledSystem } from "@muster/contracts";

/** An enrolled entry, with only what these functions read filled in. */
function system(overrides: Partial<EnrolledSystem>): EnrolledSystem {
  return {
    systemId: "11111111-1111-4111-8111-111111111111",
    enrolmentId: "22222222-2222-4222-8222-222222222222",
    name: "Signet + Pathling",
    description: null,
    organisation: { id: "33333333-3333-4333-8333-333333333333", name: "CSIRO" },
    kinds: ["server"],
    serverProfile: null,
    clientProfile: null,
    tags: [],
    confirmedAt: "2026-09-01T00:00:00.000Z",
    check: null,
    dcrVerified: null,
    ...overrides,
  } as EnrolledSystem;
}

/** A latest check that found these ticket types advertised. */
function checked(types: readonly string[]): EnrolledSystem["check"] {
  return {
    checkedAt: "2026-09-15T12:04:00.000Z",
    reachable: true,
    failureMode: null,
    detail: null,
    driftFlags: [],
    lastSuccessAt: "2026-09-15T12:04:00.000Z",
    permissionTicketTypesSupported: types,
  };
}

describe("the scopes a mint asks for", () => {
  it("offers the quickstart's pair first", () => {
    expect(SUGGESTED_SCOPES.slice(0, 2)).toEqual([
      "patient/Patient.rs",
      "patient/Observation.rs",
    ]);
  });

  it("sends the ticked scopes", () => {
    expect(
      chosenScopes(["patient/Patient.rs", "patient/Observation.rs"], ""),
    ).toEqual(["patient/Patient.rs", "patient/Observation.rs"]);
  });

  it("adds whatever was typed beside them", () => {
    expect(chosenScopes(["patient/Patient.rs"], "patient/Goal.rs")).toEqual([
      "patient/Patient.rs",
      "patient/Goal.rs",
    ]);
  });

  // Ticking a box that is already typed must not put the scope in the claim twice.
  it("does not repeat a scope that is both ticked and typed", () => {
    expect(
      chosenScopes(
        ["patient/Patient.rs"],
        "patient/Patient.rs patient/Goal.rs",
      ),
    ).toEqual(["patient/Patient.rs", "patient/Goal.rs"]);
  });

  it("ignores stray whitespace and newlines in the typed field", () => {
    expect(
      chosenScopes([], "  patient/Goal.rs\n  patient/Device.rs  "),
    ).toEqual(["patient/Goal.rs", "patient/Device.rs"]);
  });

  it("sends nothing when nothing was chosen", () => {
    expect(chosenScopes([], "   ")).toEqual([]);
  });
});

describe("the validity the date picker offers (FR-033)", () => {
  // The whole of the 26th is covered by an event ending on the 19th with seven days of
  // grace, so the 26th is the last day worth offering.
  it("stops at the event's last day plus its grace", () => {
    expect(validityCapDay("2026-09-19", 7)).toBe("2026-09-26");
  });

  it("stops at the event's last day when there is no grace", () => {
    expect(validityCapDay("2026-09-19", 0)).toBe("2026-09-19");
  });

  it("crosses a month boundary correctly", () => {
    expect(validityCapDay("2026-09-28", 7)).toBe("2026-10-05");
  });

  it("offers nothing for an end date it cannot read", () => {
    expect(validityCapDay("the nineteenth", 7)).toBeUndefined();
  });
});

describe("where the ticket can be used (FR-034, scenario 3)", () => {
  it("marks a server that advertises the type as supported", () => {
    const rows = ticketSupport(
      [system({ check: checked(["patient-self-access"]) })],
      "patient-self-access",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.supported).toBe(true);
    expect(rows[0]?.label).toBe("Supported");
    expect(rows[0]?.detail).toContain("patient-self-access");
  });

  it("marks a server that advertises a different type as unsupported", () => {
    const rows = ticketSupport(
      [system({ check: checked(["care-team-access"]) })],
      "patient-self-access",
    );
    expect(rows[0]?.supported).toBe(false);
    expect(rows[0]?.detail).toContain("Advertises only care-team-access");
  });

  it("says a checked server advertises none rather than that it refuses", () => {
    const rows = ticketSupport(
      [system({ check: checked([]) })],
      "patient-self-access",
    );
    expect(rows[0]?.supported).toBe(false);
    expect(rows[0]?.detail).toContain("advertises no");
  });

  // The third state: nobody has looked. Not the same claim as "it does not support this".
  it("says a server nobody has checked has not been checked", () => {
    const rows = ticketSupport([system({})], "patient-self-access");
    expect(rows[0]?.supported).toBe(false);
    expect(rows[0]?.detail).toBe(
      "No verification check has run against this server yet.",
    );
  });

  // A client holds no patients, so a ticket presented to one would release nothing.
  it("leaves clients out of the list", () => {
    expect(
      ticketSupport(
        [system({ kinds: ["client"], name: "A patient app" })],
        "patient-self-access",
      ),
    ).toEqual([]);
  });

  it("keeps an entry that is both a client and a server", () => {
    const rows = ticketSupport(
      [
        system({
          kinds: ["server", "client"],
          check: checked(["patient-self-access"]),
        }),
      ],
      "patient-self-access",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.supported).toBe(true);
  });

  it("names the organisation, so two systems with one name can be told apart", () => {
    const rows = ticketSupport([system({})], "patient-self-access");
    expect(rows[0]?.organisationName).toBe("CSIRO");
    expect(rows[0]?.systemName).toBe("Signet + Pathling");
  });
});
