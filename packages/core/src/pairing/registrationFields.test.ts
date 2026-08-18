import { describe, expect, test } from "bun:test";

import {
  normaliseRegistrationFields,
  prefillRegistrationFields,
} from "./registrationFields.ts";

import type { ClientProfile, RegistrationFields } from "@muster/contracts";

/**
 * The registration field set.
 *
 * FR-012 wants the field set prefilled from the client's record and editable
 * before submission, so the two directions are tested separately: what the client
 * record produces, and what a submission is reduced to before both organisations
 * read it.
 */

// The client profile of a system as its owner described it.
const profile: ClientProfile = {
  launchUrl: "https://smartforms.csiro.au/launch",
  redirectUris: [
    "https://smartforms.csiro.au/callback",
    "https://smartforms.csiro.au/other",
  ],
  scopes: ["launch/patient", "patient/Observation.rs"],
  confidentiality: "public",
  launchContext: "patient",
  needsIntrospection: false,
};

// A submitted field set, defaulting to the tidy case.
const fields = (
  overrides: Partial<RegistrationFields> = {},
): RegistrationFields => ({
  clientName: "Smart Forms",
  launchUrl: profile.launchUrl,
  redirectUris: [...profile.redirectUris],
  scopes: [...profile.scopes],
  confidentiality: "public",
  launchContext: "patient",
  needsIntrospection: false,
  ...overrides,
});

describe("prefillRegistrationFields", () => {
  // FR-012: everything the server needs comes from the client's own record, so
  // the app owner retypes nothing.
  test("carries every field across from the client's record", () => {
    expect(prefillRegistrationFields("Smart Forms", profile)).toEqual({
      clientName: "Smart Forms",
      launchUrl: "https://smartforms.csiro.au/launch",
      redirectUris: [
        "https://smartforms.csiro.au/callback",
        "https://smartforms.csiro.au/other",
      ],
      scopes: ["launch/patient", "patient/Observation.rs"],
      confidentiality: "public",
      launchContext: "patient",
      needsIntrospection: false,
    });
  });

  // The prefill is a copy, not a view: editing it before submission must not
  // rewrite the system record it came from.
  test("copies the lists rather than sharing them with the record", () => {
    const prefilled = prefillRegistrationFields("Smart Forms", profile);

    prefilled.redirectUris.push("https://elsewhere.example.org/callback");

    expect(profile.redirectUris).toHaveLength(2);
  });

  // A confidential client that needs introspection is carried across as such:
  // the prefill states the record, it does not interpret it.
  test("carries a confidential client's needs across unchanged", () => {
    const prefilled = prefillRegistrationFields("Smart Forms", {
      ...profile,
      confidentiality: "confidential",
      needsIntrospection: true,
    });

    expect(prefilled.confidentiality).toBe("confidential");
    expect(prefilled.needsIntrospection).toBe(true);
  });
});

describe("normaliseRegistrationFields", () => {
  // A tidy submission is stored as submitted.
  test("leaves a tidy field set alone", () => {
    expect(normaliseRegistrationFields(fields())).toEqual(fields());
  });

  // Pasted values arrive with whitespace around them, and the two parties should
  // not have to notice it.
  test("trims the text fields", () => {
    const normalised = normaliseRegistrationFields(
      fields({
        clientName: "  Smart Forms  ",
        launchUrl: " https://smartforms.csiro.au/launch ",
        launchContext: " patient ",
        redirectUris: [" https://smartforms.csiro.au/callback "],
      }),
    );

    expect(normalised.clientName).toBe("Smart Forms");
    expect(normalised.launchUrl).toBe("https://smartforms.csiro.au/launch");
    expect(normalised.launchContext).toBe("patient");
    expect(normalised.redirectUris).toEqual([
      "https://smartforms.csiro.au/callback",
    ]);
  });

  // The same redirect URI or scope twice is one instruction, not two, and the
  // order the person listed them in is kept.
  test("reduces repeated redirect URIs and scopes to one each", () => {
    const normalised = normaliseRegistrationFields(
      fields({
        redirectUris: [
          "https://smartforms.csiro.au/other",
          "https://smartforms.csiro.au/callback",
          "https://smartforms.csiro.au/other",
        ],
        scopes: ["launch/patient", "launch/patient"],
      }),
    );

    expect(normalised.redirectUris).toEqual([
      "https://smartforms.csiro.au/other",
      "https://smartforms.csiro.au/callback",
    ]);
    expect(normalised.scopes).toEqual(["launch/patient"]);
  });

  // A blank entry is nothing, and storing it would show the server an empty row
  // to puzzle over.
  test("drops blank entries from the lists", () => {
    const normalised = normaliseRegistrationFields(
      fields({
        redirectUris: ["https://smartforms.csiro.au/callback", "   "],
        scopes: ["launch/patient", ""],
      }),
    );

    expect(normalised.redirectUris).toEqual([
      "https://smartforms.csiro.au/callback",
    ]);
    expect(normalised.scopes).toEqual(["launch/patient"]);
  });
});
