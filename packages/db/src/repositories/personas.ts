/**
 * Every read and write the persona index makes.
 *
 * The rules of this layer hold here - the executor comes first, the time is passed in,
 * nothing decides policy that `@muster/core` could decide purely - and two are specific to
 * personas.
 *
 * **A coverage outcome is appended, never updated.** The grid reads the latest row per
 * (persona, enrolment), and the row before it is still there to say what the server used to
 * answer. That is the same arrangement as `check_result`, for the same reason: an outcome is
 * an observation at a time.
 *
 * **A pass asks about every target at once.** The two target listings are what the scheduler
 * iterates, each carrying the event's status - which decides the cadence - and when the
 * target was last looked at. The alternative, a query per pair, is the shape that is fine
 * for three personas and embarrassing for an event with ten personas and twenty servers.
 *
 * Author: John Grimes
 */

import { and, asc, desc, eq, inArray, isNotNull, max } from "drizzle-orm";

import { requireRow } from "./rows.js";
import { enrolment, event, system } from "../schema/directory.js";
import { persona, personaCoverage } from "../schema/personas.js";

import type { Executor } from "../executor.js";
import type { PersonaCoverageRow, PersonaRow } from "../schema/personas.js";
import type { PersonaDisplay } from "@muster/contracts";
import type {
  EventStatus,
  PersonaCoverageOutcome,
  PersonaSourceStatus,
} from "@muster/core";

/** What curating one persona records. */
export interface NewPersona {
  readonly eventId: string;
  readonly patientId: string;
  readonly display: PersonaDisplay;
  readonly ihi: string;
  /** When the source was read to produce this row, which is what makes it `present`. */
  readonly checkedAt: Date;
}

/** What one coverage observation records. */
export interface NewPersonaCoverage {
  readonly personaId: string;
  readonly enrolmentId: string;
  readonly checkedAt: Date;
  readonly outcome: PersonaCoverageOutcome;
  readonly detail: string | null;
}

/** One persona the scheduler may ask the source server about. */
export interface PersonaSourceTargetRow {
  readonly personaId: string;
  readonly patientId: string;
  readonly ihi: string;
  readonly eventSlug: string;
  readonly eventStatus: EventStatus;
  /** The event's configured source. Null events are not listed at all. */
  readonly personaSourceUrl: string;
  readonly sourceStatus: PersonaSourceStatus;
  /** Null when nothing has asked the source yet, which makes it due immediately. */
  readonly sourceCheckedAt: Date | null;
}

/** One (persona, enrolled server) pair the scheduler may check. */
export interface PersonaCoverageTargetRow {
  readonly personaId: string;
  readonly ihi: string;
  readonly enrolmentId: string;
  readonly systemName: string;
  readonly fhirBaseUrl: string;
  readonly eventSlug: string;
  readonly eventStatus: EventStatus;
  /** Null when nothing has checked this pair yet. */
  readonly lastCheckedAt: Date | null;
}

/**
 * Curates one persona.
 *
 * @param db - The executor.
 * @param input - The patient as the source server described it, and when it was read.
 * @returns The stored row, `present` at the time it was read.
 * @throws {Error} When the event already has a persona with this IHI, which the unique
 *   index refuses - a caller that wants a refusal rather than a throw asks
 *   {@link findPersonaByIhi} first, or reads `isUniqueViolation`.
 * @example
 * ```ts
 * const row = await insertPersona(db, {
 *   eventId: event.id,
 *   patientId: candidate.patientId,
 *   display: candidate.display,
 *   ihi: candidate.ihi,
 *   checkedAt: now,
 * });
 * ```
 */
export async function insertPersona(
  db: Executor,
  input: NewPersona,
): Promise<PersonaRow> {
  return requireRow(
    await db
      .insert(persona)
      .values({
        eventId: input.eventId,
        patientId: input.patientId,
        display: input.display,
        ihi: input.ihi,
        // The row was made by reading the patient from the source, so it is present and the
        // time of that read is the time it was confirmed.
        sourceStatus: "present",
        sourceCheckedAt: input.checkedAt,
        createdAt: input.checkedAt,
        updatedAt: input.checkedAt,
      })
      .returning(),
    "insert into persona",
  );
}

/**
 * One event's personas, oldest first.
 *
 * @param db - The executor.
 * @param eventId - The event.
 * @returns The personas, in the order they were curated - which is the order the cards are
 *   shown in, so that adding one does not reshuffle the page.
 */
export async function listPersonas(
  db: Executor,
  eventId: string,
): Promise<readonly PersonaRow[]> {
  return await db
    .select()
    .from(persona)
    .where(eq(persona.eventId, eventId))
    .orderBy(asc(persona.createdAt), asc(persona.id));
}

/**
 * One persona by identifier.
 *
 * @param db - The executor.
 * @param personaId - The persona.
 * @returns The row, or `undefined`.
 */
export async function findPersonaById(
  db: Executor,
  personaId: string,
): Promise<PersonaRow | undefined> {
  const rows = await db
    .select()
    .from(persona)
    .where(eq(persona.id, personaId))
    .limit(1);
  return rows[0];
}

/**
 * The persona an event already holds for this IHI, if any.
 *
 * @param db - The executor.
 * @param input - What to look for.
 * @param input.eventId - The event.
 * @param input.ihi - The identifier.
 * @returns The row, or `undefined`.
 */
export async function findPersonaByIhi(
  db: Executor,
  input: { readonly eventId: string; readonly ihi: string },
): Promise<PersonaRow | undefined> {
  const rows = await db
    .select()
    .from(persona)
    .where(and(eq(persona.eventId, input.eventId), eq(persona.ihi, input.ihi)))
    .limit(1);
  return rows[0];
}

/**
 * Records what the source server said about a persona.
 *
 * The status is optional and the time is not. A source that could not be read has said
 * nothing about whether the patient is still there, so the caller passes no status and the
 * flag stays as it was - while the time still moves, so the pass does not re-ask on every
 * sweep.
 *
 * @param db - The executor.
 * @param input - What the source said, and when.
 * @param input.personaId - The persona that was asked about.
 * @param input.checkedAt - When the source was asked.
 * @param input.sourceStatus - The status to record, or null to leave it as it was.
 * @returns The updated row, or `undefined` when the persona has been removed.
 * @example
 * ```ts
 * await recordPersonaSourceCheck(db, {
 *   personaId: target.personaId,
 *   checkedAt: now,
 *   sourceStatus: sourceStatusFor(evaluation.outcome),
 * });
 * ```
 */
export async function recordPersonaSourceCheck(
  db: Executor,
  input: {
    readonly personaId: string;
    readonly checkedAt: Date;
    readonly sourceStatus: PersonaSourceStatus | null;
  },
): Promise<PersonaRow | undefined> {
  const rows = await db
    .update(persona)
    .set({
      ...(input.sourceStatus === null
        ? {}
        : { sourceStatus: input.sourceStatus }),
      sourceCheckedAt: input.checkedAt,
      updatedAt: input.checkedAt,
    })
    .where(eq(persona.id, input.personaId))
    .returning();
  return rows[0];
}

/**
 * Records what one server said about one persona.
 *
 * @param db - The executor.
 * @param input - The observation, including the time it was made at.
 * @returns The stored row.
 */
export async function insertPersonaCoverage(
  db: Executor,
  input: NewPersonaCoverage,
): Promise<PersonaCoverageRow> {
  return requireRow(
    await db
      .insert(personaCoverage)
      .values({
        personaId: input.personaId,
        enrolmentId: input.enrolmentId,
        checkedAt: input.checkedAt,
        outcome: input.outcome,
        detail: input.detail,
      })
      .returning(),
    "insert into persona_coverage",
  );
}

/**
 * The latest outcome per (persona, enrolment), for however many personas.
 *
 * One `distinct on` rather than a query per cell. The order matters as much as the
 * predicate: Postgres keeps the first row of each group, so the descending time is what
 * makes "the latest" the latest.
 *
 * @param db - The executor.
 * @param personaIds - The personas to read coverage for.
 * @returns The latest row per pair. A pair nothing has checked is absent rather than
 *   present with a manufactured outcome: a server nobody has asked has not been found to be
 *   missing the patient.
 * @example
 * ```ts
 * const cells = await listLatestPersonaCoverage(db, personas.map((row) => row.id));
 * ```
 */
export async function listLatestPersonaCoverage(
  db: Executor,
  personaIds: readonly string[],
): Promise<readonly PersonaCoverageRow[]> {
  if (personaIds.length === 0) {
    // Asked rather than assumed: an `in ()` predicate is a syntax error in Postgres.
    return [];
  }
  return await db
    .selectDistinctOn([personaCoverage.personaId, personaCoverage.enrolmentId])
    .from(personaCoverage)
    .where(inArray(personaCoverage.personaId, [...personaIds]))
    .orderBy(
      personaCoverage.personaId,
      personaCoverage.enrolmentId,
      desc(personaCoverage.checkedAt),
    );
}

/**
 * Every persona whose event names a source server, with when the source was last asked.
 *
 * An event with no configured source is not listed: there is nowhere to ask, and a persona
 * flagged because its event has no source would be a flag about Muster's configuration
 * wearing the appearance of a claim about the patient.
 *
 * @param db - The executor.
 * @returns The targets, oldest-checked first, so a pass interrupted part way through resumes
 *   with the personas that have waited longest.
 * @example
 * ```ts
 * const targets = await listPersonaSourceTargets(db);
 * ```
 */
export async function listPersonaSourceTargets(
  db: Executor,
): Promise<readonly PersonaSourceTargetRow[]> {
  const rows = await db
    .select({
      personaId: persona.id,
      patientId: persona.patientId,
      ihi: persona.ihi,
      eventSlug: event.slug,
      eventStatus: event.status,
      personaSourceUrl: event.personaSourceUrl,
      sourceStatus: persona.sourceStatus,
      sourceCheckedAt: persona.sourceCheckedAt,
    })
    .from(persona)
    .innerJoin(event, eq(event.id, persona.eventId))
    .where(isNotNull(event.personaSourceUrl))
    .orderBy(asc(persona.sourceCheckedAt));

  return rows.flatMap((row) =>
    // Narrowing rather than asserting: `is not null` in the predicate does not reach the
    // column's type.
    row.personaSourceUrl === null
      ? []
      : [{ ...row, personaSourceUrl: row.personaSourceUrl }],
  );
}

/**
 * Every (persona, enrolled server) pair, with when it was last checked.
 *
 * Server enrolments only (`data-model.md`): a client holds no patients, so a pair that
 * included one would write a permanent `missing` against an entry that is correct. A system
 * that is both a server and a client is a server, so it is here.
 *
 * @param db - The executor.
 * @returns The pairs, oldest-checked first.
 * @example
 * ```ts
 * const targets = await listPersonaCoverageTargets(db);
 * ```
 */
export async function listPersonaCoverageTargets(
  db: Executor,
): Promise<readonly PersonaCoverageTargetRow[]> {
  const lastChecked = db
    .select({
      personaId: personaCoverage.personaId,
      enrolmentId: personaCoverage.enrolmentId,
      at: max(personaCoverage.checkedAt).as("last_checked_at"),
    })
    .from(personaCoverage)
    .groupBy(personaCoverage.personaId, personaCoverage.enrolmentId)
    .as("last_checked");

  const rows = await db
    .select({
      personaId: persona.id,
      ihi: persona.ihi,
      enrolmentId: enrolment.id,
      systemName: system.name,
      serverProfile: system.serverProfile,
      eventSlug: event.slug,
      eventStatus: event.status,
      lastCheckedAt: lastChecked.at,
    })
    .from(persona)
    .innerJoin(event, eq(event.id, persona.eventId))
    .innerJoin(enrolment, eq(enrolment.eventId, persona.eventId))
    .innerJoin(system, eq(system.id, enrolment.systemId))
    .leftJoin(
      lastChecked,
      and(
        eq(lastChecked.personaId, persona.id),
        eq(lastChecked.enrolmentId, enrolment.id),
      ),
    )
    .where(isNotNull(system.serverProfile))
    .orderBy(lastChecked.at);

  return rows.flatMap((row) =>
    row.serverProfile === null
      ? []
      : [
          {
            personaId: row.personaId,
            ihi: row.ihi,
            enrolmentId: row.enrolmentId,
            systemName: row.systemName,
            fhirBaseUrl: row.serverProfile.fhirBaseUrl,
            eventSlug: row.eventSlug,
            eventStatus: row.eventStatus,
            lastCheckedAt: row.lastCheckedAt,
          },
        ],
  );
}
