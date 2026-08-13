/**
 * The event view's filtering.
 *
 * The wireframe promises the filter bar narrows both tables live, and the two cases worth being
 * sure about are the ones a reader would notice and not report: a system that is both a server
 * and a client appearing in both tables, and two tag chips narrowing rather than widening.
 *
 * Author: John Grimes
 */

import { describe, expect, it } from "bun:test";

import {
  describeCheckStatus,
  describeDriftField,
  describeRegistrationMode,
  filterSystems,
  NO_FILTER,
  summariseScopes,
  systemsOfKind,
  toggleTag,
} from "./eventFilters.js";

import type { CheckStatus, EnrolledSystem } from "@muster/contracts";

/** An enrolled system, with only the fields the filters read given meaningful values. */
function system(overrides: Partial<EnrolledSystem>): EnrolledSystem {
  return {
    systemId: "00000000-0000-0000-0000-000000000001",
    enrolmentId: "00000000-0000-0000-0000-000000000002",
    name: "A System",
    description: "",
    organisation: { id: "00000000-0000-0000-0000-000000000003", name: "CSIRO" },
    kinds: ["server"],
    serverProfile: null,
    clientProfile: null,
    tags: [],
    confirmedAt: "2026-09-01T10:00:00.000Z",
    check: null,
    ...overrides,
  };
}

const SERVER = system({
  name: "MediRecords FHIR",
  organisation: { id: "org-1", name: "MediRecords" },
  kinds: ["server"],
  tags: ["smart-app-host"],
});

const CLIENT = system({
  systemId: "client-1",
  name: "Smart Forms",
  organisation: { id: "org-2", name: "CSIRO" },
  kinds: ["client"],
  tags: ["smart-app", "form-renderer-app"],
});

const BOTH = system({
  systemId: "both-1",
  name: "Beda EMR",
  description: "An EMR and the app that launches into it",
  organisation: { id: "org-3", name: "Beda Software" },
  kinds: ["server", "client"],
  tags: ["smart-app-host", "form-renderer-host", "smart-app"],
});

const ALL = [SERVER, CLIENT, BOTH];

describe("filterSystems", () => {
  it("admits everything when nothing is filtered", () => {
    expect(filterSystems(ALL, NO_FILTER)).toEqual(ALL);
  });

  it("admits a system that is both when either kind is asked for", () => {
    // Beda EMR is a server and a client, so it belongs in both answers.
    expect(
      filterSystems(ALL, { ...NO_FILTER, kind: "server" }).map(
        (row) => row.name,
      ),
    ).toEqual(["MediRecords FHIR", "Beda EMR"]);
    expect(
      filterSystems(ALL, { ...NO_FILTER, kind: "client" }).map(
        (row) => row.name,
      ),
    ).toEqual(["Smart Forms", "Beda EMR"]);
  });

  it("narrows rather than widens as tags are added", () => {
    // The failure this prevents: a second chip click that appears to undo the first.
    expect(
      filterSystems(ALL, { ...NO_FILTER, tags: ["smart-app-host"] }).map(
        (row) => row.name,
      ),
    ).toEqual(["MediRecords FHIR", "Beda EMR"]);
    expect(
      filterSystems(ALL, {
        ...NO_FILTER,
        tags: ["smart-app-host", "form-renderer-host"],
      }).map((row) => row.name),
    ).toEqual(["Beda EMR"]);
  });

  it("searches the organisation as well as the system", () => {
    // Two organisations may hold systems with the same name, so "which of these is
    // MediRecords'?" has to be answerable.
    expect(
      filterSystems(ALL, { ...NO_FILTER, search: "medirecords" }).map(
        (row) => row.name,
      ),
    ).toEqual(["MediRecords FHIR"]);
    expect(
      filterSystems(ALL, { ...NO_FILTER, search: "  BEDA " }).map(
        (row) => row.name,
      ),
    ).toEqual(["Beda EMR"]);
  });

  it("searches the description too", () => {
    expect(
      filterSystems(ALL, { ...NO_FILTER, search: "launches into" }).map(
        (row) => row.name,
      ),
    ).toEqual(["Beda EMR"]);
  });

  it("combines all three conditions", () => {
    expect(
      filterSystems(ALL, {
        kind: "client",
        tags: ["smart-app"],
        search: "beda",
      }).map((row) => row.name),
    ).toEqual(["Beda EMR"]);
    expect(
      filterSystems(ALL, {
        kind: "server",
        tags: ["smart-app"],
        search: "csiro",
      }),
    ).toEqual([]);
  });
});

describe("systemsOfKind", () => {
  it("puts a system that is both into both tables", () => {
    // The kind dropdown and the table a row belongs in are different questions.
    expect(systemsOfKind(ALL, "server").map((row) => row.name)).toEqual([
      "MediRecords FHIR",
      "Beda EMR",
    ]);
    expect(systemsOfKind(ALL, "client").map((row) => row.name)).toEqual([
      "Smart Forms",
      "Beda EMR",
    ]);
  });
});

describe("toggleTag", () => {
  it("turns a chip on and off again", () => {
    expect(toggleTag([], "smart-app")).toEqual(["smart-app"]);
    expect(toggleTag(["smart-app"], "smart-app")).toEqual([]);
  });

  it("keeps the order chips were clicked in", () => {
    // So the chips do not move around as they are clicked.
    expect(toggleTag(["a", "b"], "c")).toEqual(["a", "b", "c"]);
    expect(toggleTag(["a", "b", "c"], "b")).toEqual(["a", "c"]);
  });
});

describe("summariseScopes", () => {
  it("shows every scope when there are few enough", () => {
    expect(summariseScopes(["launch", "openid"], 5)).toBe("launch, openid");
  });

  it("counts the rest rather than cutting one in half", () => {
    // Truncating by characters would produce `patient/Observatio`, which reads as a scope
    // that does not exist.
    expect(
      summariseScopes(
        [
          "launch",
          "openid",
          "fhirUser",
          "patient/*.rs",
          "patient/Observation.rs",
        ],
        3,
      ),
    ).toBe("launch, openid, fhirUser and 2 more");
  });

  it("says nothing for no scopes", () => {
    expect(summariseScopes([])).toBe("");
  });
});

describe("describeRegistrationMode", () => {
  it("says that an open server needs no pairing", () => {
    // FR-016: the directory states that no registration is needed rather than offering a
    // request nobody should make.
    expect(describeRegistrationMode("open")).toContain("no registration");
  });

  it("names the other two modes", () => {
    expect(describeRegistrationMode("manual")).toBe("Manual request");
    expect(describeRegistrationMode("trustedDcr")).toBe("Trusted DCR");
  });
});

describe("describeCheckStatus", () => {
  /** Times are shown as the browser's own; the tests substitute a fixed formatter. */
  const at = (iso: string) => iso.slice(11, 16);

  /** A check as the API reports one. */
  function check(overrides: Partial<CheckStatus> = {}): CheckStatus {
    return {
      checkedAt: "2026-09-15T12:04:00.000Z",
      reachable: true,
      failureMode: null,
      detail: null,
      driftFlags: [],
      lastSuccessAt: "2026-09-15T12:04:00.000Z",
      ...overrides,
    };
  }

  it("says a server has not been checked rather than claiming it failed", () => {
    // A server nobody has looked at has not been found unreachable, and the entry says so.
    expect(describeCheckStatus(null, at)).toEqual({
      tone: "unknown",
      text: "Not checked yet",
    });
  });

  it("reads as the wireframe's own status for a reachable server", () => {
    expect(describeCheckStatus(check(), at)).toEqual({
      tone: "ok",
      text: "Reachable, checked 12:04",
    });
  });

  it("shows the last successful check beside an unreachable server (scenario 2)", () => {
    // The wireframe's "Unreachable since 09:31": the time is the last success, which is
    // what separates a server that has been down ten minutes from one that never worked.
    expect(
      describeCheckStatus(
        check({
          reachable: false,
          failureMode: "refused",
          lastSuccessAt: "2026-09-15T09:31:00.000Z",
        }),
        at,
      ),
    ).toEqual({ tone: "bad", text: "Unreachable since 09:31" });
  });

  it("distinguishes a slow server from a dead one", () => {
    // The spec's own edge case, on the page rather than only in the database.
    expect(
      describeCheckStatus(
        check({
          reachable: false,
          failureMode: "timeout",
          lastSuccessAt: "2026-09-15T09:31:00.000Z",
        }),
        at,
      ).text,
    ).toBe("Unreachable (timed out) since 09:31");
  });

  it("says the address was refused rather than blaming the server (scenario 5)", () => {
    expect(
      describeCheckStatus(
        check({
          reachable: false,
          failureMode: "guarded",
          lastSuccessAt: null,
        }),
        at,
      ),
    ).toEqual({
      tone: "bad",
      text: "Address refused, never reachable, checked 12:04",
    });
  });

  it("says a server has never answered when it never has", () => {
    expect(
      describeCheckStatus(
        check({
          reachable: false,
          failureMode: "refused",
          lastSuccessAt: null,
        }),
        at,
      ).text,
    ).toBe("Unreachable, never reachable, checked 12:04");
  });

  it("names an unusable answer as its own kind of failure", () => {
    expect(
      describeCheckStatus(
        check({
          reachable: false,
          failureMode: "invalid",
          lastSuccessAt: "2026-09-15T09:31:00.000Z",
        }),
        at,
      ).text,
    ).toBe("Unreachable (unusable answer) since 09:31");
  });
});

describe("describeDriftField", () => {
  it("names each declared field as a reader would say it", () => {
    // The drift box reads "declared token endpoint differs from advertised", so the field
    // has to be a phrase rather than an identifier.
    expect(describeDriftField("tokenEndpoint")).toBe("token endpoint");
    expect(describeDriftField("authorizationEndpoint")).toBe(
      "authorization endpoint",
    );
    expect(describeDriftField("registrationEndpoint")).toBe(
      "registration endpoint",
    );
    expect(describeDriftField("fhirBaseUrl")).toBe("FHIR base URL");
    expect(describeDriftField("authorizationMode")).toBe("authorization mode");
  });

  it("falls back to spacing out a field it does not know", () => {
    // A drift flag from a comparison added later still reads as English rather than as a
    // property name.
    expect(describeDriftField("jwksUri")).toBe("jwks uri");
  });
});
