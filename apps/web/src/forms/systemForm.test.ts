/**
 * Turning the system form into a request body.
 *
 * The cases that matter are the lossy ones: a list typed as text, a profile switched off, and a
 * value the participant got wrong. The last is the one worth being careful about - a console that
 * silently corrected it would give the participant an entry they did not enter.
 *
 * Author: John Grimes
 */

import { describe, expect, it } from "bun:test";

import {
  EMPTY_SYSTEM_FORM,
  systemForm,
  systemFormProblem,
  systemRequest,
} from "./systemForm.js";

import type { OrganisationSystem } from "@muster/contracts";

/** A system carrying both profiles, as the API reports one. */
const BOTH: OrganisationSystem = {
  id: "system-1",
  name: "Beda EMR",
  description: "Server and client",
  kinds: ["server", "client"],
  serverProfile: {
    fhirBaseUrl: "https://emr.example/fhir",
    authorizationMode: "smart",
    registrationMode: "trustedDcr",
    registrationEndpoint: "https://emr.example/register",
    authorizationEndpoint: "https://emr.example/auth/authorize",
    tokenEndpoint: "https://emr.example/auth/token",
    notes: "Ask in the channel",
  },
  clientProfile: {
    launchUrl: "https://emr.example/launch",
    redirectUris: ["https://emr.example/cb", "https://emr.example/cb-dev"],
    scopes: ["launch", "openid", "patient/*.rs"],
    confidentiality: "confidential",
    launchContext: "patient",
    needsIntrospection: true,
  },
  enrolments: [],
};

describe("systemForm", () => {
  it("fills the form from a system carrying both profiles", () => {
    const form = systemForm(BOTH);

    expect(form.isServer).toBe(true);
    expect(form.isClient).toBe(true);
    // The lists become the text a person edits: one URI per line, scopes space-separated as
    // SMART writes them.
    expect(form.redirectUris).toBe(
      "https://emr.example/cb\nhttps://emr.example/cb-dev",
    );
    expect(form.scopes).toBe("launch openid patient/*.rs");
    expect(form.needsIntrospection).toBe(true);
  });

  it("fills the server half with defaults for a client-only system", () => {
    const form = systemForm({
      ...BOTH,
      kinds: ["client"],
      serverProfile: null,
    });

    expect(form.isServer).toBe(false);
    expect(form.fhirBaseUrl).toBe("");
    // Sensible defaults rather than empty selects, so turning the checkbox on produces a
    // valid profile rather than a form full of blanks.
    expect(form.authorizationMode).toBe("smart");
    expect(form.registrationMode).toBe("manual");
  });
});

describe("systemRequest", () => {
  it("round-trips a system through the form unchanged", () => {
    // The property that matters for editing: opening a system and saving it without touching
    // anything must not change it.
    const request = systemRequest(systemForm(BOTH));

    expect(request.serverProfile).toEqual(BOTH.serverProfile);
    expect(request.clientProfile).toEqual(BOTH.clientProfile);
    expect(request.name).toBe("Beda EMR");
  });

  it("sends null for a profile whose checkbox is off", () => {
    const request = systemRequest({ ...systemForm(BOTH), isClient: false });

    // This is what makes an edit that narrows a system to one kind actually remove the other
    // profile, rather than silently retaining it.
    expect(request.clientProfile).toBeNull();
    expect(request.serverProfile).not.toBeNull();
  });

  it("drops blank lines and extra whitespace from the lists", () => {
    const request = systemRequest({
      ...EMPTY_SYSTEM_FORM,
      isClient: true,
      redirectUris: "  https://a.example/cb  \n\n\n  https://b.example/cb\n",
      scopes: "  launch   openid \n fhirUser  ",
    });

    expect(request.clientProfile?.redirectUris).toEqual([
      "https://a.example/cb",
      "https://b.example/cb",
    ]);
    expect(request.clientProfile?.scopes).toEqual([
      "launch",
      "openid",
      "fhirUser",
    ]);
  });

  it("sends a value that will not do exactly as it was typed", () => {
    const request = systemRequest({
      ...EMPTY_SYSTEM_FORM,
      fhirBaseUrl: "not a url",
    });

    // So the server refuses it and names the field. A console that guessed what was meant is
    // how a participant ends up with an entry they did not enter.
    expect(request.serverProfile?.fhirBaseUrl).toBe("not a url");
  });

  it("sends an absent registration endpoint as null rather than an empty string", () => {
    const request = systemRequest({
      ...EMPTY_SYSTEM_FORM,
      registrationEndpoint: "   ",
    });

    // An empty string is not a URL, and the contract's field is nullable.
    expect(request.serverProfile?.registrationEndpoint).toBeNull();
  });
});

describe("systemFormProblem", () => {
  it("admits a form that names at least one kind", () => {
    expect(systemFormProblem(EMPTY_SYSTEM_FORM)).toBeUndefined();
  });

  it("refuses a system that is neither a server nor a client", () => {
    // The same rule the schema's check constraint holds, said before the round trip.
    expect(
      systemFormProblem({
        ...EMPTY_SYSTEM_FORM,
        isServer: false,
        isClient: false,
      }),
    ).toContain("server, a client, or both");
  });

  it("refuses a trusted-DCR server with nowhere to present a statement", () => {
    expect(
      systemFormProblem({
        ...EMPTY_SYSTEM_FORM,
        registrationMode: "trustedDcr",
      }),
    ).toContain("registration endpoint");
  });

  it("admits a trusted-DCR server once it has an endpoint", () => {
    expect(
      systemFormProblem({
        ...EMPTY_SYSTEM_FORM,
        registrationMode: "trustedDcr",
        registrationEndpoint: "https://emr.example/register",
      }),
    ).toBeUndefined();
  });
});
