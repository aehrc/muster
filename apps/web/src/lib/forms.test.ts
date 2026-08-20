/*
 * Copyright © 2026 Commonwealth Scientific and Industrial Research Organisation
 * (CSIRO) ABN 41 687 119 230. Licensed under the Apache License, Version 2.0.
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { joinList, parseRequest, splitList } from "./forms.ts";

/**
 * Turning what someone typed into a request the contract accepts, and turning a
 * refusal back into something they can act on.
 *
 * The point of validating in the console at all is that the field is named while
 * the person is still looking at it; the server validates again regardless.
 */

const schema = z.object({
  name: z.string().min(1),
  redirectUris: z.array(z.string().url()).min(1),
});

describe("splitList", () => {
  // Nobody types a JSON array. They paste a list, on whatever separator their
  // source used.
  test("reads a list from newlines, commas or spaces", () => {
    expect(splitList("https://a.example.org\nhttps://b.example.org")).toEqual([
      "https://a.example.org",
      "https://b.example.org",
    ]);
    expect(splitList("launch/patient, patient/Observation.rs")).toEqual([
      "launch/patient",
      "patient/Observation.rs",
    ]);
    expect(splitList("launch/patient patient/*.rs")).toEqual([
      "launch/patient",
      "patient/*.rs",
    ]);
  });

  test("drops blank entries and surrounding space", () => {
    expect(splitList("  a ,, \n b \n\n")).toEqual(["a", "b"]);
    expect(splitList("")).toEqual([]);
    expect(splitList("   ")).toEqual([]);
  });
});

describe("joinList", () => {
  // The inverse, for editing an existing record: one per line is what a text
  // area shows best.
  test("renders a list one entry per line", () => {
    expect(joinList(["a", "b"])).toBe("a\nb");
    expect(joinList([])).toBe("");
  });
});

describe("parseRequest", () => {
  test("returns the parsed request when the input satisfies the contract", () => {
    const outcome = parseRequest(schema, {
      name: "Smart Forms",
      redirectUris: ["https://smartforms.example.org/callback"],
    });

    expect(outcome).toEqual({
      ok: true,
      value: {
        name: "Smart Forms",
        redirectUris: ["https://smartforms.example.org/callback"],
      },
    });
  });

  // The field has to be named, or the person is left guessing which of a dozen
  // inputs was the problem.
  test("names the offending field in each issue", () => {
    const outcome = parseRequest(schema, {
      name: "",
      redirectUris: ["not a url"],
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      throw new Error("expected the parse to fail");
    }
    expect(outcome.issues).toHaveLength(2);
    expect(outcome.issues[0]).toContain("name");
    expect(outcome.issues[1]).toContain("redirectUris.0");
  });

  // An issue with no path at all - a whole-object refinement - still has to say
  // something, and "body" is the honest name for it.
  test("calls a whole-object refusal by a name rather than by nothing", () => {
    const refined = schema.refine(() => false, "one profile is required");

    const outcome = parseRequest(refined, {
      name: "a",
      redirectUris: ["https://a.example.org"],
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      throw new Error("expected the parse to fail");
    }
    expect(outcome.issues[0]).toBe("body: one profile is required");
  });
});
