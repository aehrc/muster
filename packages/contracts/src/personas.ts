/**
 * What a shared persona and its coverage say about themselves, on the wire.
 *
 * Everything here is a public read surface (constitution principle V, spec scenario 5):
 * the persona cards and the coverage grid are readable without an account, because a
 * shared test patient is test data by design and a grid that needed a sign-in would not
 * be the cross-server check FR-032 asks for. That is also why there is nothing here to
 * gate: a persona carries a fabricated name, a test IHI and an identifier on a test
 * server, and no contact detail of any kind.
 *
 * Three decisions worth stating.
 *
 * **The IHI carries its system.** A sixteen-digit string on a page is not an identifier;
 * the pair is. `ihiSystem` rides on every persona so that a reader copying a persona into
 * their own server, and a client reading this API, both see the namespace the value
 * belongs to rather than having to know it (FR-031).
 *
 * **A cell carries its time and its reason.** FR-032 requires check times on the grid,
 * and `unverifiable` is useless without saying why - "requires authorization" and
 * "answered with something that is not a searchset" are different problems for the
 * server's owner. So `checkedAt` and `detail` are on the cell rather than on the grid.
 *
 * **A search result has two lists.** FR-031 makes only IHI-bearing patients eligible, and
 * scenario 2 requires the reason to be *stated* rather than the candidate silently
 * vanishing - so the refused ones come back too, each with why.
 *
 * Author: John Grimes
 */

import { z } from "zod";

import {
  personaCoverageOutcomeSchema,
  personaSourceStatusSchema,
} from "./common.js";
import { eventDetailSchema, organisationRefSchema } from "./directory.js";

/**
 * A FHIR resource identifier, as the source server spells it.
 *
 * Constrained to the FHIR `id` production, and that is a guard rather than tidiness: the
 * value is concatenated into an address on somebody else's server, so a value carrying a
 * slash or a dot-dot segment would be a way to point the persona routes at a path the
 * event's configured source never named.
 *
 * @see https://hl7.org/fhir/R4/datatypes.html#id
 */
export const fhirIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9\-.]+$/, {
    message: "Must be a FHIR id: letters, digits, hyphens and dots only",
  });

/** The demographics a persona is curated with. */
export const personaDisplaySchema = z.object({
  /** The patient's name as the source server states it. */
  name: z.string(),
  /** `Patient.birthDate`, or null when the source records none. */
  birthDate: z.string().nullable(),
});

/**
 * One curated persona (FR-031).
 *
 * `canonicalUrl` is derived from the event's configured source rather than stored, so an
 * admin who corrects the source address does not leave a directory full of links to the
 * old one.
 */
export const personaSchema = z.object({
  id: z.uuid(),
  display: personaDisplaySchema,
  ihi: z.string(),
  /** The namespace `ihi` belongs to. Fixed by configuration for the deployment. */
  ihiSystem: z.string(),
  /** The patient's identifier on the source server. */
  patientId: fhirIdSchema,
  /** Where the canonical record lives, or null when the event names no source. */
  canonicalUrl: z.string().nullable(),
  sourceStatus: personaSourceStatusSchema,
  /** When the source was last asked about this persona, or null when it never has been. */
  sourceCheckedAt: z.string().nullable(),
});

/** A column of the coverage grid: one enrolled server. */
export const personaCoverageServerSchema = z.object({
  enrolmentId: z.uuid(),
  systemId: z.uuid(),
  systemName: z.string(),
  organisation: organisationRefSchema,
});

/** One cell of the coverage grid: what one server said about one persona (FR-032). */
export const personaCoverageCellSchema = z.object({
  personaId: z.uuid(),
  enrolmentId: z.uuid(),
  outcome: personaCoverageOutcomeSchema,
  /** Why, in words a server owner can act on. Null when the patient was simply found. */
  detail: z.string().nullable(),
  checkedAt: z.string(),
});

/**
 * The persona page: the cards, the grid's columns, and its filled cells.
 *
 * The cells are a flat list rather than a matrix, because a pair nothing has checked has
 * no cell at all - which is not the same claim as `missing`. A grid built from a matrix
 * would have to invent a value for it.
 */
export const eventPersonasSchema = z.object({
  event: eventDetailSchema,
  personas: z.array(personaSchema),
  /** Enrolled servers only: a client holds no patients, so it is not a column. */
  servers: z.array(personaCoverageServerSchema),
  coverage: z.array(personaCoverageCellSchema),
});

/** Why a patient on the source server cannot become a persona (FR-031, scenario 2). */
export const personaIneligibilitySchema = z.enum([
  "not-a-patient",
  "no-id",
  "no-ihi",
]);

/** A patient on the source server that could become a persona. */
export const personaCandidateSchema = z.object({
  patientId: fhirIdSchema,
  display: personaDisplaySchema,
  ihi: z.string(),
});

/** A patient on the source server that could not, and why. */
export const personaRefusalSchema = z.object({
  /** Null when the resource carried no usable identifier of its own. */
  patientId: z.string().nullable(),
  display: personaDisplaySchema,
  reason: personaIneligibilitySchema,
  /** The sentence the console shows the admin. */
  detail: z.string(),
});

/**
 * What a search of the source server found.
 *
 * Both lists, always. A search that quietly dropped the ineligible results would leave an
 * admin looking for a patient they can see on the source server and cannot explain the
 * absence of (scenario 2).
 */
export const personaSearchResultSchema = z.object({
  /** The address that was searched, so an admin can see what was asked. */
  searched: z.string(),
  candidates: z.array(personaCandidateSchema),
  ineligible: z.array(personaRefusalSchema),
});

/**
 * Which patient to curate.
 *
 * The identifier alone. The demographics and the IHI are read from the source server by
 * the route rather than accepted from the caller, so that what a persona claims is what
 * the source says rather than what a request body asserted.
 */
export const personaInputSchema = z.object({
  patientId: fhirIdSchema,
});

/** A FHIR resource identifier. */
export type FhirId = z.infer<typeof fhirIdSchema>;
/** The demographics a persona is curated with. */
export type PersonaDisplay = z.infer<typeof personaDisplaySchema>;
/** One curated persona. */
export type PersonaView = z.infer<typeof personaSchema>;
/** A column of the coverage grid. */
export type PersonaCoverageServer = z.infer<typeof personaCoverageServerSchema>;
/** One cell of the coverage grid. */
export type PersonaCoverageCell = z.infer<typeof personaCoverageCellSchema>;
/** The persona page. */
export type EventPersonas = z.infer<typeof eventPersonasSchema>;
/** Why a patient cannot become a persona. */
export type PersonaIneligibility = z.infer<typeof personaIneligibilitySchema>;
/** A patient that could become a persona. */
export type PersonaCandidate = z.infer<typeof personaCandidateSchema>;
/** A patient that could not. */
export type PersonaRefusal = z.infer<typeof personaRefusalSchema>;
/** What a search of the source server found. */
export type PersonaSearchResult = z.infer<typeof personaSearchResultSchema>;
/** Which patient to curate. */
export type PersonaInput = z.infer<typeof personaInputSchema>;
