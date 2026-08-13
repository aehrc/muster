/**
 * Every read and write the pairing tracker makes.
 *
 * The same three rules as the rest of this layer hold here - the executor comes first, the time
 * is passed in, and a refusal that is part of the domain is a value rather than an exception -
 * and two more are specific to pairings.
 *
 * **Every state change is conditional on the state it came from.** `transitionPairing` updates
 * `where id = ? and state = ?`, so two members of one organisation answering the same request at
 * once resolve to one answer and the loser is told the pairing moved. Reading the state and then
 * writing it would leave a window in which both answers succeed and the second silently
 * overwrites the first - which for an issued client identifier is a credential lost.
 *
 * **A state change and its timeline entry are one operation.** Both happen in a transaction,
 * because a pairing that moved with nothing recorded is exactly the gap FR-013 exists to close:
 * both organisations read the timeline, and a state with no explanation is the Confluence table
 * again. Nothing here ever updates or deletes a `pairing_event` row.
 *
 * Which pairings a caller may see is decided by their organisations rather than by their
 * account, because every member of an organisation answers its pairings (FR-005) - and a member
 * of both organisations in one pairing sees it once, from both sides.
 *
 * Author: John Grimes
 */

import { lapsesOnEventClose, PAIRING_STATES } from "@muster/core";
import { and, desc, eq, inArray, or } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { isUniqueViolation } from "./errors.js";
import { firstRow, requireRow } from "./rows.js";
import {
  account,
  enrolment,
  event,
  organisation,
  system,
} from "../schema/directory.js";
import { pairing, pairingEvent } from "../schema/pairings.js";

import type { Executor } from "../executor.js";
import type {
  EnrolmentRow,
  EventRow,
  OrganisationRow,
  SystemRow,
} from "../schema/directory.js";
import type { PairingEventRow, PairingRow } from "../schema/pairings.js";
import type { RegistrationFieldsInput } from "@muster/contracts";
import type { PairingState } from "@muster/core";

/** One half of a pairing, joined to the system and organisation behind it. */
export interface PairingSideRow {
  readonly enrolment: EnrolmentRow;
  readonly system: SystemRow;
  readonly organisation: OrganisationRow;
}

/** A pairing with everything needed to describe it, or to notify about it. */
export interface PairingWithSides {
  readonly pairing: PairingRow;
  readonly event: EventRow;
  readonly client: PairingSideRow;
  readonly server: PairingSideRow;
}

/** One timeline entry, with who acted and which organisation they acted for. */
export interface PairingTimelineRow {
  readonly entry: PairingEventRow;
  /** Null when nothing a person did caused it. */
  readonly actorDisplayName: string | null;
  /** Null when the actor acted as a track admin rather than for an organisation. */
  readonly actingFor: OrganisationRow | null;
}

/** What a pairing request records. */
export interface NewPairing {
  readonly eventId: string;
  readonly clientEnrolmentId: string;
  readonly serverEnrolmentId: string;
  /** The standard field set, snapshot at request time. */
  readonly registrationFields: RegistrationFieldsInput;
  readonly actorAccountId: string;
  /** The organisation the request was made for: the client side's. */
  readonly actingForOrganisationId: string;
  readonly now: Date;
}

/** The outcome of requesting a pairing. */
export type PairingWrite =
  | { readonly ok: true; readonly pairing: PairingRow }
  | {
      readonly ok: false;
      readonly reason: "duplicate";
      /** The pairing this one duplicates, so the refusal can link to it (FR-015). */
      readonly pairingId: string;
    };

/** What a transition changes, beyond the state itself. */
export type PairingChange =
  | { readonly to: "fulfilled"; readonly clientId: string }
  | { readonly to: "declined"; readonly reason: string }
  | { readonly to: "failed" | "requested" | "lapsed" };

/** What a transition records. */
export interface PairingTransitionInput {
  readonly pairingId: string;
  /** The state the caller read. The update is conditional on it still holding. */
  readonly from: PairingState;
  readonly change: PairingChange;
  readonly actorAccountId: string | null;
  readonly actingForOrganisationId: string | null;
  readonly now: Date;
}

/** Which pairings a list request asks for. */
export interface PairingListQuery {
  /** The caller's organisations. A pairing matches when either side is one of them. */
  readonly organisationIds: readonly string[];
  /** An event to narrow to, or `undefined` for every event. */
  readonly eventSlug?: string;
}

/** What closing an event lapses, and who closed it. */
export interface PairingLapse {
  readonly eventId: string;
  /** The admin who closed the event, or null when nothing a person did closed it. */
  readonly actorAccountId: string | null;
  readonly now: Date;
}

/** The outcome of a transition. */
export type PairingTransitionWrite =
  | { readonly ok: true; readonly pairing: PairingRow }
  | { readonly ok: false; readonly reason: "not-found" | "state-changed" };

/**
 * The states an event closing lapses.
 *
 * Derived from the pure rule rather than restated, so the rows a closing event touches cannot
 * drift from the transitions the state machine admits (FR-011).
 */
const LAPSING_STATES: readonly PairingState[] =
  PAIRING_STATES.filter(lapsesOnEventClose);

// Each side of a pairing joins the same three tables, so each needs its own alias. Without
// them the two joins would collide on the table name and Postgres would answer with one side
// twice.
const clientEnrolment = alias(enrolment, "client_enrolment");
const clientSystem = alias(system, "client_system");
const clientOrganisation = alias(organisation, "client_organisation");
const serverEnrolment = alias(enrolment, "server_enrolment");
const serverSystem = alias(system, "server_system");
const serverOrganisation = alias(organisation, "server_organisation");

/** The joined selection every pairing read returns. */
const PAIRING_COLUMNS = {
  pairing,
  event,
  clientEnrolment,
  clientSystem,
  clientOrganisation,
  serverEnrolment,
  serverSystem,
  serverOrganisation,
};

/** One row of {@link PAIRING_COLUMNS}, as Drizzle returns it. */
type PairingSelection = {
  readonly pairing: PairingRow;
  readonly event: EventRow;
  readonly clientEnrolment: EnrolmentRow;
  readonly clientSystem: SystemRow;
  readonly clientOrganisation: OrganisationRow;
  readonly serverEnrolment: EnrolmentRow;
  readonly serverSystem: SystemRow;
  readonly serverOrganisation: OrganisationRow;
};

/**
 * The query every pairing read starts from.
 *
 * Written once because the seven joins are the same every time and getting one of them wrong -
 * joining the server's system to the client's enrolment, say - would produce a plausible row
 * describing a pairing that does not exist.
 */
function pairingQuery(db: Executor) {
  return db
    .select(PAIRING_COLUMNS)
    .from(pairing)
    .innerJoin(event, eq(event.id, pairing.eventId))
    .innerJoin(
      clientEnrolment,
      eq(clientEnrolment.id, pairing.clientEnrolmentId),
    )
    .innerJoin(clientSystem, eq(clientSystem.id, clientEnrolment.systemId))
    .innerJoin(
      clientOrganisation,
      eq(clientOrganisation.id, clientSystem.organisationId),
    )
    .innerJoin(
      serverEnrolment,
      eq(serverEnrolment.id, pairing.serverEnrolmentId),
    )
    .innerJoin(serverSystem, eq(serverSystem.id, serverEnrolment.systemId))
    .innerJoin(
      serverOrganisation,
      eq(serverOrganisation.id, serverSystem.organisationId),
    );
}

/** Reshapes a joined row into the two sides the callers read. */
function toPairingWithSides(row: PairingSelection): PairingWithSides {
  return {
    pairing: row.pairing,
    event: row.event,
    client: {
      enrolment: row.clientEnrolment,
      system: row.clientSystem,
      organisation: row.clientOrganisation,
    },
    server: {
      enrolment: row.serverEnrolment,
      system: row.serverSystem,
      organisation: row.serverOrganisation,
    },
  };
}

/** The columns a transition writes on the pairing itself. */
function changeValues(change: PairingChange) {
  if (change.to === "fulfilled") {
    return { clientId: change.clientId };
  }
  if (change.to === "declined") {
    return { declineReason: change.reason };
  }
  return {};
}

/**
 * What a transition changed, recorded beside it.
 *
 * The pairing carries only its latest answer, so a timeline that read the identifier off the
 * pairing would attribute whatever is there now to whichever entry the reader was looking at.
 */
function changeDetail(change: PairingChange) {
  if (change.to === "fulfilled") {
    return { clientId: change.clientId };
  }
  if (change.to === "declined") {
    return { reason: change.reason };
  }
  return {};
}

/**
 * Requests a pairing, recording the request as the first entry of its timeline.
 *
 * Attempted rather than checked first: two requests for the same client, server and event
 * arriving together would both pass a prior lookup, and the unique index is the only thing that
 * decides between them. The refusal carries the existing pairing's identifier, because FR-015
 * asks for the duplicate to be linked rather than mentioned.
 *
 * @param db - The executor.
 * @param input - The two sides, the field snapshot and who asked.
 * @returns The pairing, or the identifier of the one it duplicates.
 * @throws {Error} When the duplicate cannot be found afterwards, which would mean a pairing was
 *   deleted - and pairings are never deleted.
 * @example
 * ```ts
 * const written = await insertPairing(db, {
 *   eventId: event.id,
 *   clientEnrolmentId: client.enrolment.id,
 *   serverEnrolmentId: server.enrolment.id,
 *   registrationFields: body.registrationFields,
 *   actorAccountId: callerId(c),
 *   actingForOrganisationId: client.organisation.id,
 *   now: context.clock(),
 * });
 * ```
 */
export async function insertPairing(
  db: Executor,
  input: NewPairing,
): Promise<PairingWrite> {
  try {
    return await db.transaction(async (tx) => {
      const created = requireRow(
        await tx
          .insert(pairing)
          .values({
            eventId: input.eventId,
            clientEnrolmentId: input.clientEnrolmentId,
            serverEnrolmentId: input.serverEnrolmentId,
            registrationFields: input.registrationFields,
            createdAt: input.now,
            updatedAt: input.now,
          })
          .returning(),
        "insert into pairing",
      );
      await tx.insert(pairingEvent).values({
        pairingId: created.id,
        actorAccountId: input.actorAccountId,
        actingForOrganisationId: input.actingForOrganisationId,
        // Null: the request created the pairing rather than moving it.
        fromState: null,
        toState: "requested",
        detail: {},
        at: input.now,
      });
      return { ok: true as const, pairing: created };
    });
  } catch (error) {
    if (!isUniqueViolation(error, "pairing_event_client_server_unique")) {
      throw error;
    }
    // Read outside the aborted transaction: the failed insert rolled it back.
    const existing = firstRow(
      await db
        .select({ id: pairing.id })
        .from(pairing)
        .where(
          and(
            eq(pairing.eventId, input.eventId),
            eq(pairing.clientEnrolmentId, input.clientEnrolmentId),
            eq(pairing.serverEnrolmentId, input.serverEnrolmentId),
          ),
        )
        .limit(1),
    );
    if (existing === undefined) {
      throw new Error(
        "a pairing collided with one that cannot be found; pairings are never deleted",
      );
    }
    return { ok: false, reason: "duplicate", pairingId: existing.id };
  }
}

/**
 * Moves a pairing to a new state and appends the transition to its timeline.
 *
 * Whether the transition is legal, and whether the caller is on the side that may make it, are
 * `transitionRefusal`'s decisions in `@muster/core`, made before this is called: those rules are
 * pure and belong where they can be exhaustively tested. What this adds is that the pairing has
 * not moved in the meantime.
 *
 * @param db - The executor.
 * @param input - The transition, what it changes, and who made it.
 * @returns The pairing, or why it did not move: no such pairing, or it is no longer in the state
 *   the caller read.
 * @example
 * ```ts
 * const moved = await transitionPairing(db, {
 *   pairingId: pairing.id,
 *   from: pairing.state,
 *   change: { to: "fulfilled", clientId: body.clientId },
 *   actorAccountId: callerId(c),
 *   actingForOrganisationId: server.organisation.id,
 *   now: context.clock(),
 * });
 * ```
 */
export async function transitionPairing(
  db: Executor,
  input: PairingTransitionInput,
): Promise<PairingTransitionWrite> {
  return await db.transaction(async (tx) => {
    const moved = firstRow(
      await tx
        .update(pairing)
        .set({
          state: input.change.to,
          ...changeValues(input.change),
          updatedAt: input.now,
        })
        .where(
          and(eq(pairing.id, input.pairingId), eq(pairing.state, input.from)),
        )
        .returning(),
    );

    if (moved === undefined) {
      // Which of the two it is matters to the caller: one is a 404 and the other is a
      // concurrent answer worth reporting as such.
      const present = await tx
        .select({ id: pairing.id })
        .from(pairing)
        .where(eq(pairing.id, input.pairingId))
        .limit(1);
      return {
        ok: false as const,
        reason:
          present.length === 0
            ? ("not-found" as const)
            : ("state-changed" as const),
      };
    }

    await tx.insert(pairingEvent).values({
      pairingId: moved.id,
      actorAccountId: input.actorAccountId,
      actingForOrganisationId: input.actingForOrganisationId,
      fromState: input.from,
      toState: input.change.to,
      detail: changeDetail(input.change),
      at: input.now,
    });
    return { ok: true as const, pairing: moved };
  });
}

/**
 * The pairings with these identifiers, most recently changed first.
 *
 * One query for however many, because the alternative - a lookup per pairing - is the shape that
 * is fine for one lapsed pairing and embarrassing for an event closing with forty.
 */
async function findPairings(
  db: Executor,
  ids: readonly string[],
): Promise<readonly PairingWithSides[]> {
  if (ids.length === 0) {
    return [];
  }
  const rows = await pairingQuery(db)
    .where(inArray(pairing.id, [...ids]))
    .orderBy(desc(pairing.updatedAt));
  return rows.map(toPairingWithSides);
}

/**
 * One pairing, with both sides.
 *
 * @param db - The executor.
 * @param id - The pairing's identifier.
 * @returns The pairing, or `undefined` when there is no such pairing.
 */
export async function findPairing(
  db: Executor,
  id: string,
): Promise<PairingWithSides | undefined> {
  return firstRow(await findPairings(db, [id]));
}

/**
 * The pairings an organisation is on either side of, most recently changed first.
 *
 * Both directions in one query, because the pairing list shows a member everything they are
 * party to and which side they are on is a property of the row rather than of the request
 * (FR-013, scenario 4). A member of both organisations sees the pairing once.
 *
 * @param db - The executor.
 * @param query - The caller's organisations, and an event slug to narrow to.
 * @returns The pairings, newest activity first.
 * @example
 * ```ts
 * const pairings = await listPairingsForOrganisations(db, {
 *   organisationIds: mine.map((organisation) => organisation.id),
 *   eventSlug: c.req.query("event"),
 * });
 * ```
 */
export async function listPairingsForOrganisations(
  db: Executor,
  query: PairingListQuery,
): Promise<readonly PairingWithSides[]> {
  if (query.organisationIds.length === 0) {
    // Nothing to match. Asked rather than assumed: an `in ()` predicate is a syntax error in
    // Postgres, and Drizzle's rendering of an empty list is not something to depend on.
    return [];
  }
  const ids = [...query.organisationIds];
  const rows = await pairingQuery(db)
    .where(
      and(
        or(
          inArray(clientOrganisation.id, ids),
          inArray(serverOrganisation.id, ids),
        ),
        ...(query.eventSlug === undefined
          ? []
          : [eq(event.slug, query.eventSlug)]),
      ),
    )
    .orderBy(desc(pairing.updatedAt));
  return rows.map(toPairingWithSides);
}

/**
 * One pairing's history, oldest first (FR-013).
 *
 * The same rows in the same order for both organisations: this is the timeline the requirement
 * describes, and a projection that varied by reader would make the two parties argue about what
 * happened.
 *
 * @param db - The executor.
 * @param pairingId - The pairing's identifier.
 * @returns The entries, each with who acted and which organisation they acted for.
 */
export async function listPairingTimeline(
  db: Executor,
  pairingId: string,
): Promise<readonly PairingTimelineRow[]> {
  const rows = await db
    .select({
      entry: pairingEvent,
      // The display name only. An address would make the timeline a contacts feed, and
      // contacts have their own gated route (FR-007).
      actorDisplayName: account.displayName,
      actingFor: organisation,
    })
    .from(pairingEvent)
    .leftJoin(account, eq(account.id, pairingEvent.actorAccountId))
    .leftJoin(
      organisation,
      eq(organisation.id, pairingEvent.actingForOrganisationId),
    )
    .where(eq(pairingEvent.pairingId, pairingId))
    .orderBy(pairingEvent.at, pairingEvent.id);
  return rows.map((row) => ({
    entry: row.entry,
    actorDisplayName: row.actorDisplayName,
    actingFor: row.actingFor,
  }));
}

/**
 * Lapses every pairing in an event that is still waiting for an answer (FR-011).
 *
 * Each pairing moves through {@link transitionPairing}, so each carries its own recorded
 * transition and each is conditional on the state it was read in - a request answered while the
 * event was being closed keeps its answer rather than being overwritten with a lapse.
 *
 * @param db - The executor.
 * @param input - The event, the admin who closed it (or null), and when.
 * @returns What lapsed, with both sides, so both organisations can be notified.
 * @example
 * ```ts
 * const lapsed = await lapseOpenPairings(db, {
 *   eventId: event.id,
 *   actorAccountId: callerId(c),
 *   now: context.clock(),
 * });
 * ```
 */
export async function lapseOpenPairings(
  db: Executor,
  input: PairingLapse,
): Promise<readonly PairingWithSides[]> {
  const open = await db
    .select({ id: pairing.id, state: pairing.state })
    .from(pairing)
    .where(
      and(
        eq(pairing.eventId, input.eventId),
        inArray(pairing.state, [...LAPSING_STATES]),
      ),
    );

  const moved = await Promise.all(
    open.map(async (row) => {
      const written = await transitionPairing(db, {
        pairingId: row.id,
        from: row.state,
        change: { to: "lapsed" },
        actorAccountId: input.actorAccountId,
        // A track admin closing an event acts as an admin, not for a participant.
        actingForOrganisationId: null,
        now: input.now,
      });
      return written.ok ? row.id : undefined;
    }),
  );

  return await findPairings(
    db,
    moved.filter((id): id is string => id !== undefined),
  );
}
