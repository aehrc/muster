/*
 * Copyright © 2026 Commonwealth Scientific and Industrial Research Organisation
 * (CSIRO) ABN 41 687 119 230. Licensed under the Apache License, Version 2.0.
 */

import { describe, expect, test } from "bun:test";

import {
  offeredScopes,
  ticketClaimDetails,
  ticketOperation,
  toggleScope,
  validityChoices,
  validUntilFor,
} from "./tickets.ts";

import type { TicketRecord } from "@muster/contracts";

/**
 * What the ticket playground decides before it renders anything.
 *
 * The validity choices are the reason this module exists. A ticket's expiry is
 * capped by the server at the event's end plus its grace days, and the console asks
 * for a shorter one by naming an instant - so turning "eight hours" into that
 * instant is arithmetic over an injected clock, which belongs in a tested function
 * rather than inside a component.
 *
 * The claim list is the other half. The playground shows the decoded claims beside
 * the compact form (FR-034), and it shows them under the profile's own claim names,
 * because a member comparing what Muster minted with what their data holder rejected
 * is comparing claim names.
 */

/** A minted ticket as the API answers it. */
const record: TicketRecord = {
  jti: "8f14e45f-ceea-467a-9c3c-c8b1e0a9b111",
  keyId: "kid-1",
  personaId: "persona-1",
  mintedAt: "2026-08-19T02:00:00.000Z",
  expiresAt: "2026-09-11T00:00:00.000Z",
  claims: {
    iss: "https://muster.example.org",
    jti: "8f14e45f-ceea-467a-9c3c-c8b1e0a9b111",
    iat: 1_787_112_000,
    exp: 1_789_084_800,
    ticket_type: "patient-self-access",
    subject: {
      identifier: {
        system: "http://ns.electronichealth.net.au/id/hi/ihi/1.0",
        value: "8003608500314687",
      },
    },
    smart_scopes: "patient/Patient.rs patient/Observation.rs",
    muster_event: "sparked-2026-09",
  },
};

describe("the validity the playground asks for", () => {
  /** The moment every validity in this suite is reckoned from. */
  const now = new Date("2026-08-19T02:00:00.000Z");

  // The default is to take the server's ceiling, which needs no instant at all:
  // asking for one would be the console duplicating a rule it does not own.
  test("asks for no instant when the event's ceiling is chosen", () => {
    expect(validUntilFor("event", now)).toBeUndefined();
  });

  test.each([
    ["oneHour", "2026-08-19T03:00:00.000Z"],
    ["eightHours", "2026-08-19T10:00:00.000Z"],
    ["oneDay", "2026-08-20T02:00:00.000Z"],
  ])("turns %s into an instant", (choice, expected) => {
    expect(validUntilFor(choice, now)).toBe(expected);
  });

  // An unknown choice takes the ceiling rather than inventing a lifetime, which is
  // the same direction of failure the server takes.
  test("falls back to the ceiling for a choice it does not know", () => {
    expect(validUntilFor("forever", now)).toBeUndefined();
  });

  // Every choice the select offers is one this module can turn into a request.
  test("offers only choices it can act on", () => {
    for (const choice of validityChoices) {
      expect(() => validUntilFor(choice.value, now)).not.toThrow();
    }
    expect(validityChoices[0]?.value).toBe("event");
  });
});

describe("the scope constraints", () => {
  // The offered set is the patient self-access shape: every scope is a patient
  // compartment read, because that is what the only ticket type in scope means.
  test("offers patient compartment reads only", () => {
    expect(offeredScopes.length).toBeGreaterThan(0);
    for (const scope of offeredScopes) {
      expect(scope.startsWith("patient/")).toBe(true);
      expect(scope.endsWith(".rs")).toBe(true);
    }
  });

  test("adds a scope that was not chosen", () => {
    expect(
      toggleScope(["patient/Patient.rs"], "patient/Observation.rs"),
    ).toEqual(["patient/Patient.rs", "patient/Observation.rs"]);
  });

  test("removes a scope that was chosen", () => {
    expect(
      toggleScope(
        ["patient/Patient.rs", "patient/Observation.rs"],
        "patient/Patient.rs",
      ),
    ).toEqual(["patient/Observation.rs"]);
  });

  // The order is the offered order rather than the clicking order, so the same
  // choices always produce the same `smart_scopes` claim.
  test("keeps the offered order however the scopes were chosen", () => {
    const chosen = toggleScope(
      toggleScope([], offeredScopes[1] ?? ""),
      offeredScopes[0] ?? "",
    );

    expect(chosen).toEqual([offeredScopes[0] ?? "", offeredScopes[1] ?? ""]);
  });
});

describe("what the playground says about a minted ticket", () => {
  // The claims under the profile's own names, so that a member comparing Muster's
  // artefact with a data holder's complaint is comparing the same words.
  test("lists every claim under its name in the profile", () => {
    const labels = ticketClaimDetails(record.claims).map(
      (detail) => detail.label,
    );

    expect(labels).toEqual([
      "iss",
      "jti",
      "iat",
      "exp",
      "ticket_type",
      "subject",
      "smart_scopes",
      "muster_event",
    ]);
  });

  // The subject is the point of the artefact, so it reads as the identifier it is
  // rather than as a JSON blob.
  test("renders the subject as its identifier system and value", () => {
    const subject = ticketClaimDetails(record.claims).find(
      (detail) => detail.label === "subject",
    );

    expect(subject?.value).toBe(
      "http://ns.electronichealth.net.au/id/hi/ihi/1.0|8003608500314687",
    );
  });

  // The timestamps are shown as instants: a member checking whether the cap was
  // applied cannot read a number of seconds.
  test("renders the timestamps as instants", () => {
    const details = ticketClaimDetails(record.claims);

    expect(details.find((detail) => detail.label === "exp")?.value).toBe(
      "2026-09-11T00:00:00.000Z",
    );
  });

  // The scopes read as the list they constrain, one per line rather than one long
  // string.
  test("renders the scope constraints as a list", () => {
    const scopes = ticketClaimDetails(record.claims).find(
      (detail) => detail.label === "smart_scopes",
    );

    expect(scopes?.value).toEqual([
      "patient/Patient.rs",
      "patient/Observation.rs",
    ]);
  });

  // FR-037: the operation reports what happened, including how long the artefact
  // is good for, because that is the thing the member is about to rely on.
  test("reports the mint with the validity it was given", () => {
    const operation = ticketOperation(record, new Date(record.mintedAt));

    expect(operation.state).toBe("succeeded");
    expect(operation.state === "succeeded" ? operation.detail : "").toContain(
      "2026-09-11T00:00:00.000Z",
    );
  });
});
