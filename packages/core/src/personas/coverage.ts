/**
 * What makes a patient a persona, and what a server's answer about one proves.
 *
 * Two judgements, both pure, both the whole of a requirement. The fetching, the clock and
 * the persistence are the scheduler's and the routes' in `apps/server`; nothing here does
 * I/O (constitution principle II).
 *
 * ## Eligibility denies by default (FR-031)
 *
 * A persona is the subject anchor the ticket playground binds a permission ticket to, and it
 * binds by IHI - so a persona without one is a persona nothing can be minted for. Hence only
 * patients carrying an IHI are eligible, and hence a refusal *says why*: an admin looking at
 * a patient they can see on the source server needs to know what is wrong with it rather
 * than watching it disappear from the results (scenario 2).
 *
 * The IHI is a system and a value, never a value alone. A sixteen-digit medical record number
 * is not an IHI because it is the right length, and treating one as an IHI would put a
 * persona in the set that no server could ever match.
 *
 * ## Absence has to be earned (FR-032)
 *
 * `missing` is a claim that a server does not hold the patient. Exactly one answer supports
 * it: a searchset that came back with no patients in it. Everything else - a refused search,
 * a timeout, a 500, a body that is not a searchset, a searchset full of patients that do not
 * carry the identifier that was searched for - is `unverifiable`, because none of them is
 * evidence about the patient.
 *
 * The case the requirement singles out is authorization. A server that will not answer a
 * patient search without a token has said nothing about its contents, and a grid recording
 * that as `missing` would send a vendor looking for data they had already loaded. That is
 * the whole reason the third value exists.
 *
 * The last case is the subtle one. A server that ignores an unrecognised `identifier`
 * parameter and returns its patients anyway has answered *a* search rather than *the*
 * search. Reading that as `found` would manufacture coverage; reading it as `missing` would
 * manufacture absence. It is neither, so it is unverifiable.
 *
 * ## The source server is asked the same question
 *
 * A persona's standing at its source is the same identifier search pointed at the source
 * rather than at a participant's server, which is what catches both of the things the spec's
 * edge case names: a patient that has been deleted, and one whose IHI has changed. An answer
 * that settles nothing leaves the flag alone - see {@link sourceStatusFor}.
 *
 * Author: John Grimes
 */

import type { CheckFetch } from "../checks/evaluate.js";
import type { Patient } from "fhir/r4";

/** Whether a server holds a persona (FR-032). */
export type PersonaCoverageOutcome = "found" | "missing" | "unverifiable";

/** Whether a curated persona is still present on the source server. */
export type PersonaSourceStatus = "present" | "missing";

/**
 * Why a patient cannot become a persona.
 *
 * The same vocabulary as `personaIneligibilitySchema` in `@muster/contracts`, declared here
 * because this package is the domain and may not depend on the wire shapes.
 */
export type PersonaIneligibility = "not-a-patient" | "no-id" | "no-ihi";

/** The demographics a persona is curated with. */
export interface PersonaDisplay {
  readonly name: string;
  readonly birthDate: string | null;
}

/** A patient that may become a persona. */
export interface PersonaCandidate {
  readonly patientId: string;
  readonly display: PersonaDisplay;
  readonly ihi: string;
}

/**
 * Whether a patient may become a persona, and if not, why.
 *
 * The refusal carries the demographics as well as the reason, because the sentence an admin
 * reads is about a specific patient in a list of search results.
 */
export type PersonaAssessment =
  | { readonly eligible: true; readonly candidate: PersonaCandidate }
  | {
      readonly eligible: false;
      /** Null when the resource carried no usable identifier of its own. */
      readonly patientId: string | null;
      readonly display: PersonaDisplay;
      readonly reason: PersonaIneligibility;
      readonly detail: string;
    };

/** What one coverage answer amounted to. */
export interface CoverageEvaluation {
  readonly outcome: PersonaCoverageOutcome;
  /** Why. Null exactly when the patient was found: the grid's tick is the whole answer. */
  readonly detail: string | null;
}

/** What {@link evaluateCoverage} judges. */
export interface CoverageEvaluationInput {
  /** The identifier search, as the guard reported it. */
  readonly fetched: CheckFetch;
  readonly ihi: string;
  readonly ihiSystem: string;
}

/** The FHIR `id` production: what may appear as a resource identifier in a path. */
const FHIR_ID = /^[A-Za-z0-9\-.]{1,64}$/;

/** How many search results the source server is asked for at once. */
const SEARCH_PAGE_SIZE = 20;

/** What a patient with no usable name is called, rather than showing an empty card. */
const UNNAMED = "Unnamed patient";

/** Trims a FHIR base URL so a path can be appended to it exactly once. */
function base(fhirBaseUrl: string): string {
  return fhirBaseUrl.trim().replace(/\/+$/, "");
}

/** An address under a FHIR base URL, with a query string built from `params`. */
function searchAddress(
  fhirBaseUrl: string,
  params: Readonly<Record<string, string>>,
): string {
  const query = new URLSearchParams(params);
  return `${base(fhirBaseUrl)}/Patient?${query.toString()}`;
}

/** A JSON object, or `undefined` when the body is not one. */
function asObject(body: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    return typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A patient's name, as a persona card shows it.
 *
 * The name parts are preferred over `HumanName.text`, because a server that supplies both
 * has usually put a formatted display in `text` and the parts are what the reader of a test
 * directory is comparing against their own loaded data. `text` is the fallback, and a name
 * with neither is named rather than left blank: a card with nothing on it is
 * indistinguishable from a rendering failure.
 *
 * @param patient - The resource as the source server served it.
 * @returns The demographics.
 * @example
 * ```ts
 * personaDisplay(patient); // { name: "Charlotte Morris", birthDate: "1985-03-12" }
 * ```
 */
export function personaDisplay(patient: Patient): PersonaDisplay {
  const first = patient.name?.[0];
  const parts = [...(first?.given ?? []), first?.family]
    .filter(
      (part): part is string => typeof part === "string" && part.length > 0,
    )
    .join(" ");
  const text = typeof first?.text === "string" ? first.text.trim() : "";
  // The parts, then the formatted text, then a placeholder: the first of the three that says
  // anything at all.
  const named = [parts, text, UNNAMED].find(
    (candidate) => candidate.length > 0,
  );
  return {
    name: named ?? UNNAMED,
    birthDate: patient.birthDate ?? null,
  };
}

/**
 * The IHI a patient carries in the configured namespace, or null.
 *
 * @param patient - The resource as the source server served it.
 * @param ihiSystem - The configured IHI namespace.
 * @returns The identifier's value, or null when the patient carries none.
 * @example
 * ```ts
 * personaIhi(patient, config.ihiSystem); // "8003608500314687"
 * ```
 */
export function personaIhi(patient: Patient, ihiSystem: string): string | null {
  const found = (patient.identifier ?? []).find(
    (identifier) =>
      identifier.system === ihiSystem &&
      typeof identifier.value === "string" &&
      identifier.value.length > 0,
  );
  return found?.value ?? null;
}

/**
 * Whether a patient may become a persona (FR-031).
 *
 * @param resource - The resource as the source server served it, unvalidated.
 * @param ihiSystem - The configured IHI namespace.
 * @returns The candidate, or the reason it was refused and a sentence naming what was
 *   missing - because scenario 2 asks for the reason to be stated rather than the patient
 *   silently vanishing from the results.
 * @example
 * ```ts
 * const assessment = assessPersonaCandidate(entry.resource, config.ihiSystem);
 * if (!assessment.eligible) {
 *   return jsonError(c, 422, "persona_without_ihi", assessment.detail);
 * }
 * ```
 */
export function assessPersonaCandidate(
  resource: unknown,
  ihiSystem: string,
): PersonaAssessment {
  const document =
    typeof resource === "object" && resource !== null ? resource : {};
  const patient = document as Patient;
  const display = personaDisplay(patient);

  if (patient.resourceType !== "Patient") {
    return {
      eligible: false,
      patientId: null,
      display,
      reason: "not-a-patient",
      // A searchset may carry an OperationOutcome beside its matches, and an admin should
      // not be offered one as a persona.
      detail: `This is a ${typeof patient.resourceType === "string" ? patient.resourceType : "resource of no stated type"} rather than a Patient, so it cannot be a persona.`,
    };
  }

  const patientId = patient.id ?? "";
  if (!FHIR_ID.test(patientId)) {
    return {
      eligible: false,
      patientId: patientId.length === 0 ? null : patientId,
      display,
      reason: "no-id",
      detail:
        "This patient carries no usable id on the source server, so there would be nothing to link the persona to.",
    };
  }

  const ihi = personaIhi(patient, ihiSystem);
  if (ihi === null) {
    return {
      eligible: false,
      patientId,
      display,
      reason: "no-ihi",
      // The system, because "no IHI" against a patient whose record shows an identifier is
      // not something an admin can act on without knowing which namespace was looked for.
      detail: `${display.name} carries no identifier in ${ihiSystem}. Only patients with an IHI can be personas, because a permission ticket binds its subject by IHI.`,
    };
  }

  return { eligible: true, candidate: { patientId, display, ihi } };
}

/**
 * The resources a Patient searchset matched.
 *
 * @param body - The response body, as served.
 * @returns The matched resources, or `undefined` when the body is not a Bundle - which is
 *   deliberately distinct from an empty list. "The server answered and found nobody" is the
 *   one answer that supports a claim of absence; "the server answered with an
 *   OperationOutcome" is not.
 * @example
 * ```ts
 * const resources = parsePatientSearch(result.value.body);
 * ```
 */
export function parsePatientSearch(
  body: string,
): readonly unknown[] | undefined {
  const document = asObject(body);
  if (document === undefined || document["resourceType"] !== "Bundle") {
    return undefined;
  }
  const entries = document["entry"];
  return Array.isArray(entries)
    ? entries.flatMap((entry) => {
        const resource: unknown =
          typeof entry === "object" && entry !== null
            ? (entry as { resource?: unknown }).resource
            : undefined;
        return resource === undefined ? [] : [resource];
      })
    : [];
}

/**
 * Where the source server's patients are searched by name (FR-031).
 *
 * @param sourceBaseUrl - The event's configured persona source.
 * @param query - What the admin typed, escaped rather than trusted: a value carrying an
 *   ampersand must not become a second search parameter on somebody else's server.
 * @returns The absolute address to fetch.
 * @example
 * ```ts
 * personaSearchUrl("https://fhir.example.org/r4", "Morris");
 * // "https://fhir.example.org/r4/Patient?name=Morris&_count=20"
 * ```
 */
export function personaSearchUrl(sourceBaseUrl: string, query: string): string {
  // Bounded, so one search of a well-stocked test server cannot return all of it.
  return searchAddress(sourceBaseUrl, {
    name: query,
    _count: String(SEARCH_PAGE_SIZE),
  });
}

/**
 * Where one patient's canonical record lives (FR-031, scenario 1).
 *
 * @param fhirBaseUrl - The server's FHIR base URL.
 * @param patientId - The patient's identifier on that server.
 * @returns The absolute address. The identifier is escaped, so that a value carrying a path
 *   segment cannot point the address somewhere the server never named - belt and braces
 *   behind the schema that refuses one at the edge.
 * @example
 * ```ts
 * patientResourceUrl(event.personaSourceUrl, persona.patientId);
 * ```
 */
export function patientResourceUrl(
  fhirBaseUrl: string,
  patientId: string,
): string {
  return `${base(fhirBaseUrl)}/Patient/${encodeURIComponent(patientId)}`;
}

/**
 * Where a server is asked whether it holds a patient with this IHI (FR-032).
 *
 * @param fhirBaseUrl - The server's FHIR base URL.
 * @param ihiSystem - The configured IHI namespace.
 * @param ihi - The persona's IHI.
 * @returns The absolute address to fetch: a token search on `identifier`, system and value
 *   both, because a search by value alone would match a medical record number that happened
 *   to have the same digits.
 * @example
 * ```ts
 * ihiSearchUrl(target.fhirBaseUrl, config.ihiSystem, persona.ihi);
 * ```
 */
export function ihiSearchUrl(
  fhirBaseUrl: string,
  ihiSystem: string,
  ihi: string,
): string {
  return searchAddress(fhirBaseUrl, { identifier: `${ihiSystem}|${ihi}` });
}

/** How a guard refusal reads on the grid. Every one of them is unverifiable. */
function refusalDetail(fetched: CheckFetch & { readonly ok: false }): string {
  const said = fetched.description ?? fetched.reason;
  switch (fetched.reason) {
    case "timeout": {
      return `The server did not answer in time, so nothing is known either way: ${said}`;
    }
    case "refused":
    case "unresolvable": {
      return `The server could not be reached, so nothing is known either way: ${said}`;
    }
    case "too-large": {
      return `The server's answer was too large to read: ${said}`;
    }
    default: {
      // Every remaining reason is the guard deciding, so no request was made (FR-020).
      return `No request was made: ${said}`;
    }
  }
}

/**
 * What one server's answer proves about one persona (FR-032).
 *
 * @param input - The identifier search's outcome, and the identifier it asked about.
 * @returns The outcome to record, and why - except for `found`, which needs no explanation.
 * @example
 * ```ts
 * const evaluation = evaluateCoverage({
 *   fetched: toCheckFetch(await outboundFetch(ihiSearchUrl(baseUrl, ihiSystem, ihi), options)),
 *   ihi,
 *   ihiSystem,
 * });
 * ```
 */
export function evaluateCoverage(
  input: CoverageEvaluationInput,
): CoverageEvaluation {
  const { fetched } = input;
  if (!fetched.ok) {
    return { outcome: "unverifiable", detail: refusalDetail(fetched) };
  }

  if (fetched.status === 401 || fetched.status === 403) {
    // The case FR-032 exists for. An authorization failure is not evidence of absence.
    return {
      outcome: "unverifiable",
      detail: `The server requires authorization for patient searches (HTTP ${String(fetched.status)}), so its answer is not evidence either way.`,
    };
  }
  if (fetched.status < 200 || fetched.status >= 300) {
    return {
      outcome: "unverifiable",
      detail: `The server answered HTTP ${String(fetched.status)} to the identifier search.`,
    };
  }

  const resources = parsePatientSearch(fetched.body);
  if (resources === undefined) {
    return {
      outcome: "unverifiable",
      detail:
        "The server answered the identifier search with something that is not a searchset Bundle.",
    };
  }

  const patients = resources.flatMap((resource) => {
    const assessed = assessPersonaCandidate(resource, input.ihiSystem);
    return assessed.eligible || assessed.reason !== "not-a-patient"
      ? [assessed]
      : [];
  });
  if (patients.length === 0) {
    // The one answer that supports a claim of absence.
    return {
      outcome: "missing",
      detail: "The server holds no patient with this IHI.",
    };
  }

  const holds = patients.some(
    (assessed) => assessed.eligible && assessed.candidate.ihi === input.ihi,
  );
  return holds
    ? { outcome: "found", detail: null }
    : {
        // A server that ignored the identifier parameter has answered a different question.
        outcome: "unverifiable",
        detail: `The server returned ${String(patients.length)} patient${patients.length === 1 ? "" : "s"}, none carrying this IHI, so it did not answer the search that was made.`,
      };
}

/**
 * What a coverage answer from the source server means for a persona's standing.
 *
 * @param outcome - What the source said about the persona's IHI.
 * @returns The status to record, or null to leave it as it was. Null rather than `missing`
 *   for an answer that settled nothing: a source server that was down for a minute has not
 *   deleted anybody, and flagging every persona over it would teach admins to ignore the
 *   flag that matters (FR-032's edge case).
 * @example
 * ```ts
 * await recordPersonaSourceCheck(db, {
 *   personaId,
 *   checkedAt: now,
 *   sourceStatus: sourceStatusFor(evaluation.outcome),
 * });
 * ```
 */
export function sourceStatusFor(
  outcome: PersonaCoverageOutcome,
): PersonaSourceStatus | null {
  switch (outcome) {
    case "found": {
      return "present";
    }
    case "missing": {
      return "missing";
    }
    default: {
      return null;
    }
  }
}
