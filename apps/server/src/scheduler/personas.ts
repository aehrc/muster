/*
 * Copyright © 2026 Commonwealth Scientific and Industrial Research Organisation
 * (CSIRO) ABN 41 687 119 230. Licensed under the Apache License, Version 2.0.
 */

import { serverProfileSchema } from "@muster/contracts";
import {
  checkDue,
  evaluateCoverage,
  evaluateSourcePresence,
  patientReadUrl,
  personaIdentifierSearchUrl,
} from "@muster/core";
import {
  insertPersonaCoverage,
  listCoverageTargets,
  listPersonaSourceTargets,
  updatePersonaSourceStatus,
} from "@muster/db";

import { outboundOverrides, scheduledEventStatuses } from "./dependencies.ts";
import { fetchJson } from "../outbound/fetchJson.ts";

import type { SchedulerDependencies } from "./dependencies.ts";
import type {
  CoverageEvaluation,
  PersonaProbe,
  SourcePresence,
} from "@muster/core";
import type { CoverageTargetRow, SourceTargetRow } from "@muster/db";

/**
 * The persona pass: coverage of each persona at each enrolled server, and whether
 * the source still holds what was curated.
 *
 * It runs inside the one in-process scheduler rather than beside it, because the
 * constitution allows one and because the two passes want the same things - a
 * cadence rule from `@muster/core`, a guarded fetch, and rows that make a restart
 * harmless. Cadence is literally the same rule: `checkDue` over a stable key, so a
 * pair keeps its slot in the window across restarts and an open event's grid is
 * never more than fifteen minutes stale (SC-004).
 *
 * Two refusals are worth naming, because both are the difference between a grid
 * that can be trusted and one that cannot.
 *
 * A server that cannot be searched is recorded as `unverifiable` with the reason,
 * never as `missing`. That includes an address the guard refuses: the refusal is
 * Muster's own, no request is made, and the cell says so (FR-020, FR-032).
 *
 * A source that could not be read changes no flag. The persona's `sourceStatus`
 * only moves on an answer from the source itself - the patient is gone, or its IHI
 * has changed - so a source that is briefly down does not tell every admin their
 * persona set has rotted.
 *
 * @author John Grimes
 */

/** What one persona pass did. */
export type PersonaRunSummary = {
  /** the (persona, enrolment) pairs whose coverage was checked */
  readonly coverage: readonly string[];
  /** the pairs left alone, because they were not due or already running */
  readonly coverageSkipped: readonly string[];
  /** the personas verified against their source */
  readonly sources: readonly string[];
  /** the personas left alone */
  readonly sourcesSkipped: readonly string[];
};

/**
 * The key one (persona, server) pair is claimed and scheduled under.
 *
 * @param target - the pair
 * @returns the key, stable across restarts so the pair keeps its cadence slot
 */
const pairKey = (target: CoverageTargetRow): string =>
  `${target.personaId}:${target.enrolmentId}`;

/**
 * The key one persona's source check is claimed and scheduled under.
 *
 * @param target - the persona
 * @returns the key, distinct from any coverage pair's
 */
const sourceKey = (target: SourceTargetRow): string =>
  `source:${target.personaId}`;

/**
 * Reads one FHIR document from a participant-supplied address, under the guard.
 *
 * The status travels with the body because it is half the answer: an authorization
 * challenge is what makes a cell `unverifiable`, and a `404` from the source is
 * what makes a persona missing at source.
 *
 * @param dependencies - the configuration and the injected fetch and resolver
 * @param url - the URL to fetch
 * @returns the answer, or the reason there is none
 */
const read = async (
  dependencies: SchedulerDependencies,
  url: string,
): Promise<PersonaProbe> => {
  const answer = await fetchJson(url, {
    outbound: dependencies.config.outbound,
    overrides: outboundOverrides(dependencies),
  });
  return answer.ok
    ? { ok: true, status: answer.status, document: answer.document }
    : { ok: false, failureMode: answer.failureMode, detail: answer.detail };
};

/**
 * Evaluates one persona's coverage at one enrolled server.
 *
 * @param dependencies - the configuration and the injected fetch and resolver
 * @param target - the pair to check
 * @param ihiSystem - the configured IHI identifier system
 * @returns the cell to record
 */
const coverageOf = async (
  dependencies: SchedulerDependencies,
  target: CoverageTargetRow,
  ihiSystem: string,
): Promise<CoverageEvaluation> => {
  const declared = serverProfileSchema.safeParse(target.serverProfile);
  if (!declared.success) {
    // Deny by default: an entry Muster cannot read is reported as unverifiable
    // rather than searched at a guessed address.
    return {
      outcome: "unverifiable",
      detail:
        "The declared server profile could not be read, so nothing was searched.",
    };
  }
  const probe = await read(
    dependencies,
    personaIdentifierSearchUrl(declared.data.fhirBaseUrl, {
      ihi: target.ihi,
      ihiSystem,
    }),
  );
  return evaluateCoverage(probe, { ihi: target.ihi, ihiSystem });
};

/**
 * Verifies one persona against the source it was curated from.
 *
 * @param dependencies - the configuration and the injected fetch and resolver
 * @param target - the persona to verify
 * @param ihiSystem - the configured IHI identifier system
 * @returns the flag to store, or null to leave the stored flag alone
 */
const presenceOf = async (
  dependencies: SchedulerDependencies,
  target: SourceTargetRow,
  ihiSystem: string,
): Promise<SourcePresence> => {
  if (target.personaSourceUrl === null) {
    // The event's source has been removed since the persona was curated: nothing
    // can be established, and nothing is claimed.
    return {
      status: null,
      detail: "The event no longer names a persona source.",
    };
  }
  const probe = await read(
    dependencies,
    patientReadUrl(target.personaSourceUrl, target.patientId),
  );
  return evaluateSourcePresence(probe, {
    ihi: target.ihi,
    ihiSystem,
    patientId: target.patientId,
  });
};

/**
 * Runs one persona pass: coverage first, then the source flags.
 *
 * Coverage first because it is what the public grid shows; the source flag is for
 * an admin and can wait a moment. A single target's failure does not end the pass:
 * the others still need checking, and the reason is the operator's to see.
 *
 * @param dependencies - the connection, the configuration and the injectables
 * @param at - the instant the pass is running at
 * @param inFlight - the keys already being checked, claimed before any await
 * @returns what the pass did
 * @example
 * ```ts
 * const summary = await runDuePersonaChecks(dependencies, now(), inFlight);
 * ```
 */
export const runDuePersonaChecks = async (
  dependencies: SchedulerDependencies,
  at: Date,
  inFlight: Set<string>,
): Promise<PersonaRunSummary> => {
  const log = dependencies.log ?? ((line: string) => console.log(line));
  const ihiSystem = dependencies.config.ihiSystem;
  const [pairs, sources] = await Promise.all([
    listCoverageTargets(dependencies.sql, scheduledEventStatuses),
    listPersonaSourceTargets(dependencies.sql, scheduledEventStatuses),
  ]);

  const duePairs: CoverageTargetRow[] = [];
  const coverageSkipped: string[] = [];
  for (const target of pairs) {
    const key = pairKey(target);
    const runnable =
      !inFlight.has(key) &&
      checkDue({
        key,
        eventStatus: target.eventStatus,
        lastCheckedAt: target.lastCheckedAt,
        now: at,
      });
    if (runnable) {
      inFlight.add(key);
      duePairs.push(target);
    } else {
      coverageSkipped.push(key);
    }
  }

  const dueSources: SourceTargetRow[] = [];
  const sourcesSkipped: string[] = [];
  for (const target of sources) {
    const key = sourceKey(target);
    const runnable =
      !inFlight.has(key) &&
      checkDue({
        key,
        eventStatus: target.eventStatus,
        lastCheckedAt: target.lastCheckedAt,
        now: at,
      });
    if (runnable) {
      inFlight.add(key);
      dueSources.push(target);
    } else {
      sourcesSkipped.push(target.personaId);
    }
  }

  const coverage: string[] = [];
  for (const target of duePairs) {
    try {
      const evaluation = await coverageOf(dependencies, target, ihiSystem);
      await insertPersonaCoverage(dependencies.sql, {
        personaId: target.personaId,
        enrolmentId: target.enrolmentId,
        checkedAt: at,
        outcome: evaluation.outcome,
        detail: evaluation.detail,
      });
      coverage.push(pairKey(target));
      log(
        `Coverage of ${target.ihi} at ${target.systemName} in ` +
          `${target.eventSlug}: ${evaluation.outcome} - ${evaluation.detail}`,
      );
    } catch (cause) {
      log(
        `Could not check coverage of ${target.ihi} at ${target.systemName}: ` +
          (cause instanceof Error ? cause.message : String(cause)),
      );
    } finally {
      inFlight.delete(pairKey(target));
    }
  }

  const verified: string[] = [];
  for (const target of dueSources) {
    try {
      const presence = await presenceOf(dependencies, target, ihiSystem);
      await updatePersonaSourceStatus(dependencies.sql, {
        personaId: target.personaId,
        sourceStatus: presence.status,
        checkedAt: at,
      });
      verified.push(target.personaId);
      if (presence.status === "missing") {
        // Flagged to admins, and said out loud in the log as well: a persona set
        // the source no longer supports is the operator's problem too.
        log(
          `Persona ${target.ihi} in ${target.eventSlug} is missing at source: ` +
            presence.detail,
        );
      }
    } catch (cause) {
      log(
        `Could not verify persona ${target.ihi} against its source: ` +
          (cause instanceof Error ? cause.message : String(cause)),
      );
    } finally {
      inFlight.delete(sourceKey(target));
    }
  }

  return { coverage, coverageSkipped, sources: verified, sourcesSkipped };
};
