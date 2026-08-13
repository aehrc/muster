/**
 * Persona coverage: who holds the event's shared test patients, on the same interval.
 *
 * A second pass of the one in-process scheduler rather than a service of its own - the
 * constitution forbids queues, workers and background services - so `startCheckScheduler`
 * runs this beside the liveness checks and nothing else has to be deployed for FR-032 to
 * hold. Everything with an outside effect is injected: the clock, the randomness behind the
 * jitter, the transport, and the two target lists.
 *
 * ## Two questions, asked with one search
 *
 * A pass asks each *enrolled server* whether it holds a patient with each persona's IHI, and
 * asks the *source server* whether it still holds the persona itself. Both are the same
 * identifier search - `Patient?identifier=system|value` - pointed at different hosts, and
 * both are judged by `evaluateCoverage` in `@muster/core`, which is pure. What this module
 * decides is *when* and *whether*, which is scheduling rather than domain logic.
 *
 * Asking the source the same question is what catches both halves of the spec's edge case:
 * a curated patient that has been deleted, and one whose IHI has changed. Neither is
 * detectable by reading the resource that was curated, because a changed record is still
 * there.
 *
 * ## Nothing about a persona is decided by a server that did not answer
 *
 * A coverage row is written for every answer, including the ones that settle nothing -
 * `unverifiable` is a result, and a grid cell that stayed blank because a server timed out
 * would be indistinguishable from a pair nothing had checked. A *source* answer that settles
 * nothing is different: the persona's flag stays as it was and only its check time moves, so
 * a source server that was down for a minute has not flagged every persona as deleted.
 *
 * ## Cadence, jitter and single flight
 *
 * The same three as the check pass, and reused from it rather than restated: an event's
 * status decides how often its personas are verified, each target's wait carries jitter so a
 * cohort does not become due in the same second for ever, and a pair already being checked
 * by an overlapping pass is skipped rather than checked twice.
 *
 * Author: John Grimes
 */

import { evaluateCoverage, ihiSearchUrl, sourceStatusFor } from "@muster/core";
import {
  insertPersonaCoverage,
  listPersonaCoverageTargets,
  listPersonaSourceTargets,
  recordPersonaSourceCheck,
} from "@muster/db";

import {
  checkCadence,
  DEFAULT_OPEN_CHECK_INTERVAL_MS,
  discardLog,
  isCheckDue,
  toCheckFetch,
} from "./scheduler.js";
import { injectedOutbound } from "../context.js";
import { outboundFetch } from "../outbound/outboundFetch.js";

import type { CheckCadence } from "./scheduler.js";
import type { OutboundInjection } from "../context.js";
import type { CheckFetch } from "@muster/core";
import type {
  Database,
  PersonaCoverageTargetRow,
  PersonaSourceTargetRow,
} from "@muster/db";

/** What a coverage pass did, for the log line an operator reads (FR-037). */
export interface CoveragePassSummary {
  /** The personas considered, across every event with a configured source. */
  readonly personas: number;
  /** How many of them the source server was asked about. */
  readonly sourcesChecked: number;
  /** How many are flagged as missing at their source. */
  readonly flagged: number;
  /** The (persona, enrolled server) pairs considered. */
  readonly targets: number;
  /** How many pairs were checked and recorded. */
  readonly checked: number;
  /** How many pairs were not yet due. A persona's source check has its own cadence. */
  readonly notDue: number;
  /** How many pairs were already being checked by an overlapping pass. */
  readonly inFlight: number;
  /** How many of the checked ones held the patient. */
  readonly found: number;
  /** How many could not be recorded at all. */
  readonly errors: number;
}

/** What the coverage runner needs. Everything with an outside effect is injectable. */
export interface CoverageRunnerOptions {
  readonly db: Database;
  readonly clock: () => Date;
  /** The identifier system a persona's IHI is searched by. Configuration, not a constant. */
  readonly ihiSystem: string;
  /** Hosts the outbound guard may reach on a private address or over plain HTTP. */
  readonly allowedHosts?: readonly string[];
  readonly cadence?: CheckCadence;
  readonly timeoutMs?: number;
  readonly random?: () => number;
  /** The transport and resolver the guard uses. Injected so no suite needs a network. */
  readonly outbound?: OutboundInjection;
  /** Where the personas come from. Injected so a suite can narrow to its own fixtures. */
  readonly listSourceTargets?: (
    db: Database,
  ) => Promise<readonly PersonaSourceTargetRow[]>;
  /** Where the pairs come from. Injected for the same reason. */
  readonly listCoverageTargets?: (
    db: Database,
  ) => Promise<readonly PersonaCoverageTargetRow[]>;
  readonly log?: (message: string) => void;
}

/** Runs coverage passes. */
export interface CoverageRunner {
  readonly runPass: () => Promise<CoveragePassSummary>;
}

/** What a pass counts as it goes. */
interface Tally {
  sourcesChecked: number;
  flagged: number;
  checked: number;
  notDue: number;
  inFlight: number;
  found: number;
  errors: number;
}

/** How one unit of a pass ended. */
type AttemptOutcome = "ran" | "not-due" | "in-flight" | "failed";

/** How one failure is described in the log. */
function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Creates a coverage runner over one database and one transport.
 *
 * @param options - The database, the clock, the IHI system, and the injection points.
 * @returns The runner. The in-flight set lives in its closure, so two passes from one runner
 *   never check one pair twice and two runners are independent.
 * @example
 * ```ts
 * const coverage = createCoverageRunner({
 *   db,
 *   clock: () => new Date(),
 *   ihiSystem: config.ihiSystem,
 *   allowedHosts: config.outboundAllowedHosts,
 * });
 * startCheckScheduler({ db, clock: () => new Date(), coverage });
 * ```
 */
export function createCoverageRunner(
  options: CoverageRunnerOptions,
): CoverageRunner {
  const cadence =
    options.cadence ?? checkCadence(DEFAULT_OPEN_CHECK_INTERVAL_MS);
  const random = options.random ?? Math.random;
  const listSources = options.listSourceTargets ?? listPersonaSourceTargets;
  const listPairs = options.listCoverageTargets ?? listPersonaCoverageTargets;
  const log = options.log ?? discardLog;
  /** The personas and pairs a pass is currently checking. */
  const inFlight = new Set<string>();

  /** Asks one server whether it holds a patient with this IHI, through the one guarded path. */
  const search = async (
    fhirBaseUrl: string,
    ihi: string,
  ): Promise<CheckFetch> =>
    toCheckFetch(
      await outboundFetch(ihiSearchUrl(fhirBaseUrl, options.ihiSystem, ihi), {
        allowedHosts: options.allowedHosts ?? [],
        ...(options.timeoutMs === undefined
          ? {}
          : { timeoutMs: options.timeoutMs }),
        ...injectedOutbound(options.outbound),
      }),
    );

  /** Whether this target has waited long enough, given its event's status. */
  const due = (
    status: PersonaSourceTargetRow["eventStatus"],
    at: Date | null,
    now: Date,
  ) =>
    isCheckDue(
      { eventStatus: status, lastCheckedAt: at },
      now,
      cadence,
      random,
    );

  /** Asks the source server whether it still holds one persona (FR-032's edge case). */
  const checkSource = async (
    target: PersonaSourceTargetRow,
    tally: Tally,
  ): Promise<void> => {
    const evaluation = evaluateCoverage({
      fetched: await search(target.personaSourceUrl, target.ihi),
      ihi: target.ihi,
      ihiSystem: options.ihiSystem,
    });
    const sourceStatus = sourceStatusFor(evaluation.outcome);
    await recordPersonaSourceCheck(options.db, {
      personaId: target.personaId,
      checkedAt: options.clock(),
      // Null leaves the flag as it was: an answer that settled nothing is not a deletion.
      sourceStatus,
    });
    tally.sourcesChecked += 1;
    if ((sourceStatus ?? target.sourceStatus) === "missing") {
      tally.flagged += 1;
    }
  };

  /** Asks one enrolled server about one persona, and records what it said (FR-032). */
  const checkPair = async (
    target: PersonaCoverageTargetRow,
    tally: Tally,
  ): Promise<void> => {
    const evaluation = evaluateCoverage({
      fetched: await search(target.fhirBaseUrl, target.ihi),
      ihi: target.ihi,
      ihiSystem: options.ihiSystem,
    });
    await insertPersonaCoverage(options.db, {
      personaId: target.personaId,
      enrolmentId: target.enrolmentId,
      checkedAt: options.clock(),
      outcome: evaluation.outcome,
      detail: evaluation.detail,
    });
    tally.checked += 1;
    if (evaluation.outcome === "found") {
      tally.found += 1;
    }
  };

  /**
   * Runs one unit of work, unless it is not due or an overlapping pass has it.
   *
   * The bookkeeping is identical for a source check and a pair check - single flight, due
   * or not, count the failure and carry on - so it is written once and the work is passed
   * in. One target that cannot be recorded must not cost the others their check.
   */
  const attempt = async (
    key: string,
    lastCheckedAt: Date | null,
    status: PersonaSourceTargetRow["eventStatus"],
    now: Date,
    work: () => Promise<void>,
  ): Promise<AttemptOutcome> => {
    if (inFlight.has(key)) {
      return "in-flight";
    }
    if (!due(status, lastCheckedAt, now)) {
      return "not-due";
    }
    inFlight.add(key);
    try {
      await work();
      return "ran";
    } catch (error) {
      log(`muster.coverage.failed ${key}: ${reason(error)}`);
      return "failed";
    } finally {
      inFlight.delete(key);
    }
  };

  const runPass = async (): Promise<CoveragePassSummary> => {
    const now = options.clock();
    const tally: Tally = {
      sourcesChecked: 0,
      flagged: 0,
      checked: 0,
      notDue: 0,
      inFlight: 0,
      found: 0,
      errors: 0,
    };

    const sources = await listSources(options.db);
    for (const target of sources) {
      // Serially, and deliberately: a pass is a loop over other people's test servers, and
      // the point is not to arrive at all of them at once.
      const outcome = await attempt(
        `source:${target.personaId}`,
        target.sourceCheckedAt,
        target.eventStatus,
        now,
        async () => {
          await checkSource(target, tally);
        },
      );
      if (outcome === "failed") {
        tally.errors += 1;
      }
      // A persona already flagged and not due for another look is still flagged, and the
      // summary is what an operator reads to know how many need attention.
      if (outcome !== "ran" && target.sourceStatus === "missing") {
        tally.flagged += 1;
      }
    }

    const pairs = await listPairs(options.db);
    for (const target of pairs) {
      const outcome = await attempt(
        `${target.personaId}:${target.enrolmentId}`,
        target.lastCheckedAt,
        target.eventStatus,
        now,
        async () => {
          await checkPair(target, tally);
        },
      );
      if (outcome === "not-due") {
        tally.notDue += 1;
      }
      if (outcome === "in-flight") {
        tally.inFlight += 1;
      }
      if (outcome === "failed") {
        tally.errors += 1;
      }
    }

    return {
      personas: sources.length,
      targets: pairs.length,
      sourcesChecked: tally.sourcesChecked,
      flagged: tally.flagged,
      checked: tally.checked,
      notDue: tally.notDue,
      inFlight: tally.inFlight,
      found: tally.found,
      errors: tally.errors,
    };
  };

  return { runPass };
}
