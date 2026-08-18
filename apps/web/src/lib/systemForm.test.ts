import { describe, expect, test } from "bun:test";

import {
  buildSystemPatch,
  buildSystemRequest,
  emptySystemForm,
  systemFormFrom,
} from "./systemForm.ts";

import type { SystemFormValues } from "./systemForm.ts";
import type { SystemRecord } from "@muster/contracts";

/**
 * The system form: FR-006's field set, in and out of the shape a browser input
 * can hold.
 *
 * A system is a server, a client, or both - never neither - and the console says
 * so before the request is sent rather than relaying the schema's refusal after.
 */

// A filled-in server form.
const serverForm: SystemFormValues = {
  ...emptySystemForm,
  name: "MediRecords FHIR",
  description: "A FHIR server.",
  isServer: true,
  fhirBaseUrl: "https://fhir.medirecords.example.org",
  authorizationMode: "smart",
  registrationMode: "manual",
  notes: "Ask for a client id.",
};

// Just the client half of the field set, so a form can be composed of either
// half or of both without one half blanking the other.
const clientFields = {
  isClient: true,
  launchUrl: "https://smartforms.example.org/launch",
  redirectUris:
    "https://smartforms.example.org/callback\nhttps://smartforms.example.org/other",
  scopes: "launch/patient, patient/Observation.rs",
  confidentiality: "public",
  launchContext: "patient",
} as const;

// A filled-in client form.
const clientForm: SystemFormValues = {
  ...emptySystemForm,
  ...clientFields,
  name: "Smart Forms",
};

describe("buildSystemRequest", () => {
  test("builds a server-only system from the server fields", () => {
    const outcome = buildSystemRequest(serverForm);

    expect(outcome).toEqual({
      ok: true,
      value: {
        name: "MediRecords FHIR",
        description: "A FHIR server.",
        serverProfile: {
          fhirBaseUrl: "https://fhir.medirecords.example.org",
          authorizationMode: "smart",
          registrationMode: "manual",
          notes: "Ask for a client id.",
        },
        clientProfile: null,
      },
    });
  });

  test("reads the redirect URIs and scopes as lists", () => {
    const outcome = buildSystemRequest(clientForm);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      throw new Error(outcome.issues.join("; "));
    }
    expect(outcome.value.clientProfile).toEqual({
      launchUrl: "https://smartforms.example.org/launch",
      redirectUris: [
        "https://smartforms.example.org/callback",
        "https://smartforms.example.org/other",
      ],
      scopes: ["launch/patient", "patient/Observation.rs"],
      confidentiality: "public",
      launchContext: "patient",
      needsIntrospection: false,
    });
    expect(outcome.value.serverProfile).toBeNull();
  });

  test("builds a system that is both a server and a client", () => {
    const outcome = buildSystemRequest({
      ...serverForm,
      ...clientFields,
      name: "Both",
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      throw new Error(outcome.issues.join("; "));
    }
    expect(outcome.value.serverProfile).not.toBeNull();
    expect(outcome.value.clientProfile).not.toBeNull();
  });

  // FR-006: neither is not an option, and the console says which choice is
  // missing rather than sending a request it knows will be refused.
  test("refuses a system that is neither a server nor a client", () => {
    const outcome = buildSystemRequest({ ...emptySystemForm, name: "Neither" });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      throw new Error("expected a refusal");
    }
    expect(outcome.issues[0]).toMatch(/server, a client, or both/i);
  });

  // Trusted DCR without a registration endpoint is not usable, and the contract
  // says so; the console reports it against the field.
  test("refuses a trusted-DCR server with no registration endpoint", () => {
    const outcome = buildSystemRequest({
      ...serverForm,
      registrationMode: "trustedDcr",
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      throw new Error("expected a refusal");
    }
    expect(outcome.issues.join(" ")).toContain("registrationEndpoint");
  });

  test("carries a registration endpoint when one was given", () => {
    const outcome = buildSystemRequest({
      ...serverForm,
      registrationMode: "trustedDcr",
      registrationEndpoint: "https://auth.example.org/register",
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      throw new Error(outcome.issues.join("; "));
    }
    expect(outcome.value.serverProfile?.registrationEndpoint).toBe(
      "https://auth.example.org/register",
    );
  });

  test("refuses an address that is not an absolute https URL", () => {
    const outcome = buildSystemRequest({
      ...serverForm,
      fhirBaseUrl: "http://fhir.example.org",
    });

    expect(outcome.ok).toBe(false);
  });

  test("refuses a system with no name", () => {
    expect(buildSystemRequest({ ...serverForm, name: "  " }).ok).toBe(false);
  });
});

describe("buildSystemPatch", () => {
  // An edit that drops the client profile clears it, which is how a system stops
  // being a client - an omitted field would leave it alone instead.
  test("clears the profile a system no longer has", () => {
    const outcome = buildSystemPatch({
      ...serverForm,
      ...clientFields,
      isClient: false,
      name: "Server now",
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      throw new Error(outcome.issues.join("; "));
    }
    expect(outcome.value.clientProfile).toBeNull();
    expect(outcome.value.serverProfile).not.toBeNull();
  });

  test("refuses a patch that would leave the system as neither", () => {
    expect(buildSystemPatch({ ...emptySystemForm, name: "Neither" }).ok).toBe(
      false,
    );
  });
});

describe("systemFormFrom", () => {
  // Editing starts from what is stored, so a round trip through the form changes
  // nothing that was not typed.
  test("fills the form from a stored system and round trips it", () => {
    const stored: SystemRecord = {
      id: "sys-1",
      organisationId: "org-1",
      name: "Both",
      description: "Everything.",
      kinds: ["server", "client"],
      serverProfile: {
        fhirBaseUrl: "https://fhir.example.org",
        authorizationMode: "open",
        registrationMode: "trustedDcr",
        registrationEndpoint: "https://auth.example.org/register",
        notes: "Notes.",
      },
      clientProfile: {
        launchUrl: "https://app.example.org/launch",
        redirectUris: [
          "https://app.example.org/a",
          "https://app.example.org/b",
        ],
        scopes: ["launch/patient"],
        confidentiality: "confidential",
        launchContext: "patient, encounter",
        needsIntrospection: true,
      },
    };

    const values = systemFormFrom(stored);

    expect(values.isServer).toBe(true);
    expect(values.isClient).toBe(true);
    expect(values.redirectUris).toBe(
      "https://app.example.org/a\nhttps://app.example.org/b",
    );
    expect(values.needsIntrospection).toBe(true);
    expect(values.authorizationMode).toBe("open");

    const outcome = buildSystemPatch(values);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      throw new Error(outcome.issues.join("; "));
    }
    expect(outcome.value.serverProfile).toEqual(stored.serverProfile);
    expect(outcome.value.clientProfile).toEqual(stored.clientProfile);
  });

  test("leaves the unused half of the form empty", () => {
    const values = systemFormFrom({
      id: "sys-2",
      organisationId: "org-1",
      name: "Client only",
      description: "",
      kinds: ["client"],
      serverProfile: null,
      clientProfile: {
        launchUrl: "https://app.example.org/launch",
        redirectUris: ["https://app.example.org/a"],
        scopes: [],
        confidentiality: "public",
        launchContext: "",
        needsIntrospection: false,
      },
    });

    expect(values.isServer).toBe(false);
    expect(values.fhirBaseUrl).toBe("");
    expect(values.scopes).toBe("");
  });
});
