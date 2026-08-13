/**
 * What the harness screen claims about a run.
 *
 * The claims are the point rather than the wording: a badge said to have been applied when it
 * has not, or a failure reported as though every check failed, is a page that misleads the
 * person whose product it is about.
 *
 * Author: John Grimes
 */

import { describe, expect, it } from "bun:test";

import {
  describeBadge,
  describeCheckName,
  describeHarnessRefusal,
  describeVerdict,
  summariseEvidence,
  HARNESS_CHECK_LABELS,
} from "./harnessReport.js";

import type { HarnessCheckView, HarnessRunView } from "@muster/contracts";

/** One check, as a run carries it. */
function check(
  overrides: Partial<HarnessCheckView> & { readonly name: string },
): HarnessCheckView {
  return {
    outcome: "passed",
    detail: "201: registered client stub-1",
    advisories: [],
    request: {
      method: "POST",
      url: "https://stub.example.org/register",
      body: "{}",
    },
    response: { status: 201, error: null, errorDescription: null, body: "{}" },
    failure: null,
    ...overrides,
  };
}

/** A run with the given check outcomes. */
function run(overrides: Partial<HarnessRunView> = {}): HarnessRunView {
  return {
    id: "8f14e45f-ceea-4674-a11a-000000000001",
    enrolmentId: "8f14e45f-ceea-4674-a11a-000000000002",
    ranAt: "2026-09-02T14:31:00.000Z",
    verdict: "passed",
    registrationEndpoint: "https://stub.example.org/register",
    checks: HARNESS_CHECK_LABELS.map((label) => check({ name: label.name })),
    cleanup: "Deleted throwaway client stub-1.",
    ...overrides,
  };
}

describe("HARNESS_CHECK_LABELS", () => {
  it("names every check the harness runs, in order", () => {
    expect(HARNESS_CHECK_LABELS.map((label) => label.name)).toEqual([
      "valid-statement",
      "tampered-signature",
      "expired-statement",
      "replayed-statement",
      "metadata-fidelity",
      "statement-only",
    ]);
    // Each says what the profile expects, so a reader can tell what is about to be presented.
    expect(
      HARNESS_CHECK_LABELS.every((label) => label.expectation.length > 0),
    ).toBe(true);
  });
});

describe("describeCheckName", () => {
  it("uses the label for a check it knows", () => {
    expect(describeCheckName("tampered-signature")).toBe(
      "Tampered signature rejected",
    );
  });

  it("falls back to the name for one it does not", () => {
    // A run recorded by a later version is still readable rather than blank.
    expect(describeCheckName("something-newer")).toBe("something-newer");
  });
});

describe("describeVerdict", () => {
  it("says the badge was applied, and when", () => {
    const described = describeVerdict(run());

    expect(described.tone).toBe("pass");
    expect(described.text).toContain("All checks passed");
    expect(described.text).toContain("2026-09-02 14:31");
  });

  it("counts the failures rather than saying only that the run failed", () => {
    const described = describeVerdict(
      run({
        verdict: "failed",
        checks: [
          check({ name: "valid-statement" }),
          check({ name: "tampered-signature", outcome: "failed" }),
          check({ name: "expired-statement" }),
        ],
      }),
    );

    expect(described.tone).toBe("fail");
    expect(described.text).toContain("1 of 3");
    expect(described.text).toContain("no badge");
  });

  it("says nothing has run rather than showing an empty verdict", () => {
    expect(describeVerdict(undefined).tone).toBe("none");
    expect(describeVerdict(undefined).text).toContain("No run yet");
  });
});

describe("summariseEvidence", () => {
  it("shows what the check concluded", () => {
    expect(summariseEvidence(check({ name: "valid-statement" }))).toContain(
      "registered client",
    );
  });

  it("shows why nothing answered when nothing did", () => {
    expect(
      summariseEvidence(
        check({
          name: "valid-statement",
          response: null,
          failure: "the endpoint did not answer in time",
        }),
      ),
    ).toBe("the endpoint did not answer in time");
  });
});

describe("describeHarnessRefusal", () => {
  it("has a sentence for every refusal the server can answer with", () => {
    const refusals = [
      "not_signed_in",
      "not_the_server_owner",
      "email_unverified",
      "awaiting_approval",
      "revoked_member",
      "event_not_open",
      "not_trusted_dcr",
      "no_registration_endpoint",
      "vouching_window_closed",
    ] as const;

    for (const refusal of refusals) {
      expect(describeHarnessRefusal(refusal)?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it("says nothing when the run is available", () => {
    expect(describeHarnessRefusal(null)).toBeNull();
  });
});

describe("describeBadge", () => {
  it("carries the date of the run that earned it", () => {
    expect(
      describeBadge({
        verifiedAt: "2026-09-02T14:31:00.000Z",
        runId: "8f14e45f-ceea-4674-a11a-000000000001",
      }),
    ).toBe("DCR verified 2026-09-02");
  });

  it("shows nothing when no passing run stands", () => {
    expect(describeBadge(null)).toBeNull();
  });
});
