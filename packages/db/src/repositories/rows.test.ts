/**
 * Telling a broken invariant from an ordinary empty result.
 *
 * The distinction is the whole reason these two functions exist rather than a non-null
 * assertion at each call site: an unconditional `insert ... returning` that yields nothing means
 * the schema and the code disagree, and a lookup that yields nothing means the row is not there.
 * Collapsing them would either hide the first or make every caller handle the second twice.
 *
 * Author: John Grimes
 */

import { describe, expect, it } from "bun:test";

import { firstRow, requireRow, RepositoryInvariantError } from "./rows.js";

describe("requireRow", () => {
  it("returns the row a statement produced", () => {
    expect(requireRow([{ id: "a" }], "insert into account")).toEqual({
      id: "a",
    });
  });

  it("throws, naming the statement, when there is none", () => {
    // Deliberately not part of any repository's return type: a caller should not be tempted
    // to handle it.
    expect(() => requireRow([], "insert into organisation")).toThrow(
      RepositoryInvariantError,
    );
    expect(() => requireRow([], "insert into organisation")).toThrow(
      /insert into organisation/,
    );
  });
});

describe("firstRow", () => {
  it("returns the first row when there is one", () => {
    expect(firstRow([{ id: "a" }, { id: "b" }])).toEqual({ id: "a" });
  });

  it("returns undefined for an empty result, which is a real outcome", () => {
    expect(firstRow([])).toBeUndefined();
  });
});
