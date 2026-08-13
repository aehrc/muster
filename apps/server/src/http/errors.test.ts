/**
 * The one shape a refusal arrives in.
 *
 * Every route in Muster refuses through these two functions, so what is asserted here
 * is the contract in `contracts/http-api.md`: a machine-readable code, an optional
 * sentence for a person, a JSON content type and the status the caller has to branch
 * on. A route that answered a refusal in any other shape would be one the console
 * could not report (FR-037).
 *
 * Author: John Grimes
 */

import { errorEnvelopeSchema } from "@muster/contracts";
import { describe, expect, it } from "bun:test";
import { Hono } from "hono";

import { errorEnvelope, jsonError } from "./errors.js";

describe("errorEnvelope", () => {
  it("carries the code alone when there is nothing to add", () => {
    expect(errorEnvelope("not_found")).toEqual({ error: "not_found" });
  });

  it("carries a detail when there is one", () => {
    expect(
      errorEnvelope("guarded_address", "10.0.0.1 is not routable"),
    ).toEqual({ error: "guarded_address", detail: "10.0.0.1 is not routable" });
  });

  // `exactOptionalPropertyTypes` is on, and a body serialising `detail: undefined`
  // would put `"detail": null` on the wire for a caller to have to handle.
  it("omits the detail key rather than sending an empty one", () => {
    expect(Object.keys(errorEnvelope("forbidden"))).toEqual(["error"]);
  });

  it("produces the shape the contract schema accepts", () => {
    expect(() =>
      errorEnvelopeSchema.parse(errorEnvelope("conflict", "already exists")),
    ).not.toThrow();
  });
});

describe("jsonError", () => {
  it("answers with the status, the envelope and a JSON content type", async () => {
    const app = new Hono().get("/thing", (c) =>
      jsonError(c, 404, "not_found", "No event has that slug"),
    );

    const response = await app.request("/thing");

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
    await expect(response.json()).resolves.toEqual({
      error: "not_found",
      detail: "No event has that slug",
    });
  });
});
