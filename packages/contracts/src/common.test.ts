/*
 * Copyright © 2026 Commonwealth Scientific and Industrial Research Organisation
 * (CSIRO) ABN 41 687 119 230. Licensed under the Apache License, Version 2.0.
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";

import {
  accountStatusSchema,
  authorizationModeSchema,
  checkFailureModeSchema,
  coverageOutcomeSchema,
  errorEnvelopeSchema,
  eventStatusSchema,
  harnessCheckOutcomeSchema,
  harnessVerdictSchema,
  pageSchema,
  paginationSchema,
  pairingStateSchema,
  registrationModeSchema,
} from "./common.ts";

/**
 * These schemas are the vocabulary the whole product shares, so the tests pin
 * the exact value sets from data-model.md. A silent addition or rename here
 * would let the server and the console disagree about what a state means.
 */

describe("errorEnvelopeSchema", () => {
  test("accepts an error on its own", () => {
    expect(errorEnvelopeSchema.parse({ error: "not_found" })).toEqual({
      error: "not_found",
    });
  });

  test("accepts an error with a detail", () => {
    expect(
      errorEnvelopeSchema.parse({
        error: "guarded",
        detail: "10.0.0.1 is a private address",
      }),
    ).toEqual({ error: "guarded", detail: "10.0.0.1 is a private address" });
  });

  test("refuses an envelope with no error", () => {
    expect(errorEnvelopeSchema.safeParse({ detail: "why" }).success).toBe(
      false,
    );
  });

  test("refuses an empty error", () => {
    expect(errorEnvelopeSchema.safeParse({ error: "" }).success).toBe(false);
  });

  test("refuses a detail that is not text", () => {
    expect(
      errorEnvelopeSchema.safeParse({ error: "invalid", detail: 42 }).success,
    ).toBe(false);
  });

  // A response carrying more than the contract says would let a handler leak a
  // stack trace or a credential by accident.
  test("drops anything beyond the contract", () => {
    expect(
      errorEnvelopeSchema.parse({
        error: "invalid",
        stack: "at ...",
        password: "hunter2",
      }),
    ).toEqual({ error: "invalid" });
  });
});

describe("paginationSchema", () => {
  test("defaults to the first page", () => {
    expect(paginationSchema.parse({})).toEqual({ limit: 50, offset: 0 });
  });

  // Query strings arrive as text, and every caller would otherwise coerce it.
  test("reads numbers given as text", () => {
    expect(paginationSchema.parse({ limit: "10", offset: "20" })).toEqual({
      limit: 10,
      offset: 20,
    });
  });

  test("refuses a page size outside the permitted range", () => {
    expect(paginationSchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(paginationSchema.safeParse({ limit: 201 }).success).toBe(false);
    expect(paginationSchema.safeParse({ limit: 10.5 }).success).toBe(false);
  });

  test("refuses a negative offset", () => {
    expect(paginationSchema.safeParse({ offset: -1 }).success).toBe(false);
  });
});

describe("pageSchema", () => {
  const page = pageSchema(z.object({ slug: z.string() }));

  test("accepts a page of items with its totals", () => {
    expect(
      page.parse({
        items: [{ slug: "sparked-2026-09" }],
        total: 1,
        limit: 50,
        offset: 0,
      }),
    ).toEqual({
      items: [{ slug: "sparked-2026-09" }],
      total: 1,
      limit: 50,
      offset: 0,
    });
  });

  test("refuses an item that does not match the item schema", () => {
    expect(
      page.safeParse({ items: [{ slug: 7 }], total: 1, limit: 50, offset: 0 })
        .success,
    ).toBe(false);
  });

  test("refuses a negative total", () => {
    expect(
      page.safeParse({ items: [], total: -1, limit: 50, offset: 0 }).success,
    ).toBe(false);
  });
});

// The part of a Zod enum these tests exercise, so the table needs no casts.
type Vocabulary = {
  readonly options: readonly string[];
  readonly parse: (value: unknown) => unknown;
  readonly safeParse: (value: unknown) => { readonly success: boolean };
};

describe("enumerations", () => {
  // Exactly the values in data-model.md, in its order.
  const vocabularies: readonly [string, Vocabulary, readonly string[]][] = [
    ["account status", accountStatusSchema, ["pending", "approved", "revoked"]],
    ["event status", eventStatusSchema, ["draft", "open", "closed"]],
    [
      "pairing state",
      pairingStateSchema,
      ["requested", "fulfilled", "declined", "failed", "lapsed"],
    ],
    ["authorization mode", authorizationModeSchema, ["open", "smart"]],
    [
      "registration mode",
      registrationModeSchema,
      ["open", "manual", "trustedDcr"],
    ],
    [
      "check failure mode",
      checkFailureModeSchema,
      ["timeout", "refused", "guarded", "invalid"],
    ],
    ["harness verdict", harnessVerdictSchema, ["passed", "failed"]],
    [
      "harness check outcome",
      harnessCheckOutcomeSchema,
      ["passed", "failed", "advisory"],
    ],
    [
      "coverage outcome",
      coverageOutcomeSchema,
      ["found", "missing", "unverifiable"],
    ],
  ];

  for (const [name, schema, values] of vocabularies) {
    test(`${name} holds exactly its documented values`, () => {
      expect(schema.options).toEqual(values);
      for (const value of values) {
        expect(schema.parse(value)).toBe(value);
      }
      expect(schema.safeParse("something-else").success).toBe(false);
    });
  }
});
