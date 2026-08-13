/**
 * The pairing request form, as data.
 *
 * Two things happen before a request is sent, and both are the sort of thing that is either a
 * tested function or a bug reported at a connectathon. The clients a member may offer as the
 * requesting side are the ones their organisations own *and* have enrolled in this event
 * (FR-012, scenario 6). The field set is then prefilled from the chosen client's own record and
 * editable before submission, which means text boxes holding lists that have to survive the round
 * trip back into arrays.
 *
 * Author: John Grimes
 */

import { describe, expect, it } from "bun:test";

import {
  clientCandidates,
  pairingRequestForm,
  pairingRequestFormProblem,
  registrationFieldsFrom,
} from "./pairingRequestForm.js";

import type { MyOrganisation } from "@muster/contracts";

/** A client system, enrolled in the events named. */
function clientSystem(
  id: string,
  name: string,
  eventSlugs: readonly string[],
): MyOrganisation["systems"][number] {
  return {
    id,
    name,
    description: "",
    kinds: ["client"],
    serverProfile: null,
    clientProfile: {
      launchUrl: "https://smartforms.csiro.au/launch",
      redirectUris: [
        "https://smartforms.csiro.au/",
        "https://smartforms.csiro.au/",
      ],
      scopes: ["launch", "openid", "fhirUser"],
      confidentiality: "public",
      launchContext: "patient",
      needsIntrospection: false,
    },
    enrolments: eventSlugs.map((slug, index) => ({
      id: `${id}-enrolment-${String(index)}`,
      eventSlug: slug,
      eventName: slug,
      eventStatus: "open" as const,
      tags: [],
      confirmedAt: "2026-09-01T00:00:00.000Z",
    })),
  };
}

/** One organisation holding the systems named. */
function organisation(
  id: string,
  systems: readonly MyOrganisation["systems"][number][],
): MyOrganisation {
  return { id, name: `Organisation ${id}`, members: [], systems: [...systems] };
}

describe("clientCandidates", () => {
  it("offers a client enrolled in this event", () => {
    const mine = [
      organisation("org-1", [
        clientSystem("system-1", "Smart Forms", ["sparked-2026-09"]),
      ]),
    ];

    expect(clientCandidates(mine, "sparked-2026-09")).toEqual([
      {
        enrolmentId: "system-1-enrolment-0",
        systemId: "system-1",
        name: "Smart Forms",
        organisationId: "org-1",
      },
    ]);
  });

  it("does not offer a client enrolled only in another event", () => {
    // Scenario 6: a pairing exists within a single event, so a client that is not here cannot be
    // the requesting side here.
    const mine = [
      organisation("org-1", [
        clientSystem("system-1", "Smart Forms", ["sparked-2025-12"]),
      ]),
    ];

    expect(clientCandidates(mine, "sparked-2026-09")).toEqual([]);
  });

  it("does not offer a system that is not a client", () => {
    const server = {
      ...clientSystem("system-2", "MediRecords FHIR", ["sparked-2026-09"]),
      kinds: ["server" as const],
      clientProfile: null,
    };

    expect(
      clientCandidates([organisation("org-1", [server])], "sparked-2026-09"),
    ).toEqual([]);
  });

  it("offers the clients of every organisation the caller belongs to", () => {
    const mine = [
      organisation("org-1", [
        clientSystem("system-1", "Smart Forms", ["sparked-2026-09"]),
      ]),
      organisation("org-2", [
        clientSystem("system-2", "MIMS", ["sparked-2026-09"]),
      ]),
    ];

    expect(
      clientCandidates(mine, "sparked-2026-09").map((one) => one.name),
    ).toEqual(["Smart Forms", "MIMS"]);
  });

  it("offers nothing when the caller belongs to no organisation", () => {
    expect(clientCandidates([], "sparked-2026-09")).toEqual([]);
  });
});

describe("pairingRequestForm", () => {
  it("prefills the fields from the client's record", () => {
    // FR-012: prefilled from the client record, and editable before submission. The lists become
    // text so that a half-typed URL is what was typed rather than a value converted on every
    // keystroke.
    const system = clientSystem("system-1", "Smart Forms", ["sparked-2026-09"]);

    expect(pairingRequestForm(system)).toEqual({
      clientName: "Smart Forms",
      launchUrl: "https://smartforms.csiro.au/launch",
      redirectUris: "https://smartforms.csiro.au/",
      scopes: "launch openid fhirUser",
      confidentiality: "public",
      launchContext: "patient",
      needsIntrospection: false,
    });
  });

  it("holds nothing for a system with no client profile", () => {
    const system = {
      ...clientSystem("system-1", "Smart Forms", []),
      clientProfile: null,
    };

    expect(pairingRequestForm(system)).toMatchObject({
      clientName: "Smart Forms",
      launchUrl: "",
      redirectUris: "",
      scopes: "",
    });
  });
});

describe("registrationFieldsFrom", () => {
  it("turns the form back into the field set the API takes", () => {
    const fields = registrationFieldsFrom({
      clientName: "Smart Forms",
      launchUrl: " https://smartforms.csiro.au/launch ",
      redirectUris:
        "https://smartforms.csiro.au/\nhttps://smartforms.csiro.au/callback\n",
      scopes: "launch  openid\nfhirUser",
      confidentiality: "public",
      launchContext: "patient",
      needsIntrospection: false,
    });

    expect(fields).toEqual({
      clientName: "Smart Forms",
      launchUrl: "https://smartforms.csiro.au/launch",
      redirectUris: [
        "https://smartforms.csiro.au/",
        "https://smartforms.csiro.au/callback",
      ],
      scopes: ["launch", "openid", "fhirUser"],
      confidentiality: "public",
      launchContext: "patient",
      needsIntrospection: false,
    });
  });

  it("passes an unparseable URL through as typed", () => {
    // The server names the offending field. The console guessing what was meant is how a
    // participant ends up registered with a redirect URI they did not enter.
    expect(
      registrationFieldsFrom({
        clientName: "Smart Forms",
        launchUrl: "not a url",
        redirectUris: "also not a url",
        scopes: "launch",
        confidentiality: "confidential",
        launchContext: "",
        needsIntrospection: true,
      }),
    ).toMatchObject({
      launchUrl: "not a url",
      redirectUris: ["also not a url"],
      confidentiality: "confidential",
      needsIntrospection: true,
    });
  });
});

describe("pairingRequestFormProblem", () => {
  const complete = {
    clientName: "Smart Forms",
    launchUrl: "https://smartforms.csiro.au/launch",
    redirectUris: "https://smartforms.csiro.au/",
    scopes: "launch",
    confidentiality: "public",
    launchContext: "",
    needsIntrospection: false,
  };

  it("finds nothing wrong with a complete form", () => {
    expect(pairingRequestFormProblem(complete)).toBeUndefined();
  });

  it("names the missing redirect URI", () => {
    // The same minimum the server holds, said before the round trip rather than instead of it.
    expect(
      pairingRequestFormProblem({ ...complete, redirectUris: "  " }),
    ).toContain("redirect URI");
  });

  it("names the missing scopes", () => {
    expect(pairingRequestFormProblem({ ...complete, scopes: "" })).toContain(
      "scope",
    );
  });

  it("names the missing client name", () => {
    expect(
      pairingRequestFormProblem({ ...complete, clientName: " " }),
    ).toContain("client name");
  });

  it("names the missing launch URL", () => {
    expect(pairingRequestFormProblem({ ...complete, launchUrl: "" })).toContain(
      "launch URL",
    );
  });
});
