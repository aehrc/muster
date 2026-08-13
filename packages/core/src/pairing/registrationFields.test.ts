/**
 * The registration field set: the prefill, and the minimum a request has to carry.
 *
 * FR-012 says the standard field set is prefilled from the client's record and editable
 * before submission, and `data-model.md` says what is submitted is a snapshot taken at
 * request time. Both halves matter here: the prefill has to reproduce the record faithfully,
 * and the snapshot has to be judged on its own afterwards - because the record it came from
 * may have changed by the time anything reads it.
 *
 * Author: John Grimes
 */

import { describe, expect, it } from "bun:test";

import {
  prefillRegistrationFields,
  registrationFieldRefusal,
} from "./registrationFields.js";

import type { ClientRecord, RegistrationFields } from "./registrationFields.js";

/** The Smart Forms entry the quickstart uses. */
const smartForms: ClientRecord = {
  name: "Smart Forms",
  clientProfile: {
    launchUrl: "https://smartforms.csiro.au/launch",
    redirectUris: ["https://smartforms.csiro.au/"],
    scopes: [
      "launch",
      "openid",
      "fhirUser",
      "patient/QuestionnaireResponse.crus",
    ],
    confidentiality: "public",
    launchContext: "patient",
    needsIntrospection: false,
  },
};

/** A field set that satisfies every minimum, for the cases that break one. */
function validFields(
  overrides: Partial<RegistrationFields> = {},
): RegistrationFields {
  return { ...prefillRegistrationFields(smartForms), ...overrides };
}

describe("prefillRegistrationFields", () => {
  it("carries every field of the standard set across from the record", () => {
    // FR-012 names the seven fields, and the server owner needs all of them to register the
    // client without asking a question by email.
    expect(prefillRegistrationFields(smartForms)).toEqual({
      clientName: "Smart Forms",
      launchUrl: "https://smartforms.csiro.au/launch",
      redirectUris: ["https://smartforms.csiro.au/"],
      scopes: [
        "launch",
        "openid",
        "fhirUser",
        "patient/QuestionnaireResponse.crus",
      ],
      confidentiality: "public",
      launchContext: "patient",
      needsIntrospection: false,
    });
  });

  it("names the client by the system's own name", () => {
    // The client name is what a server operator will see in their own client list, so it is
    // the name the directory shows rather than something typed twice.
    expect(
      prefillRegistrationFields({ ...smartForms, name: "  Padded  " }),
    ).toMatchObject({ clientName: "Padded" });
  });

  it("keeps a confidential client confidential", () => {
    expect(
      prefillRegistrationFields({
        ...smartForms,
        clientProfile: {
          ...smartForms.clientProfile,
          confidentiality: "confidential",
          needsIntrospection: true,
        },
      }),
    ).toMatchObject({
      confidentiality: "confidential",
      needsIntrospection: true,
    });
  });

  it("collapses a repeated redirect URI or scope", () => {
    // A record may legitimately list the same value twice; a registration asserting it twice
    // says nothing more and reads as a mistake to whoever has to approve it.
    expect(
      prefillRegistrationFields({
        ...smartForms,
        clientProfile: {
          ...smartForms.clientProfile,
          redirectUris: [
            "https://a.test/",
            "https://a.test/",
            "https://b.test/",
          ],
          scopes: ["launch", "launch", "openid"],
        },
      }),
    ).toMatchObject({
      redirectUris: ["https://a.test/", "https://b.test/"],
      scopes: ["launch", "openid"],
    });
  });

  it("preserves the order the record declares", () => {
    // Redirect URI order is not meaningful to SMART, but a set that comes back reordered
    // looks edited to the person comparing it against their own entry.
    expect(
      prefillRegistrationFields({
        ...smartForms,
        clientProfile: {
          ...smartForms.clientProfile,
          redirectUris: ["https://z.test/", "https://a.test/"],
        },
      }).redirectUris,
    ).toEqual(["https://z.test/", "https://a.test/"]);
  });

  it("does not invent a launch context", () => {
    expect(
      prefillRegistrationFields({
        ...smartForms,
        clientProfile: { ...smartForms.clientProfile, launchContext: "" },
      }).launchContext,
    ).toBe("");
  });
});

describe("registrationFieldRefusal", () => {
  it("admits a complete field set", () => {
    expect(registrationFieldRefusal(validFields())).toBeUndefined();
  });

  it("refuses a set with no redirect URI", () => {
    // A client with nowhere to be redirected cannot complete an authorization code flow, so
    // registering it would produce credentials nobody can use.
    expect(registrationFieldRefusal(validFields({ redirectUris: [] }))).toBe(
      "no_redirect_uris",
    );
  });

  it("refuses a set with no scopes", () => {
    // The scopes are the one thing the server owner is being asked to agree to.
    expect(registrationFieldRefusal(validFields({ scopes: [] }))).toBe(
      "no_scopes",
    );
  });

  it("refuses a set with no client name", () => {
    expect(registrationFieldRefusal(validFields({ clientName: "" }))).toBe(
      "no_client_name",
    );
    expect(registrationFieldRefusal(validFields({ clientName: "   " }))).toBe(
      "no_client_name",
    );
  });

  it("refuses a set with no launch URL", () => {
    // The launch URL is how a server that launches apps reaches this one; a SMART app entry
    // without it cannot be launched from an EHR.
    expect(registrationFieldRefusal(validFields({ launchUrl: "" }))).toBe(
      "no_launch_url",
    );
  });

  it("reports the missing name before the missing lists", () => {
    // One refusal at a time, and the first thing a person would fix.
    expect(
      registrationFieldRefusal(
        validFields({ clientName: "", redirectUris: [], scopes: [] }),
      ),
    ).toBe("no_client_name");
  });

  it("judges a snapshot on its own", () => {
    // The point of the snapshot: a set read back out of the database long after the client
    // record changed is judged by the same rule, with no reference to the record.
    const snapshot: RegistrationFields = {
      clientName: "Smart Forms",
      launchUrl: "https://smartforms.csiro.au/launch",
      redirectUris: ["https://smartforms.csiro.au/"],
      scopes: ["launch"],
      confidentiality: "public",
      launchContext: "",
      needsIntrospection: false,
    };
    expect(registrationFieldRefusal(snapshot)).toBeUndefined();
  });
});
