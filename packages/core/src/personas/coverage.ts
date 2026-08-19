import { authoriseAdmin, refuse } from "../accounts/rules.ts";
import { asObject, asText } from "../json/reading.ts";

import type {
  AccountFacts,
  AuthorisationDecision,
  RefusedDecision,
} from "../accounts/rules.ts";
import type {
  CheckFailureMode,
  CoverageOutcome,
  EventStatus,
  IneligibleCandidate,
  PersonaCandidate,
  PersonaDisplay,
  PersonaSourceStatus,
} from "@muster/contracts";
import type { Bundle, HumanName, Identifier, Patient } from "fhir/r4";

/**
 * Persona eligibility and coverage evaluation.
 *
 * Pure. Nothing here reads a server; what arrives is the outcome of a read that
 * `apps/server` made through the SSRF guard, and what leaves is the row to
 * persist. That split is what lets each rule below be tested without a network: a
 * server that demands authorization, a server that answers with an empty
 * searchset and a guarded address are three inputs rather than three stubs.
 *
 * Three rules carry the specification.
 *
 * An IHI is required of every persona (FR-031). The whole point of anchoring the
 * set to one source server is that two participants who seed the same patient
 * independently produce records with different resource identifiers and often
 * different spellings; the national identifier is the only thing that matches
 * across them. A candidate without one is refused, with the identifier system
 * Muster looked in named in the refusal, because "not eligible" on its own sends
 * an admin looking for a bug.
 *
 * A coverage cell reports what was observed and nothing else (FR-032). Only a
 * readable searchset answers the question: it says `found` when a patient with
 * the IHI is in it and `missing` when it is empty. Everything else -
 * authorization required, a body that is not a Bundle, an address the guard
 * refused - is `unverifiable`. Collapsing those into `missing` would accuse a
 * server owner of not holding data on the strength of a request that was never
 * answered.
 *
 * The source flag is three-valued for the same reason, even though the column is
 * not. A source that says the patient is gone, or that its IHI has changed, makes
 * the persona `missing` so an admin is told the set has rotted. A source that
 * could not be read claims nothing at all: `null` leaves the stored flag where it
 * was, because a timeout is a fact about the minute rather than about the patient.
 *
 * The identifier system is a parameter everywhere. It is fixed by configuration
 * (`MUSTER_IHI_SYSTEM`), so nothing here or in a route hardcodes it.
 *
 * @author John Grimes
 */

/** How a read of a participant's or the source's FHIR server ended. */
export type PersonaProbe =
  /** the server answered; the status and body are both facts about the answer */
  | { readonly ok: true; readonly status: number; readonly document: unknown }
  /** nothing usable was obtained, and this is why */
  | {
      readonly ok: false;
      readonly failureMode: CheckFailureMode;
      readonly detail: string;
    };

/** Whether a patient on the source may join the event's persona set. */
export type PersonaEligibility =
  /** it may, and this is what would be recorded */
  | { readonly ok: true; readonly candidate: PersonaCandidate }
  /** it may not, and this is what to tell the admin who asked */
  | RefusedDecision;

/** What a search of the source offered, and what it would not offer. */
export type PersonaSearchResult = {
  /** the patients that may join the set */
  readonly candidates: readonly PersonaCandidate[];
  /** the patients it found and will not offer, each with the reason */
  readonly ineligible: readonly IneligibleCandidate[];
};

/** One cell of the coverage grid, as the row records it. */
export type CoverageEvaluation = {
  /** whether the persona was found, missing, or could not be looked for */
  readonly outcome: CoverageOutcome;
  /** the reason, in words fit to show a reader of the grid */
  readonly detail: string;
};

/** What a read of the source said about a curated persona. */
export type SourcePresence = {
  /** the flag to store, or null when the read settled nothing */
  readonly status: PersonaSourceStatus | null;
  /** the reason, in words fit to show an admin */
  readonly detail: string;
};

/** What deciding whether an admin may curate a set needs to know. */
export type PersonaCurationFacts = {
  /** the account asking */
  readonly member: AccountFacts;
  /** the status of the event whose set would change */
  readonly eventStatus: EventStatus;
};

/** What building a search of the source needs. */
export type PersonaSearchFacts = {
  /** what the admin typed, which may be an IHI or a name */
  readonly query: string;
  /** the configured IHI identifier system */
  readonly ihiSystem: string;
  /** how many results to ask the source for */
  readonly limit: number;
};

/** What reading a persona out of a patient resource needs. */
export type PersonaEligibilityFacts = {
  /** the configured IHI identifier system */
  readonly ihiSystem: string;
};

/** What looking one persona up on a server needs. */
export type PersonaIdentifierFacts = {
  /** the persona's IHI */
  readonly ihi: string;
  /** the configured IHI identifier system */
  readonly ihiSystem: string;
};

/** What checking a persona against its source needs. */
export type PersonaSourceFacts = PersonaIdentifierFacts & {
  /** the resource identifier the persona was curated from */
  readonly patientId: string;
};

/** The statuses that say the server will not answer without authorization. */
const authorizationStatuses: readonly number[] = [401, 403];

/** The statuses that say the resource is not there any more. */
const absentStatuses: readonly number[] = [404, 410];

/** An IHI is sixteen digits; anything else is read as a name. */
const ihiPattern = /^\d{16}$/;

/**
 * Narrows a document to a FHIR resource of one type.
 *
 * Deny by default applies to reading a document as much as to anything else: a
 * body that does not say what it is is not read as a Patient because it happens
 * to have a `name`.
 *
 * @param document - the body as fetched
 * @param resourceType - the type it must declare
 * @returns the resource, or undefined when it is not one
 */
const asResource = <Resource>(
  document: unknown,
  resourceType: string,
): Resource | undefined => {
  const body = asObject(document);
  return body === undefined || body["resourceType"] !== resourceType
    ? undefined
    : (body as unknown as Resource);
};

/**
 * Joins a FHIR base URL and a path without doubling the slash between them.
 *
 * @param baseUrl - the declared FHIR base URL
 * @param path - the path to append, without a leading slash
 * @returns the absolute URL to fetch
 */
const fhirUrl = (baseUrl: string, path: string): string =>
  `${baseUrl.trim().replace(/\/+$/, "")}/${path}`;

/**
 * Renders one FHIR name as a line of text.
 *
 * @param name - the name as the source states it
 * @returns the name, or null when it holds nothing to render
 */
const renderName = (name: HumanName | undefined): string | null => {
  if (name === undefined) {
    return null;
  }
  const text = asText(name.text);
  if (text !== null) {
    return text;
  }
  const parts = [
    ...(name.prefix ?? []),
    ...(name.given ?? []),
    ...(name.family === undefined ? [] : [name.family]),
  ].filter((part) => asText(part) !== null);
  return parts.length === 0 ? null : parts.join(" ");
};

/**
 * Reads the IHI of a patient resource.
 *
 * The identifier system is the one configuration fixes, so a deployment pointed
 * at a different programme's source reads that programme's identifier and nothing
 * else. A type coding of `NI` is not enough on its own: several Australian
 * identifiers carry it.
 *
 * @param patient - the patient resource as fetched
 * @param ihiSystem - the configured IHI identifier system
 * @returns the IHI, or undefined when the patient asserts none
 * @example
 * ```ts
 * ihiOf(patient, config.ihiSystem); // "8003608000311662"
 * ```
 */
export const ihiOf = (
  patient: unknown,
  ihiSystem: string,
): string | undefined => {
  const resource = asResource<Patient>(patient, "Patient");
  const identifiers: readonly Identifier[] = Array.isArray(resource?.identifier)
    ? resource.identifier
    : [];
  const found = identifiers.find(
    (identifier) =>
      identifier.system === ihiSystem && asText(identifier.value) !== null,
  );
  return found?.value;
};

/**
 * Decides whether a patient on the source may join the persona set.
 *
 * @param patient - the patient resource as fetched from the source
 * @param facts - the configured IHI identifier system
 * @returns the candidate to record, or the refusal to report (FR-031)
 * @example
 * ```ts
 * const decision = personaFrom(document, { ihiSystem: config.ihiSystem });
 * if (!decision.ok) {
 *   throw refusalError(decision.refusal);
 * }
 * ```
 */
export const personaFrom = (
  patient: unknown,
  facts: PersonaEligibilityFacts,
): PersonaEligibility => {
  const resource = asResource<Patient>(patient, "Patient");
  if (resource === undefined) {
    return refuse(
      "not_a_patient",
      "The source did not answer with a Patient resource.",
    );
  }
  const patientId = asText(resource.id) ?? "";
  const ihi = ihiOf(resource, facts.ihiSystem);
  if (ihi === undefined) {
    return refuse(
      "no_ihi",
      `Patient/${patientId} carries no identifier under ${facts.ihiSystem}, ` +
        "and a persona is anchored by its IHI, so it cannot join the set.",
    );
  }
  const names: readonly HumanName[] = Array.isArray(resource.name)
    ? resource.name
    : [];
  return {
    ok: true,
    candidate: {
      patientId,
      ihi,
      display: {
        // The identifier is the last resort rather than a blank: a picker row
        // with no label is a row nobody can choose deliberately.
        name: renderName(names[0]) ?? `Patient/${patientId}`,
        birthDate: asText(resource.birthDate),
        gender: asText(resource.gender),
      } satisfies PersonaDisplay,
    },
  };
};

/**
 * Reads the candidates out of a search of the source.
 *
 * Patients carrying an IHI are offered; patients that do not are reported with
 * the reason rather than dropped, because an admin who can see a patient on the
 * source server needs to be told why it is not on the list (acceptance scenario
 * 2). Entries that are not patients at all - an `OperationOutcome` a server
 * included in its searchset - are neither, since they were never candidates.
 *
 * @param bundle - the searchset as fetched
 * @param facts - the configured IHI identifier system
 * @returns the candidates, and the patients that will not be offered
 * @example
 * ```ts
 * const { candidates, ineligible } = personaCandidates(document, { ihiSystem });
 * ```
 */
export const personaCandidates = (
  bundle: unknown,
  facts: PersonaEligibilityFacts,
): PersonaSearchResult => {
  const resource = asResource<Bundle>(bundle, "Bundle");
  const entries = Array.isArray(resource?.entry) ? resource.entry : [];
  const candidates: PersonaCandidate[] = [];
  const ineligible: IneligibleCandidate[] = [];
  for (const entry of entries) {
    const patient = asResource<Patient>(entry.resource, "Patient");
    if (patient === undefined) {
      continue;
    }
    const decision = personaFrom(patient, facts);
    if (decision.ok) {
      candidates.push(decision.candidate);
    } else {
      ineligible.push({
        patientId: asText(patient.id) ?? "",
        detail: decision.refusal.detail,
      });
    }
  }
  return { candidates, ineligible };
};

/**
 * Builds the search of the source an admin's query asks for.
 *
 * A query of sixteen digits is an IHI and is searched as one, which is what an
 * admin who has been handed a persona's identifier will paste in; anything else
 * is a name. An empty query lists the source's patients, so the first thing the
 * screen can do is show what is there.
 *
 * @param baseUrl - the event's configured persona source
 * @param facts - the query, the identifier system and the page size
 * @returns the absolute URL to fetch through the guard
 * @example
 * ```ts
 * personaSearchUrl(event.personaSourceUrl, { query, ihiSystem, limit: 20 });
 * ```
 */
export const personaSearchUrl = (
  baseUrl: string,
  facts: PersonaSearchFacts,
): string => {
  const query = facts.query.trim();
  const parameters = new URLSearchParams();
  if (ihiPattern.test(query)) {
    parameters.set("identifier", `${facts.ihiSystem}|${query}`);
  } else if (query !== "") {
    parameters.set("name", query);
  }
  parameters.set("_count", String(facts.limit));
  return fhirUrl(baseUrl, `Patient?${parameters.toString()}`);
};

/**
 * Builds the identifier search one enrolled server is asked for coverage.
 *
 * `_summary=count` because the question is whether the server holds a patient
 * with the IHI, not what that patient says: Muster is an index, not a store, and
 * asking for the whole record would pull demographics it has no business keeping.
 * A server that ignores the parameter and answers with entries is handled the
 * same way by the evaluation.
 *
 * @param baseUrl - the enrolled server's declared FHIR base URL
 * @param facts - the persona's IHI and the configured identifier system
 * @returns the absolute URL to fetch through the guard
 * @example
 * ```ts
 * personaIdentifierSearchUrl(profile.fhirBaseUrl, { ihi, ihiSystem });
 * ```
 */
export const personaIdentifierSearchUrl = (
  baseUrl: string,
  facts: PersonaIdentifierFacts,
): string => {
  const parameters = new URLSearchParams({
    identifier: `${facts.ihiSystem}|${facts.ihi}`,
    _summary: "count",
  });
  return fhirUrl(baseUrl, `Patient?${parameters.toString()}`);
};

/**
 * Builds the read of one patient on the source.
 *
 * @param baseUrl - the event's configured persona source
 * @param patientId - the resource identifier
 * @returns the absolute URL to fetch through the guard
 * @example
 * ```ts
 * patientReadUrl(event.personaSourceUrl, persona.patientId);
 * ```
 */
export const patientReadUrl = (baseUrl: string, patientId: string): string =>
  fhirUrl(baseUrl, `Patient/${encodeURIComponent(patientId)}`);

/**
 * Reports whether a searchset holds a patient with the IHI.
 *
 * Both shapes a server may answer with are read: a `total` for the count-only
 * search that was asked for, and the entries for a server that ignored
 * `_summary`. Where entries arrive they are checked rather than counted, so a
 * server that answers a search for one IHI with somebody else's patient does not
 * produce a `found`.
 *
 * @param bundle - the searchset the server answered with
 * @param facts - the persona's IHI and the configured identifier system
 * @returns true when the server holds a patient with the IHI
 */
const bundleHoldsIhi = (
  bundle: Bundle,
  facts: PersonaIdentifierFacts,
): boolean => {
  const entries = Array.isArray(bundle.entry) ? bundle.entry : [];
  if (entries.length > 0) {
    return entries.some(
      (entry) => ihiOf(entry.resource, facts.ihiSystem) === facts.ihi,
    );
  }
  return typeof bundle.total === "number" && bundle.total > 0;
};

/**
 * Evaluates one cell of the coverage grid (FR-032).
 *
 * @param probe - how the identifier search ended
 * @param facts - the persona's IHI and the configured identifier system
 * @returns the outcome and the reason, as the row records them
 * @example
 * ```ts
 * const evaluation = evaluateCoverage(probe, { ihi: persona.ihi, ihiSystem });
 * await insertPersonaCoverage(sql, { personaId, enrolmentId, ...evaluation });
 * ```
 */
export const evaluateCoverage = (
  probe: PersonaProbe,
  facts: PersonaIdentifierFacts,
): CoverageEvaluation => {
  if (!probe.ok) {
    // Muster's own refusal or the server's silence, reported as the reason it
    // was: never folded into a verdict about what the server holds (FR-020).
    return { outcome: "unverifiable", detail: probe.detail };
  }
  if (authorizationStatuses.includes(probe.status)) {
    return {
      outcome: "unverifiable",
      detail:
        "The server requires authorization to search for patients, " +
        `so whether it holds ${facts.ihi} could not be established.`,
    };
  }
  if (probe.status < 200 || probe.status > 299) {
    return {
      outcome: "unverifiable",
      detail: `The server answered the identifier search with HTTP ${String(probe.status)}.`,
    };
  }
  const bundle = asResource<Bundle>(probe.document, "Bundle");
  if (bundle === undefined) {
    return {
      outcome: "unverifiable",
      detail: "The server did not answer the search with a FHIR Bundle.",
    };
  }
  return bundleHoldsIhi(bundle, facts)
    ? {
        outcome: "found",
        detail: `The server holds a patient with IHI ${facts.ihi}.`,
      }
    : {
        outcome: "missing",
        detail: `The server holds no patient with IHI ${facts.ihi}.`,
      };
};

/**
 * Evaluates what a read of the source says about a curated persona.
 *
 * The edge case both ways: a patient the source has deleted and a patient whose
 * IHI has changed under Muster are both `missing`, because in both cases the
 * persona names somebody the grid can no longer search for and an admin has to
 * re-curate. A source that could not be read settles nothing and says so.
 *
 * @param probe - how the read of the source ended
 * @param facts - the persona as curated
 * @returns the flag to store, or null to leave the stored flag alone
 * @example
 * ```ts
 * const presence = evaluateSourcePresence(probe, persona);
 * if (presence.status !== null) {
 *   await updatePersonaSourceStatus(sql, { ...persona, status: presence.status });
 * }
 * ```
 */
export const evaluateSourcePresence = (
  probe: PersonaProbe,
  facts: PersonaSourceFacts,
): SourcePresence => {
  if (!probe.ok) {
    return { status: null, detail: probe.detail };
  }
  if (absentStatuses.includes(probe.status)) {
    return {
      status: "missing",
      detail: `The source no longer holds Patient/${facts.patientId}.`,
    };
  }
  if (probe.status < 200 || probe.status > 299) {
    return {
      status: null,
      detail: `The source answered with HTTP ${String(probe.status)}, so nothing was established.`,
    };
  }
  const found = ihiOf(probe.document, facts.ihiSystem);
  if (found === facts.ihi) {
    return {
      status: "present",
      detail: `The source still holds Patient/${facts.patientId} with IHI ${facts.ihi}.`,
    };
  }
  if (asResource<Patient>(probe.document, "Patient") === undefined) {
    return {
      status: null,
      detail: "The source did not answer with a Patient resource.",
    };
  }
  return {
    status: "missing",
    detail:
      `Patient/${facts.patientId} at the source no longer carries IHI ${facts.ihi}` +
      `${found === undefined ? "" : ` - it now carries ${found}`}, so the persona needs re-curating.`,
  };
};

/**
 * Decides whether an account may change an event's persona set (FR-031).
 *
 * A draft event's set is curated before anybody enrols, which is the normal way
 * round, so only a closed event refuses: its records stay readable and stop
 * changing.
 *
 * @param facts - the account asking and the event's status
 * @returns the decision, refusing with the first condition that failed
 * @example
 * ```ts
 * const decision = authorisePersonaCuration({ member: factsFor(account), eventStatus });
 * if (!decision.ok) {
 *   throw refusalError(decision.refusal);
 * }
 * ```
 */
export const authorisePersonaCuration = (
  facts: PersonaCurationFacts,
): AuthorisationDecision => {
  const decision = authoriseAdmin(facts.member);
  if (!decision.ok) {
    return decision;
  }
  return facts.eventStatus === "closed"
    ? refuse(
        "event_not_open",
        "This event is closed, so its persona set can no longer be changed.",
      )
    : { ok: true };
};
