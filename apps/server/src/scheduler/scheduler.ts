/**
 * The liveness checks, on an interval inside the one server instance.
 *
 * The constitution forbids queues, workers and background services, so this is
 * `setInterval` and a closure - which at connectathon scale is not a compromise: tens of
 * servers, two requests each, and a Helm chart that pins `replicas: 1` for exactly this
 * reason. Results are persisted, so a restart costs at most one pass.
 *
 * ## What it decides, and where
 *
 * Nothing here judges a document. The scheduler fetches two addresses through the SSRF
 * guard and hands the outcomes to `evaluateCheck` in `@muster/core`, which decides
 * reachability, drift and the failure mode; this module decides *when* and *whether*, which
 * is scheduling rather than domain logic. Both the clock and the source of randomness are
 * injected, so the cadence and the jitter are unit-testable with no real time.
 *
 * ## Cadence
 *
 * SC-004 fixes the number: an unreachable enrolled server is visibly flagged within one
 * check interval, fifteen minutes or less during an event. A draft event nobody has opened
 * and a closed one whose participants have gone home get multiples of that, because FR-017
 * says every enrolled server and says nothing about hammering them.
 *
 * ## Jitter
 *
 * Twenty servers enrolled in the same afternoon become due in the same minute, for ever,
 * and a directory that fires twenty simultaneous requests every quarter of an hour looks
 * like something worth blocking. Each target's wait is its interval plus up to
 * {@link CHECK_JITTER_FRACTION} of it, drawn per decision, which spreads the times apart
 * within a pass or two and never delays a check by enough to break SC-004.
 *
 * ## Single flight
 *
 * A pass that outlasts the interval overlaps the next one. Without the in-flight set, one
 * server would get two simultaneous checks and two rows for one observation - so a target
 * already being checked is counted and skipped. That is also what makes the worst case
 * safe: fifty servers all timing out at ten seconds each is a pass longer than the
 * interval, and the overlapping pass simply finds every target in flight.
 *
 * The two documents for one target are fetched together, because they are two addresses on
 * one host and waiting for the first to fail before starting the second would double the
 * time a dead server costs the pass.
 *
 * Author: John Grimes
 */

import {
  capabilityStatementUrl,
  evaluateCheck,
  smartConfigurationUrl,
} from "@muster/core";
import { insertCheckResult, listServerCheckTargets } from "@muster/db";

import { outboundFetch } from "../outbound/outboundFetch.js";

import type {
  AddressResolver,
  OutboundFetchImpl,
  OutboundResult,
} from "../outbound/outboundFetch.js";
import type { CheckFetch, EventStatus } from "@muster/core";
import type { CheckTargetRow, Database } from "@muster/db";

/** How often a server enrolled in an event of each status is checked. */
export interface CheckCadence {
  readonly open: number;
  readonly draft: number;
  readonly closed: number;
}

/** What a pass did, for the log line an operator reads. */
export interface CheckPassSummary {
  /** The server enrolments considered. */
  readonly targets: number;
  /** How many were checked and recorded. */
  readonly checked: number;
  /** How many were not yet due. */
  readonly notDue: number;
  /** How many were already being checked by an overlapping pass. */
  readonly inFlight: number;
  /** How many of the checked ones answered. */
  readonly reachable: number;
  /** How many could not be recorded at all. */
  readonly errors: number;
}

/** What the runner needs. Everything with an outside effect is injectable. */
export interface CheckRunnerOptions {
  readonly db: Database;
  readonly clock: () => Date;
  /** Hosts the outbound guard may reach on a private address or over plain HTTP. */
  readonly allowedHosts?: readonly string[];
  readonly cadence?: CheckCadence;
  readonly timeoutMs?: number;
  readonly random?: () => number;
  /** The transport `outboundFetch` calls. Injected so no suite needs a network. */
  readonly fetchImpl?: OutboundFetchImpl;
  /** The resolver `outboundFetch` calls. Injected so no suite needs DNS. */
  readonly resolve?: AddressResolver;
  /** Where the targets come from. Injected so a suite can narrow to its own fixtures. */
  readonly listTargets?: (db: Database) => Promise<readonly CheckTargetRow[]>;
  readonly log?: (message: string) => void;
}

/** Runs check passes. */
export interface CheckRunner {
  readonly runPass: () => Promise<CheckPassSummary>;
}

/** A running scheduler. */
export interface CheckScheduler extends CheckRunner {
  /**
   * The pass started at construction.
   *
   * Exposed rather than left to run unobserved: a restart mid-event must not leave every
   * entry stale for a whole interval, and the entry point logs what the first pass did
   * (FR-037).
   */
  readonly firstPass: Promise<CheckPassSummary>;
  /** Stops the interval. Safe to call more than once. */
  readonly stop: () => void;
}

/**
 * Where a message goes when the caller supplied nowhere.
 *
 * A pass that cannot record one target logs and carries on; a suite that does not care about
 * the message passes nothing and gets silence rather than noise in its output.
 */
function discardLog(message: string): void {
  void message;
}

/** Fifteen minutes: the ceiling SC-004 puts on an open event's check interval. */
export const DEFAULT_OPEN_CHECK_INTERVAL_MS = 900_000;

/**
 * How much of an interval the jitter may add.
 *
 * Small deliberately. It has to be enough to pull a cohort of targets apart and little
 * enough that a target of an open event is still checked within a quarter of an hour of
 * becoming due, which is what SC-004 promises a reader.
 */
export const CHECK_JITTER_FRACTION = 0.2;

/** A draft event's interval, as a multiple of the configured one: six hours by default. */
const DRAFT_INTERVAL_MULTIPLIER = 24;

/** A closed event's interval, as a multiple of the configured one: a day by default. */
const CLOSED_INTERVAL_MULTIPLIER = 96;

/**
 * The cadence derived from one configured interval.
 *
 * One number is configured - the one SC-004 constrains - and the other two are multiples of
 * it, so a deployment that shortens the interval for a busy event shortens everything
 * proportionally rather than acquiring three variables that can disagree.
 *
 * @param openIntervalMs - How often an open event's servers are checked.
 * @returns The interval for each event status.
 * @example
 * ```ts
 * const cadence = checkCadence(config.checkIntervalMs);
 * ```
 */
export function checkCadence(openIntervalMs: number): CheckCadence {
  return {
    open: openIntervalMs,
    draft: openIntervalMs * DRAFT_INTERVAL_MULTIPLIER,
    closed: openIntervalMs * CLOSED_INTERVAL_MULTIPLIER,
  };
}

/**
 * How often a target of an event in this status is checked.
 *
 * @param status - The event's status.
 * @param cadence - The intervals in force.
 * @returns The interval, in milliseconds.
 */
export function checkIntervalMs(
  status: EventStatus,
  cadence: CheckCadence,
): number {
  return cadence[status];
}

/**
 * Whether a target is due to be checked.
 *
 * @param target - The event's status, and when the target was last checked.
 * @param now - The current time.
 * @param cadence - The intervals in force.
 * @param random - A draw in `[0, 1)`, for the jitter.
 * @returns `true` when the target should be checked now. A target nobody has ever checked
 *   is always due: an entry showing "not checked yet" for a quarter of an hour is the
 *   staleness this story exists to remove.
 * @example
 * ```ts
 * if (!isCheckDue(target, now, cadence, random)) {
 *   continue;
 * }
 * ```
 */
export function isCheckDue(
  target: Pick<CheckTargetRow, "eventStatus" | "lastCheckedAt">,
  now: Date,
  cadence: CheckCadence,
  random: () => number,
): boolean {
  if (target.lastCheckedAt === null) {
    return true;
  }
  const interval = checkIntervalMs(target.eventStatus, cadence);
  const jitter = Math.floor(interval * CHECK_JITTER_FRACTION * random());
  return now.getTime() - target.lastCheckedAt.getTime() >= interval + jitter;
}

/**
 * Reshapes a guarded fetch's outcome into what the pure evaluation reads.
 *
 * The mapping is the whole of the seam between the guard and the domain: the guard's
 * refusal vocabulary becomes the check's failure modes, and an HTTP status is data rather
 * than a failure.
 */
function toCheckFetch(result: OutboundResult): CheckFetch {
  return result.ok
    ? {
        ok: true,
        status: result.value.status,
        body: result.value.body,
      }
    : { ok: false, reason: result.reason, description: result.description };
}

/**
 * Creates a runner over one database and one transport.
 *
 * @param options - The database, the clock, and the injection points.
 * @returns The runner. The in-flight set lives in its closure, so two passes from one
 *   runner never check one target twice and two runners are independent.
 * @example
 * ```ts
 * const runner = createCheckRunner({ db, clock: context.clock });
 * await runner.runPass();
 * ```
 */
export function createCheckRunner(options: CheckRunnerOptions): CheckRunner {
  const cadence =
    options.cadence ?? checkCadence(DEFAULT_OPEN_CHECK_INTERVAL_MS);
  const random = options.random ?? Math.random;
  const listTargets = options.listTargets ?? listServerCheckTargets;
  const log = options.log ?? discardLog;
  /** The enrolments a pass is currently checking. */
  const inFlight = new Set<string>();

  /** Fetches one address through the one guarded path. */
  const fetchDocument = async (url: string): Promise<CheckFetch> =>
    toCheckFetch(
      await outboundFetch(url, {
        allowedHosts: options.allowedHosts ?? [],
        ...(options.timeoutMs === undefined
          ? {}
          : { timeoutMs: options.timeoutMs }),
        ...(options.fetchImpl === undefined
          ? {}
          : { fetchImpl: options.fetchImpl }),
        ...(options.resolve === undefined ? {} : { resolve: options.resolve }),
      }),
    );

  /** Checks one target and records what it found. */
  const checkTarget = async (target: CheckTargetRow): Promise<boolean> => {
    const baseUrl = target.serverProfile.fhirBaseUrl;
    // Together: two addresses on one host, and waiting for the first to time out before
    // starting the second would double what a dead server costs the pass.
    const [discovery, capability] = await Promise.all([
      fetchDocument(smartConfigurationUrl(baseUrl)),
      fetchDocument(capabilityStatementUrl(baseUrl)),
    ]);
    const evaluation = evaluateCheck({
      declared: target.serverProfile,
      discovery,
      capability,
    });
    await insertCheckResult(options.db, {
      enrolmentId: target.enrolmentId,
      checkedAt: options.clock(),
      ...evaluation,
    });
    return evaluation.reachable;
  };

  const runPass = async (): Promise<CheckPassSummary> => {
    const targets = await listTargets(options.db);
    const now = options.clock();
    let checked = 0;
    let notDue = 0;
    let alreadyRunning = 0;
    let reachable = 0;
    let errors = 0;

    for (const target of targets) {
      if (inFlight.has(target.enrolmentId)) {
        alreadyRunning += 1;
        continue;
      }
      if (!isCheckDue(target, now, cadence, random)) {
        notDue += 1;
        continue;
      }
      inFlight.add(target.enrolmentId);
      try {
        // Serially, and deliberately: a pass is a loop over other people's test servers,
        // and the point is not to arrive at all of them at once.
        if (await checkTarget(target)) {
          reachable += 1;
        }
        checked += 1;
      } catch (error) {
        // One target that cannot be recorded must not cost the others their check.
        errors += 1;
        log(
          `muster.check.failed ${target.systemName}: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        inFlight.delete(target.enrolmentId);
      }
    }

    return {
      targets: targets.length,
      checked,
      notDue,
      inFlight: alreadyRunning,
      reachable,
      errors,
    };
  };

  return { runPass };
}

/**
 * Starts the interval, after running one pass immediately.
 *
 * @param options - The runner's options, and how often a pass runs. A pass is cheap when
 *   nothing is due, so the pass interval is shorter than any check interval: it is how
 *   often the scheduler *looks*, not how often a server is fetched.
 * @returns The scheduler, its first pass, and the means to stop it.
 * @example
 * ```ts
 * const scheduler = startCheckScheduler({ db, clock: () => new Date() });
 * console.log(JSON.stringify(await scheduler.firstPass));
 * ```
 */
export function startCheckScheduler(
  options: CheckRunnerOptions & { readonly passIntervalMs?: number },
): CheckScheduler {
  const runner = createCheckRunner(options);
  const log = options.log ?? discardLog;

  /** Runs a pass, reporting rather than throwing: an interval callback cannot be awaited. */
  const pass = async (): Promise<CheckPassSummary> => {
    try {
      return await runner.runPass();
    } catch (error) {
      log(
        `muster.check.pass-failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return {
        targets: 0,
        checked: 0,
        notDue: 0,
        inFlight: 0,
        reachable: 0,
        errors: 1,
      };
    }
  };

  const timer = setInterval(() => {
    void pass();
  }, options.passIntervalMs ?? 60_000);
  // So that a pass in flight cannot hold the process open past a shutdown. Guarded because
  // the method is Node's and not part of the DOM timer type.
  timer.unref?.();

  return {
    ...runner,
    firstPass: pass(),
    stop: () => {
      clearInterval(timer);
    },
  };
}
