/*
 * Copyright © 2026 Commonwealth Scientific and Industrial Research Organisation
 * (CSIRO) ABN 41 687 119 230. Licensed under the Apache License, Version 2.0.
 */

import { describe, expect, test } from "bun:test";

import {
  clientDetails,
  registrationGuidance,
  serverDetails,
} from "./systemDetails.ts";

import type { ClientProfile, ServerProfile } from "@muster/contracts";

/**
 * How a system's structured fields are labelled and worded for a reader.
 *
 * The event view and the system detail both render these, so the labels are
 * defined once; and the registration guidance is here because FR-016's statement
 * that no pairing is needed is a fact about the record, not about the page it is
 * shown on.
 */

const serverProfile: ServerProfile = {
  fhirBaseUrl: "https://fhir.medirecords.example.org",
  authorizationMode: "smart",
  registrationMode: "manual",
  notes: "Ask for a client id.",
};

const clientProfile: ClientProfile = {
  launchUrl: "https://smartforms.example.org/launch",
  redirectUris: ["https://smartforms.example.org/callback"],
  scopes: ["launch/patient", "patient/Observation.rs"],
  confidentiality: "confidential",
  launchContext: "patient",
  needsIntrospection: true,
};

// Reads one labelled value out of a detail list.
const valueOf = (
  details: readonly { label: string; value: string | readonly string[] }[],
  label: string,
) => details.find((detail) => detail.label === label)?.value;

describe("serverDetails", () => {
  test("spells out the modes rather than showing their codes", () => {
    const details = serverDetails(serverProfile);

    expect(valueOf(details, "FHIR base URL")).toBe(
      "https://fhir.medirecords.example.org",
    );
    expect(valueOf(details, "Authorization")).toBe("SMART on FHIR");
    expect(valueOf(details, "Registration")).toBe(
      "Manual, by the server's owner",
    );
    expect(valueOf(details, "Notes")).toBe("Ask for a client id.");
  });

  test("names the trusted-DCR registration endpoint when there is one", () => {
    const details = serverDetails({
      ...serverProfile,
      registrationMode: "trustedDcr",
      registrationEndpoint: "https://auth.example.org/register",
    });

    expect(valueOf(details, "Registration")).toMatch(/software statement/i);
    expect(valueOf(details, "Registration endpoint")).toBe(
      "https://auth.example.org/register",
    );
  });

  // Empty optional fields are dropped rather than shown blank.
  test("omits the fields the profile does not carry", () => {
    const details = serverDetails({ ...serverProfile, notes: "" });

    expect(details.some((detail) => detail.label === "Notes")).toBe(false);
    expect(
      details.some((detail) => detail.label === "Registration endpoint"),
    ).toBe(false);
  });
});

describe("clientDetails", () => {
  test("lists the redirect URIs and scopes as lists", () => {
    const details = clientDetails(clientProfile);

    expect(valueOf(details, "Redirect URIs")).toEqual(
      clientProfile.redirectUris,
    );
    expect(valueOf(details, "Scopes")).toEqual(clientProfile.scopes);
  });

  test("says whether the client keeps a secret and needs introspection", () => {
    expect(valueOf(clientDetails(clientProfile), "Client type")).toBe(
      "Confidential (keeps a secret)",
    );
    expect(valueOf(clientDetails(clientProfile), "Token introspection")).toBe(
      "Needed",
    );
    expect(
      valueOf(
        clientDetails({
          ...clientProfile,
          confidentiality: "public",
          needsIntrospection: false,
        }),
        "Token introspection",
      ),
    ).toBe("Not needed");
  });
});

describe("registrationGuidance", () => {
  // FR-016: an open server needs no pairing at all, and the directory says so.
  test("says no registration is needed for an open server", () => {
    expect(
      registrationGuidance({ ...serverProfile, registrationMode: "open" }),
    ).toMatch(/no registration/i);
  });

  test("says a request goes to the owner for a manual server", () => {
    expect(registrationGuidance(serverProfile)).toMatch(/owner/i);
  });

  test("says a trusted-DCR server registers without a human", () => {
    expect(
      registrationGuidance({
        ...serverProfile,
        registrationMode: "trustedDcr",
        registrationEndpoint: "https://auth.example.org/register",
      }),
    ).toMatch(/without/i);
  });
});
