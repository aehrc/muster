import { z } from "zod";

import { coverageOutcomeSchema } from "./common.ts";
import { enrolledSystemSchema, eventDetailSchema } from "./directory.ts";

/**
 * The shared persona index's wire shapes: the personas an event curates from its
 * source server, and the coverage grid over its enrolled servers.
 *
 * A persona is identified by its IHI and nothing else. That is the whole point of
 * anchoring the set to one source server: two participants seeding their systems
 * from the same patient produce records with different identifiers, different
 * names and sometimes different birth dates, and the only thing that reliably
 * matches across them is the national identifier (FR-031). So the IHI is required
 * of every persona, and a candidate without one is refused with the reason rather
 * than added on the strength of a name.
 *
 * The coverage grid is deliberately three-valued (FR-032). `found` and `missing`
 * are answers; `unverifiable` is the honest absence of one, for a server that
 * cannot be searched without authorization. Collapsing it into `missing` would
 * accuse a server owner of not having seeded data they may well hold.
 *
 * All of it is public. Personas are test patients on a test server, so a grid
 * that needed a sign-in would be a private page about published fiction (SC-006).
 *
 * @author John Grimes
 */

/**
 * A persona's demographics, as curated from the source.
 *
 * Just enough to recognise the person on a screen and to tell two personas apart
 * in a picker. Muster is an index, not a store: anything else about the patient
 * is read from the source server, which is what the canonical link is for.
 */
export const personaDisplaySchema = z.object({
  /** the name as rendered from the source record */
  name: z.string(),
  /** the birth date as the source states it, null when it states none */
  birthDate: z.string().nullable(),
  /** the administrative gender as the source states it, null when it states none */
  gender: z.string().nullable(),
});

/** A persona's demographics. */
export type PersonaDisplay = z.infer<typeof personaDisplaySchema>;

/** Whether the source server still holds the patient a persona was curated from. */
export const personaSourceStatusSchema = z.enum(["present", "missing"]);

/** Whether the source server still holds the patient. */
export type PersonaSourceStatus = z.infer<typeof personaSourceStatusSchema>;

/**
 * One curated persona.
 *
 * `sourceStatus` is the flag the edge case asks for: a patient the source has
 * deleted, or whose IHI has changed under it, reads `missing` so that an admin
 * sees on the event management view that the set has rotted, rather than every
 * server in the grid quietly turning up empty.
 */
export const personaSchema = z.object({
  id: z.string(),
  /** the resource identifier on the source server */
  patientId: z.string(),
  /** the IHI, asserted under the configured identifier system */
  ihi: z.string(),
  display: personaDisplaySchema,
  /** the canonical record on the source server, as resolved when it was added */
  sourceUrl: z.string(),
  sourceStatus: personaSourceStatusSchema,
  /** when the source was last read, null when it has not been since it was added */
  sourceCheckedAt: z.string().nullable(),
  /** when it joined the event's set */
  addedAt: z.string(),
});

/** One curated persona. */
export type Persona = z.infer<typeof personaSchema>;

/**
 * One cell of the coverage grid: the latest outcome for one persona at one
 * enrolled server.
 *
 * `detail` carries the reason, which matters most for `unverifiable`: "the server
 * requires authorization" and "the guard refused the address" are the same cell
 * to a reader who is only shown the word.
 */
export const personaCoverageSchema = z.object({
  personaId: z.string(),
  enrolmentId: z.string(),
  outcome: coverageOutcomeSchema,
  detail: z.string(),
  checkedAt: z.string(),
});

/** One cell of the coverage grid. */
export type PersonaCoverage = z.infer<typeof personaCoverageSchema>;

/**
 * `GET /api/events/{slug}/personas`: the personas and the grid.
 *
 * The servers travel with the personas because they are the grid's columns, and a
 * column with no name is not a grid. They carry no contact details: this is an
 * anonymous surface, and FR-007 does not bend for a page about test data.
 */
export const personasResponseSchema = z.object({
  event: eventDetailSchema,
  personas: z.array(personaSchema),
  /** the event's enrolled servers, which are the grid's columns */
  servers: z.array(enrolledSystemSchema),
  /** the latest outcome per (persona, server); absent pairs have not been checked */
  coverage: z.array(personaCoverageSchema),
});

/** The personas and the grid. */
export type PersonasResponse = z.infer<typeof personasResponseSchema>;

/** A patient on the source that could join the set. */
export const personaCandidateSchema = z.object({
  patientId: z.string(),
  ihi: z.string(),
  display: personaDisplaySchema,
});

/** A patient on the source that could join the set. */
export type PersonaCandidate = z.infer<typeof personaCandidateSchema>;

/**
 * A patient the search found and will not offer, and why.
 *
 * Reported rather than dropped: an admin searching for a patient they can see on
 * the source server needs to be told why it is not on the list, or they will
 * conclude the search is broken (acceptance scenario 2).
 */
export const ineligibleCandidateSchema = z.object({
  patientId: z.string(),
  detail: z.string(),
});

/** A patient the search found and will not offer. */
export type IneligibleCandidate = z.infer<typeof ineligibleCandidateSchema>;

/** `GET /api/admin/events/{slug}/persona-search?q=`. */
export const personaSearchResponseSchema = z.object({
  event: eventDetailSchema,
  /** the URL that was searched, so an admin can see what was asked */
  searched: z.string(),
  candidates: z.array(personaCandidateSchema),
  ineligible: z.array(ineligibleCandidateSchema),
});

/** The proxied search of the persona source. */
export type PersonaSearchResponse = z.infer<typeof personaSearchResponseSchema>;

/**
 * `POST /api/admin/events/{slug}/personas`.
 *
 * The patient identifier only. The demographics and the IHI are read from the
 * source rather than accepted from the caller: a persona whose IHI arrived in a
 * request body is a persona nothing anchors (FR-031).
 */
export const createPersonaRequestSchema = z.object({
  patientId: z.string().trim().min(1).max(200),
});

/** `POST /api/admin/events/{slug}/personas`. */
export type CreatePersonaRequest = z.infer<typeof createPersonaRequestSchema>;

/** The answer to adding a persona. */
export const personaResponseSchema = z.object({
  event: eventDetailSchema,
  persona: personaSchema,
});

/** The answer to adding a persona. */
export type PersonaResponse = z.infer<typeof personaResponseSchema>;
