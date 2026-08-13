/**
 * Which requests the built console may answer.
 *
 * One process serves the API and the console, which is what makes a same-origin
 * session cookie work without CORS or a second deployment. The risk that creates is
 * the fallback: a single-page application needs an unknown path to return
 * `index.html`, and that must not swallow an unmatched API route - answering a
 * mistyped `/api/events` with a page of HTML tells a script its request succeeded.
 *
 * Author: John Grimes
 */

import { describe, expect, it } from "bun:test";

import { isReservedPath, wantsApplicationShell } from "./staticFiles.js";

describe("isReservedPath", () => {
  it("reserves the API, the probes and the well-known paths", () => {
    expect(isReservedPath("/api")).toBe(true);
    expect(isReservedPath("/api/events/sparked-2026-09")).toBe(true);
    expect(isReservedPath("/healthz")).toBe(true);
    expect(isReservedPath("/readyz")).toBe(true);
    expect(isReservedPath("/.well-known/jwks.json")).toBe(true);
  });

  it("leaves the console's own routes to the console", () => {
    expect(isReservedPath("/")).toBe(false);
    expect(isReservedPath("/events/sparked-2026-09")).toBe(false);
    expect(isReservedPath("/assets/index-abc123.js")).toBe(false);
    // Not a prefix match on the word: a console route may begin with the same letters.
    expect(isReservedPath("/apis-we-support")).toBe(false);
  });
});

describe("wantsApplicationShell", () => {
  it("is true for a navigation", () => {
    expect(
      wantsApplicationShell("GET", "text/html,application/xhtml+xml"),
    ).toBe(true);
    expect(wantsApplicationShell("HEAD", "text/html")).toBe(true);
  });

  // A script's fetch does not ask for HTML. Serving it the shell would turn a 404 into
  // a body it might try to parse.
  it("is false for anything that did not ask for HTML", () => {
    expect(wantsApplicationShell("GET", "application/json")).toBe(false);
    expect(wantsApplicationShell("GET", undefined)).toBe(false);
    expect(wantsApplicationShell("POST", "text/html")).toBe(false);
  });
});
