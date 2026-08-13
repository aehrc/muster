/**
 * The shapes the server and the console both depend on.
 *
 * These are the vocabularies that appear in every later schema: the error envelope
 * every refusal arrives in, the enums the state machines move through, the slug every
 * event URL is built from. They are tested because a permissive one is worse than
 * useless - an enum that accepted an unknown state would let a row into the database
 * that no view knows how to render.
 *
 * Author: John Grimes
 */

import { describe, expect, it } from "bun:test";

import {
  accountStatusSchema,
  authorizationModeSchema,
  checkFailureModeSchema,
  confidentialitySchema,
  errorEnvelopeSchema,
  eventStatusSchema,
  harnessVerdictSchema,
  pageQuerySchema,
  pairingStateSchema,
  personaCoverageOutcomeSchema,
  registrationModeSchema,
  signingKeyPurposeSchema,
  signingKeyStatusSchema,
  slugSchema,
} from "./common.js";

describe("errorEnvelopeSchema", () => {
  // The contract in `contracts/http-api.md`: a code the console can branch on, and an
  // optional sentence a person reads.
  it("accepts a code alone and a code with a detail", () => {
    expect(errorEnvelopeSchema.parse({ error: "not_found" })).toEqual({
      error: "not_found",
    });
    expect(
      errorEnvelopeSchema.parse({
        error: "guarded_address",
        detail: "10.0.0.1 is not publicly routable",
      }).detail,
    ).toBe("10.0.0.1 is not publicly routable");
  });

  it("refuses an envelope with no code", () => {
    expect(() => errorEnvelopeSchema.parse({ detail: "something" })).toThrow();
    expect(() => errorEnvelopeSchema.parse({ error: "" })).toThrow();
  });
});

describe("pageQuerySchema", () => {
  it("defaults to a first page", () => {
    expect(pageQuerySchema.parse({})).toEqual({ limit: 50, offset: 0 });
  });

  // Query strings arrive as strings; a schema that demanded numbers would push the
  // coercion into every route.
  it("coerces the values a query string carries", () => {
    expect(pageQuerySchema.parse({ limit: "10", offset: "20" })).toEqual({
      limit: 10,
      offset: 20,
    });
  });

  it("refuses a page size outside the range, rather than clamping it", () => {
    // Clamping hides a caller's mistaken assumption about how much they received.
    expect(() => pageQuerySchema.parse({ limit: "0" })).toThrow();
    expect(() => pageQuerySchema.parse({ limit: "1000" })).toThrow();
    expect(() => pageQuerySchema.parse({ offset: "-1" })).toThrow();
    expect(() => pageQuerySchema.parse({ limit: "10.5" })).toThrow();
  });
});

describe("slugSchema", () => {
  it("accepts lower-case alphanumerics with internal hyphens", () => {
    expect(slugSchema.parse("sparked-2026-09")).toBe("sparked-2026-09");
  });

  // Slugs sit in public URLs, so anything needing escaping is refused rather than
  // encoded.
  it("refuses anything that would need escaping or would not round-trip", () => {
    expect(() => slugSchema.parse("Sparked 2026")).toThrow();
    expect(() => slugSchema.parse("-leading")).toThrow();
    expect(() => slugSchema.parse("trailing-")).toThrow();
    expect(() => slugSchema.parse("a")).toThrow();
    expect(() => slugSchema.parse("../etc/passwd")).toThrow();
  });
});

describe("the enums", () => {
  it("accepts every state the data model defines and nothing else", () => {
    expect(accountStatusSchema.options).toEqual([
      "pending",
      "approved",
      "revoked",
    ]);
    expect(eventStatusSchema.options).toEqual(["draft", "open", "closed"]);
    expect(pairingStateSchema.options).toEqual([
      "requested",
      "fulfilled",
      "declined",
      "failed",
      "lapsed",
    ]);
    expect(registrationModeSchema.options).toEqual([
      "open",
      "manual",
      "trustedDcr",
    ]);
    expect(authorizationModeSchema.options).toEqual(["open", "smart"]);
    expect(confidentialitySchema.options).toEqual(["public", "confidential"]);
    expect(checkFailureModeSchema.options).toEqual([
      "timeout",
      "refused",
      "guarded",
      "invalid",
    ]);
    expect(harnessVerdictSchema.options).toEqual(["passed", "failed"]);
    expect(personaCoverageOutcomeSchema.options).toEqual([
      "found",
      "missing",
      "unverifiable",
    ]);
    expect(signingKeyPurposeSchema.options).toEqual(["statements", "tickets"]);
    expect(signingKeyStatusSchema.options).toEqual(["active", "superseded"]);
  });

  it("refuses a state it does not know", () => {
    // The failure this prevents: a spelling drift between the server and the console
    // that would otherwise present as a badge that never appears.
    expect(() => pairingStateSchema.parse("fulfiled")).toThrow();
    expect(() => registrationModeSchema.parse("trusted-dcr")).toThrow();
    expect(() => accountStatusSchema.parse("APPROVED")).toThrow();
  });
});
