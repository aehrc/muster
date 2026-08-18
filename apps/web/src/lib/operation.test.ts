import { describe, expect, test } from "bun:test";

import {
  busy,
  describeFailure,
  failed,
  idle,
  operationMessage,
  operationTone,
  pending,
  succeeded,
} from "./operation.ts";

import type { ApiFailure } from "../api/client.ts";

/**
 * Every user-visible operation reports its own state: pending, failed with a
 * cause, or succeeded (FR-037). These tests are about the words the screen ends
 * up showing, because "it failed" without the cause is the failure mode this
 * module exists to prevent.
 */

const failure = (partial: Partial<ApiFailure>): ApiFailure => ({
  status: 500,
  error: "internal_error",
  ...partial,
});

describe("describeFailure", () => {
  // The envelope's detail is written to be shown, so it is preferred over
  // anything this module could say about the code.
  test("prefers the detail the server sent", () => {
    expect(
      describeFailure(
        failure({
          status: 403,
          error: "forbidden",
          detail: "This account is awaiting approval by a track admin.",
        }),
      ),
    ).toBe("This account is awaiting approval by a track admin.");
  });

  test("puts words to each refusal that carries no detail", () => {
    expect(
      describeFailure(failure({ status: 401, error: "unauthorised" })),
    ).toMatch(/sign in/i);
    expect(
      describeFailure(failure({ status: 403, error: "forbidden" })),
    ).toMatch(/not permitted/i);
    expect(
      describeFailure(failure({ status: 404, error: "not_found" })),
    ).toMatch(/not here/i);
    expect(
      describeFailure(failure({ status: 409, error: "conflict" })),
    ).toMatch(/already/i);
    expect(
      describeFailure(failure({ status: 429, error: "rate_limited" })),
    ).toMatch(/too many/i);
    expect(
      describeFailure(failure({ status: 422, error: "unprocessable" })),
    ).toMatch(/accept/i);
  });

  // A dropped connection is the one failure the server never explains, so the
  // console has to.
  test("says the server could not be reached when nothing answered", () => {
    expect(
      describeFailure({
        status: 0,
        error: "network_error",
        detail: "Load failed",
      }),
    ).toBe("Load failed");
    expect(
      describeFailure(failure({ status: 0, error: "network_error" })),
    ).toMatch(/could not be reached/i);
  });

  // An unrecognised code still has to reach the screen as something actionable,
  // and the status is the part an operator can act on.
  test("names the code and the status for anything it does not recognise", () => {
    const message = describeFailure(
      failure({ status: 418, error: "teapot_error" }),
    );
    expect(message).toContain("teapot_error");
    expect(message).toContain("418");
  });
});

describe("operationMessage", () => {
  test("says nothing at all while nothing has been attempted", () => {
    expect(operationMessage(idle)).toBeUndefined();
  });

  test("reports the operation in progress", () => {
    expect(operationMessage(pending("Creating MediRecords"))).toBe(
      "Creating MediRecords…",
    );
  });

  // Failed with cause, never merely failed.
  test("reports a failure with its cause", () => {
    expect(
      operationMessage(
        failed(
          "Creating MediRecords",
          failure({ status: 409, error: "conflict", detail: "Already taken." }),
        ),
      ),
    ).toBe("Creating MediRecords failed. Already taken.");
  });

  test("reports a success, in the words the caller chose when it gave them", () => {
    expect(operationMessage(succeeded("Creating MediRecords"))).toBe(
      "Creating MediRecords succeeded.",
    );
    expect(
      operationMessage(
        succeeded(
          "Creating MediRecords",
          "MediRecords created; you are its first member.",
        ),
      ),
    ).toBe("MediRecords created; you are its first member.");
  });
});

describe("operationTone", () => {
  test("distinguishes the four states", () => {
    expect(operationTone(idle)).toBe("info");
    expect(operationTone(pending("Loading"))).toBe("info");
    expect(operationTone(failed("Loading", failure({})))).toBe("error");
    expect(operationTone(succeeded("Loading"))).toBe("success");
  });
});

describe("busy", () => {
  // What disables a submit button, so a form cannot be sent twice.
  test("is true only while an operation is in flight", () => {
    expect(busy(pending("Signing in"))).toBe(true);
    expect(busy(idle)).toBe(false);
    expect(busy(succeeded("Signing in"))).toBe(false);
    expect(busy(failed("Signing in", failure({})))).toBe(false);
  });
});
