#!/usr/bin/env bun
/*
 * Copyright © 2026 Commonwealth Scientific and Industrial Research Organisation
 * (CSIRO) ABN 41 687 119 230. Licensed under the Apache License, Version 2.0.
 */

/**
 * A recorded persona source for the local stack.
 *
 * The event's persona set is anchored to one source server: an admin searches it,
 * names a patient, and Muster reads that patient and records what it read (US7).
 * The programme's own source is the live Sparked AU Core server, which is the
 * default the seed script uses. This stub is the recorded fixture the quickstart
 * offers as the alternative, so that the persona scenarios can be demonstrated
 * and tested without depending on somebody else's server being up.
 *
 * It answers the three requests Muster makes of a source, and nothing else: the
 * name search an admin's query becomes, the identifier search a coverage cell
 * becomes, and the read of one patient. It also answers `/metadata`, because a
 * server enrolled in an event is checked for reachability like any other - which
 * is what lets the same instance stand in for a server that holds the persona.
 *
 * Two patients are held, and the second one is the point of it: a patient with no
 * IHI must be refused, with the identifier system named, and a fixture with only
 * eligible patients could not show that.
 *
 * Nothing here is Muster's code path. It is a FHIR server, written to what a FHIR
 * server does.
 *
 * Usage: `bun deploy/stubs/personaSource.ts`, with `STUB_PORT` and
 * `STUB_IHI_SYSTEM`.
 *
 * @author John Grimes
 */

/**
 * A patient, as much of one as this fixture needs.
 *
 * Written out rather than imported from `@types/fhir`: the stub is one file
 * mounted into a bare Bun image, with no `node_modules` to resolve a type from.
 */
type Patient = {
  /** always `Patient` */
  readonly resourceType: "Patient";
  /** the resource identifier */
  readonly id: string;
  /** the business identifiers the patient carries */
  readonly identifier: readonly {
    /** the identifier system */
    readonly system: string;
    /** the identifier value */
    readonly value: string;
  }[];
  /** whether the record is in use */
  readonly active: boolean;
  /** the patient's names */
  readonly name: readonly {
    /** the family name */
    readonly family: string;
    /** the given names */
    readonly given: readonly string[];
    /** the whole name as one line */
    readonly text: string;
  }[];
  /** the administrative gender */
  readonly gender: string;
  /** the date of birth */
  readonly birthDate: string;
};

/** Where this stub listens. */
const port = Number(process.env["STUB_PORT"] ?? "9092");

/** The identifier system this source asserts an IHI under. */
const ihiSystem =
  process.env["STUB_IHI_SYSTEM"] ??
  "http://ns.electronichealth.net.au/id/hi/ihi/1.0";

/**
 * The patients this source holds.
 *
 * Charlotte Morris is the Sparked persona quickstart scenarios 6 and 7 use, with
 * the IHI the programme's test data gives her. Jordan Vale carries a Medicare
 * number and no IHI, so adding her is refused - which is the acceptance scenario
 * that an admin is told why rather than being shown a patient that will not
 * appear.
 */
const patients: readonly Patient[] = [
  {
    resourceType: "Patient",
    id: "charlotte-morris",
    identifier: [{ system: ihiSystem, value: "8003608500314687" }],
    active: true,
    name: [
      { family: "Morris", given: ["Charlotte"], text: "Charlotte Morris" },
    ],
    gender: "female",
    birthDate: "1975-04-12",
  },
  {
    resourceType: "Patient",
    id: "jordan-vale",
    identifier: [
      {
        system: "http://ns.electronichealth.net.au/id/medicare-number",
        value: "2951156481",
      },
    ],
    active: true,
    name: [{ family: "Vale", given: ["Jordan"], text: "Jordan Vale" }],
    gender: "male",
    birthDate: "1988-11-02",
  },
];

/** What this server says it can do, for the reachability check to read. */
const capabilityStatement = {
  resourceType: "CapabilityStatement",
  status: "active",
  date: "2026-08-19",
  kind: "instance",
  software: { name: "Muster stub persona source" },
  fhirVersion: "4.0.1",
  format: ["application/fhir+json"],
  rest: [
    {
      mode: "server",
      security: { cors: true, description: "Anonymous read and search." },
      resource: [
        {
          type: "Patient",
          interaction: [{ code: "read" }, { code: "search-type" }],
          searchParam: [
            { name: "identifier", type: "token" },
            { name: "name", type: "string" },
          ],
        },
      ],
    },
  ],
};

/**
 * Reports whether a patient carries an identifier.
 *
 * @param patient - the patient to read
 * @param token - the search token, as `system|value` or a bare value
 * @returns true when the patient carries it
 */
const carriesIdentifier = (patient: Patient, token: string): boolean => {
  const [system, value] = token.includes("|")
    ? token.split("|")
    : [undefined, token];
  return patient.identifier.some(
    (identifier) =>
      (system === undefined || system === "" || identifier.system === system) &&
      identifier.value === value,
  );
};

/**
 * Reports whether a patient's name matches a search.
 *
 * Case-insensitive substring matching over the parts, which is what a FHIR
 * `string` search parameter does closely enough for two patients.
 *
 * @param patient - the patient to read
 * @param query - what was searched for
 * @returns true when any part of the name matches
 */
const matchesName = (patient: Patient, query: string): boolean => {
  const wanted = query.trim().toLowerCase();
  return patient.name.some((name) =>
    [name.text, name.family, ...name.given].some((part) =>
      part.toLowerCase().includes(wanted),
    ),
  );
};

/**
 * Builds a searchset bundle.
 *
 * `_summary=count` answers with the total alone, which is what Muster asks for
 * when the question is only whether a patient with an IHI is here.
 *
 * @param found - the patients that matched
 * @param countOnly - whether the caller asked for the count alone
 * @returns the bundle to answer with
 */
const searchset = (found: readonly Patient[], countOnly: boolean) => ({
  resourceType: "Bundle",
  type: "searchset",
  total: found.length,
  ...(countOnly
    ? {}
    : {
        entry: found.map((patient) => ({
          fullUrl: `http://localhost:${String(port)}/fhir/Patient/${patient.id}`,
          resource: patient,
        })),
      }),
});

/**
 * Answers a search of the patients.
 *
 * @param parameters - the query as it arrived
 * @returns the searchset
 */
const search = (parameters: URLSearchParams): Response => {
  const identifier = parameters.get("identifier");
  const name = parameters.get("name");
  const found = patients.filter(
    (patient) =>
      (identifier === null || carriesIdentifier(patient, identifier)) &&
      (name === null || matchesName(patient, name)),
  );
  const limit = Number(parameters.get("_count") ?? "50");
  const limited = Number.isFinite(limit) && limit > 0 ? limit : 50;
  return Response.json(
    searchset(found.slice(0, limited), parameters.get("_summary") === "count"),
    { headers: { "content-type": "application/fhir+json" } },
  );
};

/**
 * Answers a read of one patient.
 *
 * @param id - the resource identifier asked for
 * @returns the patient, or a FHIR OperationOutcome
 */
const read = (id: string): Response => {
  const found = patients.find((patient) => patient.id === id);
  return found === undefined
    ? Response.json(
        {
          resourceType: "OperationOutcome",
          issue: [
            {
              severity: "error",
              code: "not-found",
              diagnostics: `No Patient with the identifier ${id}.`,
            },
          ],
        },
        { status: 404, headers: { "content-type": "application/fhir+json" } },
      )
    : Response.json(found, {
        headers: { "content-type": "application/fhir+json" },
      });
};

const server = Bun.serve({
  port,
  fetch: (request) => {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/healthz") {
      return Response.json({
        status: "ok",
        ihiSystem,
        patients: patients.map((patient) => ({
          id: patient.id,
          identifiers: patient.identifier.map(
            (identifier) => `${identifier.system}|${identifier.value}`,
          ),
        })),
      });
    }

    if (request.method === "GET" && url.pathname === "/fhir/metadata") {
      return Response.json(capabilityStatement, {
        headers: { "content-type": "application/fhir+json" },
      });
    }

    if (request.method === "GET" && url.pathname === "/fhir/Patient") {
      return search(url.searchParams);
    }

    const one = /^\/fhir\/Patient\/([\w-]+)$/.exec(url.pathname);
    if (request.method === "GET" && one !== null) {
      return read(one[1] ?? "");
    }

    return Response.json(
      {
        resourceType: "OperationOutcome",
        issue: [
          {
            severity: "error",
            code: "not-supported",
            diagnostics: "This source answers Patient search and read only.",
          },
        ],
      },
      { status: 404, headers: { "content-type": "application/fhir+json" } },
    );
  },
});

console.log(
  `Stub persona source listening on ${server.url.toString()}, ` +
    `holding ${String(patients.length)} patient(s) under ${ihiSystem}: ` +
    patients
      .map(
        (patient) => `${patient.name[0]?.text ?? ""} (Patient/${patient.id})`,
      )
      .join(", "),
);
