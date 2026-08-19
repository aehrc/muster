import { serverProfileSchema } from "@muster/contracts";
import { checkDue, evaluateCheck, evaluateCheckFailure } from "@muster/core";
import { insertCheckResult, listCheckTargets } from "@muster/db";

import { outboundOverrides, scheduledEventStatuses } from "./dependencies.ts";
import { runDuePersonaChecks } from "./personas.ts";
import { fetchJson } from "../outbound/fetchJson.ts";

import type { SchedulerDependencies } from "./dependencies.ts";
import type { PersonaRunSummary } from "./personas.ts";
import type { CheckEvaluation, ProbeOutcome } from "@muster/core";
import type { CheckTargetRow } from "@muster/db";

/**
 * The in-process scheduler: the only thing in Muster that acts without being
 * asked.
 *
 * One interval in one instance, as the constitution requires, and it drives both
 * passes: the liveness and discovery checks in this module, and the persona
 * coverage and source checks in `./personas.ts`. They share the tick, the
 * single-flight set and the cadence rule, so adding the persona work did not add
 * a second thing that acts on its own.
 *
 * There is no queue and no worker, and there does not need to be: at
 * connectathon scale the work is a few dozen servers and a few small requests
 * each. Every result is persisted, so the scheduler holds no state a restart
 * could lose - which is also what lets it decide what is due purely from the
 * rows and the clock.
 *
 * Three rules are worth naming because they are what stop the scheduler being a
 * nuisance. A target is checked once at a time, so a server that has become slow
 * cannot accumulate overlapping probes. A tick that arrives while a pass is
 * still running is dropped rather than queued. And the cadence is asked of
 * `@muster/core`, so "15 minutes while an event is open" (SC-004) is a rule with
 * a test rather than a number buried in a `setInterval` call.
 *
 * Every request goes through `outboundFetch`, which is the only path to the
 * network. A target the guard refuses is recorded as a refusal naming the reason
 * and no request is made (FR-020) - never skipped, because an entry with no
 * status looks the same as one that passed.
 *
 * @author John Grimes
 */

export type { SchedulerDependencies } from "./dependencies.ts";
export type { PersonaRunSummary } from "./personas.ts";

/** What one pass of the scheduler did. */
export type CheckRunSummary = {
  /** the enrolments checked */
  readonly checked: readonly string[];
  /** the enrolments left alone, because they were not due or already running */
  readonly skipped: readonly string[];
};

/** A running scheduler. */
export type Scheduler = {
  /** runs one pass now */
  readonly runDueChecks: () => Promise<CheckRunSummary>;
  /** runs one persona pass now */
  readonly runDuePersonaChecks: () => Promise<PersonaRunSummary>;
  /** starts the interval, with an immediate first pass */
  readonly start: () => void;
  /** stops the interval */
  readonly stop: () => void;
};

/**
 * How often the scheduler looks for due targets.
 *
 * A minute is well inside the shortest cadence, so a target becomes due and is
 * checked within a minute of becoming due, and the pass costs one query when
 * nothing is due.
 */
const defaultTickIntervalMs = 60_000;

/** Where a server publishes its SMART configuration. */
const discoveryPath = "/.well-known/smart-configuration";

/** Where a FHIR server publishes its capability statement. */
const capabilityPath = "/metadata";

/**
 * Failure modes that are facts about the address rather than about one path.
 *
 * When the first probe fails this way the second would fail identically, so it
 * is not attempted: a guarded target must produce no request at all, and asking
 * an unreachable host twice only doubles the wait.
 */
const addressLevelFailures: readonly string[] = ["guarded", "refused"];

/**
 * Joins a base URL and a path without doubling the slash between them.
 *
 * @param baseUrl - the declared FHIR base URL
 * @param path - the path to append, with its leading slash
 * @returns the absolute URL to fetch
 */
const probeUrl = (baseUrl: string, path: string): string =>
  `${baseUrl.replace(/\/+$/, "")}${path}`;

/**
 * Fetches one document from a participant-supplied address, under the guard.
 *
 * @param dependencies - the configuration and the injected fetch and resolver
 * @param url - the URL to fetch
 * @returns the document, or the reason there is none
 */
const probe = async (
  dependencies: SchedulerDependencies,
  url: string,
): Promise<ProbeOutcome> => {
  const answer = await fetchJson(url, {
    outbound: dependencies.config.outbound,
    overrides: outboundOverrides(dependencies),
  });
  if (!answer.ok) {
    return {
      ok: false,
      failureMode: answer.failureMode,
      detail: answer.detail,
    };
  }
  if (answer.status < 200 || answer.status > 299) {
    return {
      ok: false,
      failureMode: "invalid",
      detail: `${url} answered ${String(answer.status)}`,
    };
  }
  return answer.document === undefined
    ? {
        ok: false,
        failureMode: "invalid",
        detail: `${url} did not answer with JSON`,
      }
    : { ok: true, document: answer.document };
};

/**
 * Checks one target, without recording anything.
 *
 * @param dependencies - the configuration and the injected fetch and resolver
 * @param target - the server enrolment to check
 * @returns the evaluation to record
 */
const evaluateTarget = async (
  dependencies: SchedulerDependencies,
  target: CheckTargetRow,
): Promise<CheckEvaluation> => {
  const declared = serverProfileSchema.safeParse(target.serverProfile);
  if (!declared.success) {
    // Deny by default: an entry Muster cannot read is flagged rather than
    // quietly passed over, because a reader cannot tell a gap from a pass.
    return evaluateCheckFailure({
      failureMode: "invalid",
      detail:
        "The declared server profile could not be read, so nothing was checked.",
    });
  }

  const discovery = await probe(
    dependencies,
    probeUrl(declared.data.fhirBaseUrl, discoveryPath),
  );
  if (!discovery.ok && addressLevelFailures.includes(discovery.failureMode)) {
    return evaluateCheckFailure({
      failureMode: discovery.failureMode,
      detail: discovery.detail,
    });
  }
  const capability = await probe(
    dependencies,
    probeUrl(declared.data.fhirBaseUrl, capabilityPath),
  );
  return evaluateCheck({ declared: declared.data, discovery, capability });
};

/**
 * Builds the scheduler.
 *
 * @param dependencies - the connection, the configuration and the injectables
 * @returns the scheduler, not yet started
 * @example
 * ```ts
 * const scheduler = createScheduler({ sql, config });
 * scheduler.start();
 * ```
 */
export const createScheduler = (
  dependencies: SchedulerDependencies,
): Scheduler => {
  const log = dependencies.log ?? ((line: string) => console.log(line));
  const now = dependencies.now ?? (() => new Date());
  const tickIntervalMs = dependencies.tickIntervalMs ?? defaultTickIntervalMs;

  // The two pieces of state the scheduler keeps, and neither is a result: which
  // targets are being checked right now, and whether a pass is running.
  const inFlight = new Set<string>();
  let passRunning = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  const runDueChecks = async (): Promise<CheckRunSummary> => {
    const at = now();
    const targets = await listCheckTargets(
      dependencies.sql,
      scheduledEventStatuses,
    );
    const due: CheckTargetRow[] = [];
    const skipped: string[] = [];
    for (const target of targets) {
      const runnable =
        !inFlight.has(target.enrolmentId) &&
        checkDue({
          key: target.enrolmentId,
          eventStatus: target.eventStatus,
          lastCheckedAt: target.lastCheckedAt,
          now: at,
        });
      if (runnable) {
        // Claimed before anything is awaited, so an overlapping pass sees it.
        inFlight.add(target.enrolmentId);
        due.push(target);
      } else {
        skipped.push(target.enrolmentId);
      }
    }

    const checked: string[] = [];
    for (const target of due) {
      try {
        const evaluation = await evaluateTarget(dependencies, target);
        await insertCheckResult(dependencies.sql, {
          enrolmentId: target.enrolmentId,
          checkedAt: at,
          reachable: evaluation.reachable,
          failureMode: evaluation.failureMode,
          detail: evaluation.detail,
          discovery: evaluation.discovery,
          capability: evaluation.capability,
          driftFlags: evaluation.driftFlags,
        });
        checked.push(target.enrolmentId);
        log(
          `Checked ${target.systemName} in ${target.eventSlug}: ` +
            (evaluation.reachable
              ? `reachable, ${String(evaluation.driftFlags.length)} drift flag(s)`
              : `${evaluation.failureMode ?? "unreachable"} - ${evaluation.detail ?? ""}`),
        );
      } catch (cause) {
        // One target's failure must not end the pass: the others still need
        // checking, and the reason is the operator's to see.
        log(
          `Could not check ${target.systemName} in ${target.eventSlug}: ` +
            (cause instanceof Error ? cause.message : String(cause)),
        );
      } finally {
        inFlight.delete(target.enrolmentId);
      }
    }
    return { checked, skipped };
  };

  const tick = async (): Promise<void> => {
    if (passRunning) {
      // A pass that has outlasted its interval is not helped by a second one
      // starting beside it.
      return;
    }
    passRunning = true;
    try {
      await runDueChecks();
      // The same pass, not a second interval: the constitution allows one
      // scheduler, and the persona work is the same shape as the checks.
      await runDuePersonaChecks(dependencies, now(), inFlight);
    } finally {
      passRunning = false;
    }
  };

  return {
    runDueChecks,
    runDuePersonaChecks: () =>
      runDuePersonaChecks(dependencies, now(), inFlight),
    start: () => {
      if (timer !== undefined) {
        return;
      }
      timer = setInterval(() => {
        void tick();
      }, tickIntervalMs);
      // An immediate first pass: after a restart, an entry that has gone stale
      // should not wait out an interval before anybody is told.
      void tick();
    },
    stop: () => {
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
    },
  };
};
