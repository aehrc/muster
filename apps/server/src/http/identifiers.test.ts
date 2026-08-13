/**
 * That a path segment is only treated as an identifier when it could be one.
 *
 * The failure this prevents is a 500 on a public read surface: a malformed identifier reached
 * Postgres as a uuid comparison and came back as a driver error, so a mistyped URL reported an
 * internal error rather than "no such thing".
 *
 * Author: John Grimes
 */

import { describe, expect, it } from "bun:test";

import { isIdentifier } from "./identifiers.js";

describe("isIdentifier", () => {
  it("accepts a UUID in either case", () => {
    expect(isIdentifier("a264c6c4-bb74-42bb-b121-56b64ddedd57")).toBe(true);
    expect(isIdentifier("A264C6C4-BB74-42BB-B121-56B64DDEDD57")).toBe(true);
  });

  it("refuses anything that could not name a row", () => {
    // `undefined` is the one that mattered: a console bug puts the string into the path.
    for (const value of [
      "undefined",
      "",
      "not-a-uuid",
      "a264c6c4bb7442bb b12156b64ddedd57",
      "a264c6c4-bb74-42bb-b121-56b64ddedd57'; drop table system; --",
      "a264c6c4-bb74-42bb-b121-56b64ddedd5",
    ]) {
      expect(isIdentifier(value)).toBe(false);
    }
  });
});
