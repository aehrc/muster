/**
 * How the console understands a refusal.
 *
 * The API answers a refusal with a code and, sometimes, a sentence. Both matter to a
 * different part of the interface: the code decides whether to send the browser to
 * sign in, and the sentence is what a person reads. The parsing is tested because the
 * alternative is a page showing "something went wrong" for a problem the server
 * described precisely - which is the opposite of what FR-037 asks for.
 *
 * Author: John Grimes
 */

import { describe, expect, it } from "bun:test";

import {
  ApiError,
  conflictingPairingId,
  describeError,
  isUnauthenticated,
  toApiError,
} from "./errors.js";

describe("toApiError", () => {
  it("reads the code and the detail out of the envelope", () => {
    const error = toApiError(422, {
      error: "guarded_address",
      detail: "10.0.0.1 is not publicly routable",
    });

    expect(error.status).toBe(422);
    expect(error.code).toBe("guarded_address");
    expect(error.message).toBe("10.0.0.1 is not publicly routable");
  });

  it("falls back to the code when there is no detail", () => {
    // Better than a generic sentence: `conflict` at least says what happened.
    expect(toApiError(409, { error: "conflict" }).message).toBe("conflict");
  });

  // A proxy returning an HTML error page, or a crash producing plain text, must still
  // surface as something readable rather than as a parse failure inside an error path.
  it("tolerates a body that is not an envelope at all", () => {
    const error = toApiError(502, "<html>Bad gateway</html>");

    expect(error.code).toBe("error");
    expect(error.message).toContain("502");
  });

  it("tolerates an absent body", () => {
    expect(toApiError(500, undefined).message).toContain("500");
  });
});

describe("describeError", () => {
  it("prefers the API's own sentence", () => {
    expect(
      describeError(
        new ApiError(403, "revoked_member", "Your membership was revoked"),
      ),
    ).toBe("Your membership was revoked");
  });

  it("reports a network failure readably", () => {
    expect(describeError(new TypeError("Failed to fetch"))).toBe(
      "Failed to fetch",
    );
  });

  // An unhandled rejection carrying something that is not an error must still produce a
  // sentence rather than "undefined".
  it("always produces something to show", () => {
    expect(describeError(undefined).length).toBeGreaterThan(0);
    // An error carrying no message at all, which is what an aborted request can throw.
    const blank = new TypeError("replaced below");
    blank.message = "";
    expect(describeError(blank).length).toBeGreaterThan(0);
  });
});

describe("conflictingPairingId", () => {
  it("reads the existing pairing out of a duplicate refusal", () => {
    // FR-015: the refusal links to the pairing that already exists, which the console can only
    // do if it can read the identifier back off the error.
    const error = toApiError(409, {
      error: "pairing_exists",
      detail: "This client already has a pairing with this server",
      pairingId: "3f6a2c9e-0000-4000-8000-000000000001",
    });

    expect(conflictingPairingId(error)).toBe(
      "3f6a2c9e-0000-4000-8000-000000000001",
    );
  });

  it("finds nothing in any other refusal", () => {
    expect(
      conflictingPairingId(toApiError(409, { error: "conflict" })),
    ).toBeUndefined();
    expect(
      conflictingPairingId(
        toApiError(409, { error: "pairing_exists", pairingId: 7 }),
      ),
    ).toBeUndefined();
    expect(conflictingPairingId(new Error("offline"))).toBeUndefined();
  });
});

describe("isUnauthenticated", () => {
  it("is true only for a 401", () => {
    expect(
      isUnauthenticated(new ApiError(401, "unauthenticated", "Sign in")),
    ).toBe(true);
    // A 403 deliberately does not count: the person is signed in and simply may not do
    // this, and signing them out would be an unhelpful answer to that.
    expect(isUnauthenticated(new ApiError(403, "forbidden", "No"))).toBe(false);
    expect(isUnauthenticated(new Error("offline"))).toBe(false);
  });
});
