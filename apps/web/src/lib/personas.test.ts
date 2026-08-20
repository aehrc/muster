/*
 * Copyright © 2026 Commonwealth Scientific and Industrial Research Organisation
 * (CSIRO) ABN 41 687 119 230. Licensed under the Apache License, Version 2.0.
 */

import { describe, expect, test } from "bun:test";

import {
  coverageCell,
  coverageColumns,
  coverageIndex,
  coverageRows,
  coverageSentence,
  coverageTally,
  coverageWords,
  describePersona,
  sourceNotice,
} from "./personas.ts";

import type {
  EnrolledSystem,
  Persona,
  PersonaCoverage,
  PersonasResponse,
} from "@muster/contracts";

/**
 * How the coverage grid reads.
 *
 * The grid is the whole point of the persona page, and its value is entirely in a
 * reader being able to tell four states apart: found, missing, could not be
 * searched, and not checked yet. The fourth is what these tests are mostly about -
 * a pair with no row must render as its own state rather than as a "missing", or
 * the page accuses a server owner of not having seeded data that nothing has
 * looked for.
 */

/** A persona the source still holds. */
const persona: Persona = {
  id: "persona-1",
  patientId: "baratz-toni",
  ihi: "8003608000311662",
  display: { name: "Toni BARATZ", birthDate: "1978-06-16", gender: "female" },
  sourceUrl: "https://source.example.org/fhir/Patient/baratz-toni",
  sourceStatus: "present",
  sourceCheckedAt: "2026-08-19T02:00:00.000Z",
  addedAt: "2026-08-18T02:00:00.000Z",
};

/**
 * An enrolled server, as the grid's columns arrive.
 *
 * @param enrolmentId - the enrolment the column is
 * @param name - what the system is called
 * @returns the entry
 */
const entry = (enrolmentId: string, name: string): EnrolledSystem => ({
  enrolmentId,
  tags: [],
  confirmedAt: "2026-08-18T02:00:00.000Z",
  system: {
    id: `system-${enrolmentId}`,
    organisationId: "organisation-1",
    name,
    description: "",
    kinds: ["server"],
    serverProfile: {
      fhirBaseUrl: `https://${name}.example.org/fhir`,
      authorizationMode: "smart",
      registrationMode: "manual",
      notes: "",
    },
    clientProfile: null,
  },
  organisation: { id: "organisation-1", name: "Vendor" },
  check: null,
  conformance: null,
});

/**
 * One recorded cell.
 *
 * @param enrolmentId - the server enrolment
 * @param outcome - what the search found
 * @param detail - the reason, blank to test the fallback wording
 * @returns the coverage row
 */
const cell = (
  enrolmentId: string,
  outcome: PersonaCoverage["outcome"],
  detail = "Because.",
): PersonaCoverage => ({
  personaId: persona.id,
  enrolmentId,
  outcome,
  detail,
  checkedAt: "2026-08-19T02:00:00.000Z",
});

/** A grid with three servers: one holding the persona, one not, one refusing. */
const response: PersonasResponse = {
  event: {
    slug: "sparked-2026-09",
    name: "Sparked",
    startsOn: "2026-09-01",
    endsOn: "2026-09-03",
    status: "open",
    capabilityTags: [],
    personaSourceUrl: "https://source.example.org/fhir",
    graceDays: 7,
  },
  personas: [persona],
  servers: [
    entry("holder", "holder"),
    entry("empty", "empty"),
    entry("secure", "secure"),
  ],
  coverage: [
    cell("holder", "found"),
    cell("empty", "missing"),
    cell("secure", "unverifiable"),
  ],
};

describe("the coverage grid", () => {
  test("names one column per enrolled server, in the order given", () => {
    expect(
      coverageColumns(response).map((server) => server.enrolmentId),
    ).toEqual(["holder", "empty", "secure"]);
  });

  test("builds one row per persona with one cell per server", () => {
    const rows = coverageRows(response);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.persona.id).toBe(persona.id);
    expect(rows[0]?.cells.map((one) => one.state)).toEqual([
      "found",
      "missing",
      "unverifiable",
    ]);
  });

  test("carries the recorded reason into the cell", () => {
    const rows = coverageRows(response);
    expect(rows[0]?.cells[2]?.detail).toBe("Because.");
    expect(rows[0]?.cells[2]?.checkedAt).toBe("2026-08-19T02:00:00.000Z");
  });

  // A cell recorded without a reason still says what its state means, rather than
  // showing a badge with nothing behind it.
  test("falls back to the meaning when a cell recorded no reason", () => {
    const index = coverageIndex([cell("holder", "found", "")]);
    expect(coverageCell(index, persona.id, "holder").detail).toContain("IHI");
  });

  // The state that matters most: nothing has looked, which is not "missing".
  test("renders a pair nothing has checked as unchecked", () => {
    const index = coverageIndex(response.coverage);
    const missing = coverageCell(index, persona.id, "never-checked");
    expect(missing.state).toBe("unchecked");
    expect(missing.checkedAt).toBeNull();
    expect(coverageWords[missing.state]).toBe("Not checked");
  });

  test("indexes cells by persona as well as by server", () => {
    const index = coverageIndex(response.coverage);
    expect(coverageCell(index, "another-persona", "holder").state).toBe(
      "unchecked",
    );
  });

  test("tallies a row by state", () => {
    const row = coverageRows({
      ...response,
      servers: [...response.servers, entry("fresh", "fresh")],
    })[0];
    expect(row === undefined ? null : coverageTally(row)).toEqual({
      found: 1,
      missing: 1,
      unverifiable: 1,
      unchecked: 1,
    });
  });
});

describe("the coverage sentence", () => {
  // The unverifiable servers are named separately: "found at 1 of 3" would invite
  // the reader to conclude the other two do not hold the patient.
  test("counts only the servers that were searched, and names the rest", () => {
    const row = coverageRows(response)[0];
    const sentence = row === undefined ? "" : coverageSentence(row);
    expect(sentence).toBe(
      "Found at 1 of 2 searched servers; 1 could not be searched.",
    );
  });

  test("says so when nothing has been searched yet", () => {
    const row = coverageRows({ ...response, coverage: [] })[0];
    expect(row === undefined ? "" : coverageSentence(row)).toBe(
      "No enrolled server has been searched for this persona yet; 3 not checked yet.",
    );
  });

  test("says so when no server is enrolled", () => {
    const row = coverageRows({ ...response, servers: [], coverage: [] })[0];
    expect(row === undefined ? "" : coverageSentence(row)).toBe(
      "No server is enrolled in this event yet.",
    );
  });

  test("uses the singular for one searched server", () => {
    const row = coverageRows({
      ...response,
      servers: [entry("holder", "holder")],
      coverage: [cell("holder", "found")],
    })[0];
    expect(row === undefined ? "" : coverageSentence(row)).toBe(
      "Found at 1 of 1 searched server.",
    );
  });
});

describe("a persona on screen", () => {
  test("describes the demographics the source stated", () => {
    expect(describePersona(persona)).toBe("Born 1978-06-16, female");
  });

  test("omits demographics the source did not state", () => {
    expect(
      describePersona({
        ...persona,
        display: { name: "Nobody", birthDate: null, gender: null },
      }),
    ).toBe("No demographics were recorded.");
  });

  test("says nothing about a persona the source still holds", () => {
    expect(sourceNotice(persona)).toBeNull();
  });

  // The edge case, as an admin sees it.
  test("flags a persona the source no longer holds", () => {
    expect(sourceNotice({ ...persona, sourceStatus: "missing" })).toContain(
      "re-curating",
    );
  });
});
