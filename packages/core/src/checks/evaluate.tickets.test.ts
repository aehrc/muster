/**
 * What a verification check learns about permission ticket support (FR-034, scenario 3).
 *
 * A separate file from `evaluate.test.ts` because the subject is different: that one is about
 * whether a server answered and whether its answer disagrees with what its owner declared,
 * and this one is about one field of the discovery document that nothing else reads.
 *
 * The point of the field is that the question "which servers accept a ticket?" is answered
 * from a recorded fact rather than by re-fetching every enrolled server when somebody opens
 * the playground. So the cases here are about *capture* - what a server said, faithfully -
 * and about the two absences that are not the same as a "no": a server that served no
 * discovery document at all, and one that served one without the field. Neither has said it
 * accepts tickets, and neither has said it does not.
 *
 * Author: John Grimes
 */

import { describe, expect, it } from "bun:test";

import {
  advertisedPermissionTicketTypes,
  evaluateCheck,
  extractDiscoveryHighlights,
  supportsPermissionTicketType,
} from "./evaluate.js";

import type { CheckFetch, DeclaredServerDetails } from "./evaluate.js";

/** What a data holder implementing the ticket profile serves. */
const TICKET_HOLDER_DISCOVERY = {
  issuer: "https://holder.example.org",
  authorization_endpoint: "https://holder.example.org/authorize",
  token_endpoint: "https://holder.example.org/token",
  scopes_supported: ["patient/Patient.rs", "patient/Observation.rs"],
  smart_permission_ticket_types_supported: ["patient-self-access"],
};

/** A perfectly ordinary SMART server that has never heard of the draft. */
const PLAIN_DISCOVERY = {
  issuer: "https://plain.example.org",
  token_endpoint: "https://plain.example.org/token",
  scopes_supported: ["patient/*.rs"],
};

/** A successful fetch of a document. */
function served(document: unknown): CheckFetch {
  return { ok: true, status: 200, body: JSON.stringify(document) };
}

/** What the owner declared about a server with a SMART front door. */
const DECLARED: DeclaredServerDetails = {
  fhirBaseUrl: "https://holder.example.org/fhir",
  authorizationMode: "smart",
};

describe("capturing smart_permission_ticket_types_supported", () => {
  it("records the types a server advertises", () => {
    expect(
      extractDiscoveryHighlights(JSON.stringify(TICKET_HOLDER_DISCOVERY))
        ?.permissionTicketTypesSupported,
    ).toEqual(["patient-self-access"]);
  });

  it("records more than one type in the order the server listed them", () => {
    expect(
      extractDiscoveryHighlights(
        JSON.stringify({
          ...TICKET_HOLDER_DISCOVERY,
          smart_permission_ticket_types_supported: [
            "patient-self-access",
            "care-team-access",
          ],
        }),
      )?.permissionTicketTypesSupported,
    ).toEqual(["patient-self-access", "care-team-access"]);
  });

  // Absence is not a denial, but it is not support either: the list is empty and the pages
  // that read it say "no support detected" rather than "does not support".
  it("records nothing for a server that does not mention the field", () => {
    expect(
      extractDiscoveryHighlights(JSON.stringify(PLAIN_DISCOVERY))
        ?.permissionTicketTypesSupported,
    ).toEqual([]);
  });

  // A string where a list belongs is the wrong shape, and reading it as a one-element list
  // would put a claim on the event view that the server did not make.
  it("records nothing when the field is not a list", () => {
    expect(
      extractDiscoveryHighlights(
        JSON.stringify({
          ...PLAIN_DISCOVERY,
          smart_permission_ticket_types_supported: "patient-self-access",
        }),
      )?.permissionTicketTypesSupported,
    ).toEqual([]);
  });

  it("drops non-string members rather than coercing them", () => {
    expect(
      extractDiscoveryHighlights(
        JSON.stringify({
          ...PLAIN_DISCOVERY,
          smart_permission_ticket_types_supported: [
            "patient-self-access",
            42,
            null,
          ],
        }),
      )?.permissionTicketTypesSupported,
    ).toEqual(["patient-self-access"]);
  });
});

describe("the whole check", () => {
  // The path the scheduler actually takes: the field arrives on the recorded check, so the
  // playground and the event view read it off a row rather than fetching anything.
  it("carries the advertised types through to the recorded check", () => {
    const evaluation = evaluateCheck({
      declared: DECLARED,
      discovery: served(TICKET_HOLDER_DISCOVERY),
      capability: { ok: false, reason: "refused", description: "no metadata" },
    });
    expect(evaluation.reachable).toBe(true);
    expect(evaluation.discovery?.permissionTicketTypesSupported).toEqual([
      "patient-self-access",
    ]);
  });

  it("carries an empty list for a server that advertises no types", () => {
    const evaluation = evaluateCheck({
      declared: { ...DECLARED, fhirBaseUrl: "https://plain.example.org/fhir" },
      discovery: served(PLAIN_DISCOVERY),
      capability: { ok: false, reason: "refused", description: "no metadata" },
    });
    expect(evaluation.discovery?.permissionTicketTypesSupported).toEqual([]);
  });

  // A server nobody could reach has said nothing at all, which is a different claim from
  // having said "no types".
  it("has no discovery to read at all for an unreachable server", () => {
    const evaluation = evaluateCheck({
      declared: DECLARED,
      discovery: { ok: false, reason: "timeout", description: "timed out" },
      capability: { ok: false, reason: "timeout", description: "timed out" },
    });
    expect(evaluation.discovery).toBeNull();
    expect(advertisedPermissionTicketTypes(evaluation.discovery)).toEqual([]);
  });
});

describe("surfacing support per server (scenario 3)", () => {
  const holder = extractDiscoveryHighlights(
    JSON.stringify(TICKET_HOLDER_DISCOVERY),
  );
  const plain = extractDiscoveryHighlights(JSON.stringify(PLAIN_DISCOVERY));

  it("lists what a server advertises", () => {
    expect(advertisedPermissionTicketTypes(holder ?? null)).toEqual([
      "patient-self-access",
    ]);
  });

  it("lists nothing for a server with no discovery document", () => {
    expect(advertisedPermissionTicketTypes(null)).toEqual([]);
  });

  it("says a server supports the type it advertised", () => {
    expect(
      supportsPermissionTicketType(holder ?? null, "patient-self-access"),
    ).toBe(true);
  });

  it("says a server does not support a type it did not advertise", () => {
    expect(
      supportsPermissionTicketType(holder ?? null, "care-team-access"),
    ).toBe(false);
  });

  it("says a server advertising nothing supports nothing", () => {
    expect(
      supportsPermissionTicketType(plain ?? null, "patient-self-access"),
    ).toBe(false);
  });

  // Nothing has checked this server, so nothing is known. The pages say "not checked yet"
  // rather than claiming an absence of support.
  it("says an unchecked server supports nothing", () => {
    expect(supportsPermissionTicketType(null, "patient-self-access")).toBe(
      false,
    );
  });
});
