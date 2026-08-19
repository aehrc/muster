import { describe, expect, test } from "bun:test";

import {
  discoveryHighlights,
  evaluateCheck,
  permissionTicketTypes,
} from "./evaluate.ts";

import type { CheckInput } from "./evaluate.ts";
import type { ServerProfile } from "@muster/contracts";

/**
 * Permission ticket support, as the verification checks observe it.
 *
 * The ticket profile's discovery rule (FR-034, acceptance scenario 3): a data
 * holder advertises the ticket types it accepts as
 * `smart_permission_ticket_types_supported` in its SMART configuration, and
 * Muster's checks read it so that the event view can say which enrolled servers
 * accept a ticket without anybody asking their owner.
 *
 * Deny by default applies to reading it, as it does to the rest of the document. A
 * server that says nothing supports nothing as far as the directory is concerned:
 * an absent member is an empty list rather than an assumption, because an entry
 * shown as accepting tickets when it does not is worse to a member than no entry
 * at all.
 *
 * A separate suite from `evaluate.test.ts` because it is a separate contract: this
 * is the ticket profile's half of the discovery document, and `contracts/
 * ticket-profile.md` is what it has to keep faith with.
 */

/** A server entry declaring nothing that could drift, so drift is not the subject. */
const declared: ServerProfile = {
  fhirBaseUrl: "https://holder.example.org/fhir",
  authorizationMode: "smart",
  registrationMode: "manual",
  notes: "",
};

/** The two endpoints that make a document a SMART configuration. */
const endpoints = {
  authorization_endpoint: "https://holder.example.org/authorize",
  token_endpoint: "https://holder.example.org/token",
};

/**
 * Evaluates a check of a server whose discovery document is the one given.
 *
 * @param document - the SMART configuration as fetched
 * @returns the evaluation
 */
const evaluateDiscovery = (document: unknown) => {
  const input: CheckInput = {
    declared,
    discovery: { ok: true, document },
    capability: {
      ok: false,
      failureMode: "refused",
      detail: "The capability statement was refused.",
    },
  };
  return evaluateCheck(input);
};

describe("reading permission ticket support from a discovery document", () => {
  // The claim's own name, spelled as the profile spells it: a member renamed on
  // the way in is a member nothing finds.
  test("captures the ticket types a server advertises", () => {
    const highlights = discoveryHighlights({
      ...endpoints,
      smart_permission_ticket_types_supported: ["patient-self-access"],
    });

    expect(highlights?.permissionTicketTypesSupported).toEqual([
      "patient-self-access",
    ]);
  });

  // A server that says nothing accepts nothing, as far as the directory reports.
  test("reads an absent member as no support at all", () => {
    const highlights = discoveryHighlights(endpoints);

    expect(highlights?.permissionTicketTypesSupported).toEqual([]);
  });

  // Something that is not a list of types is not read as one.
  test("reads a member that is not a list as no support", () => {
    const highlights = discoveryHighlights({
      ...endpoints,
      smart_permission_ticket_types_supported: "patient-self-access",
    });

    expect(highlights?.permissionTicketTypesSupported).toEqual([]);
  });

  // A stray entry does not discard the usable ones, as everywhere else a list is
  // read.
  test("keeps the entries that are types and drops the rest", () => {
    const highlights = discoveryHighlights({
      ...endpoints,
      smart_permission_ticket_types_supported: [
        "patient-self-access",
        7,
        "provider-access",
      ],
    });

    expect(highlights?.permissionTicketTypesSupported).toEqual([
      "patient-self-access",
      "provider-access",
    ]);
  });
});

describe("surfacing permission ticket support per server", () => {
  // The evaluation is the row that is persisted and the row the event view reads,
  // so support has to survive the whole evaluation rather than only the parse.
  test("carries the advertised types into the evaluated check", () => {
    const evaluation = evaluateDiscovery({
      ...endpoints,
      smart_permission_ticket_types_supported: ["patient-self-access"],
    });

    expect(evaluation.reachable).toBe(true);
    expect(evaluation.discovery?.permissionTicketTypesSupported).toEqual([
      "patient-self-access",
    ]);
    expect(permissionTicketTypes(evaluation.discovery)).toEqual([
      "patient-self-access",
    ]);
  });

  // A server whose document could not be read has not said it accepts tickets.
  test("reports no support when no document was read", () => {
    const evaluation = evaluateDiscovery({ nothing: "useful" });

    expect(evaluation.discovery).toBeNull();
    expect(permissionTicketTypes(evaluation.discovery)).toEqual([]);
  });

  // And an entry nothing has checked reports no support either, rather than
  // reporting an absence of evidence as evidence.
  test("reports no support for an unchecked entry", () => {
    expect(permissionTicketTypes(null)).toEqual([]);
  });
});
