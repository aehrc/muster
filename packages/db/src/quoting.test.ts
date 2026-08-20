/*
 * Copyright © 2026 Commonwealth Scientific and Industrial Research Organisation
 * (CSIRO) ABN 41 687 119 230. Licensed under the Apache License, Version 2.0.
 */

import { describe, expect, test } from "bun:test";

import { quoteIdentifier, quoteLiteral } from "./quoting.ts";

describe("quoteIdentifier", () => {
  // Identifiers are always quoted, so a lower-case name survives unchanged
  // apart from the quotes, and a mixed-case name keeps its case.
  test("wraps a plain identifier in double quotes", () => {
    expect(quoteIdentifier("muster_server")).toBe('"muster_server"');
  });

  test("preserves case rather than folding it", () => {
    expect(quoteIdentifier("MusterServer")).toBe('"MusterServer"');
  });

  // The injection case: an embedded double quote must be doubled, not escaped
  // with a backslash, which PostgreSQL does not honour in identifiers.
  test("doubles embedded double quotes", () => {
    expect(quoteIdentifier('bad" or 1=1 --')).toBe('"bad"" or 1=1 --"');
  });

  test("refuses an empty identifier", () => {
    expect(() => quoteIdentifier("")).toThrow(/empty/i);
  });

  test("refuses an identifier containing a NUL character", () => {
    expect(() => quoteIdentifier("a\u0000b")).toThrow(/NUL/i);
  });
});

describe("quoteLiteral", () => {
  test("wraps a plain value in single quotes", () => {
    expect(quoteLiteral("s3cret")).toBe("'s3cret'");
  });

  // The injection case for literals: doubling the single quote is the complete
  // escape under standard_conforming_strings, which is on by default.
  test("doubles embedded single quotes", () => {
    expect(quoteLiteral("O'Brien'; drop table x --")).toBe(
      "'O''Brien''; drop table x --'",
    );
  });

  test("permits an empty value", () => {
    expect(quoteLiteral("")).toBe("''");
  });

  test("preserves backslashes verbatim", () => {
    expect(quoteLiteral("a\\b")).toBe("'a\\b'");
  });

  test("refuses a value containing a NUL character", () => {
    expect(() => quoteLiteral("a\u0000b")).toThrow(/NUL/i);
  });
});
