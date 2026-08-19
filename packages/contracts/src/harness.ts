import { z } from "zod";

import { harnessCheckOutcomeSchema, harnessVerdictSchema } from "./common.ts";
import { enrolledSystemSchema, eventDetailSchema } from "./directory.ts";

/**
 * The conformance harness's wire shapes: what each check asked, what the server
 * answered, and the verdict of the run.
 *
 * A run is evidence, so every check carries the request that was made and the
 * response that came back (FR-030). The report is public, which is the point -
 * a shareable report that needs a sign-in is not evidence (SC-005) - and that is
 * why the evidence is redacted before it is recorded: a statement with its
 * signature removed says everything a reader needs and registers nothing, and a
 * client secret or a registration access token appears as `[redacted]` rather
 * than being written down (the constitution).
 *
 * The verdict is the badge. Only `passed` earns one, and the latest run is the
 * one that counts, so a server that regresses loses the badge on its next run
 * rather than keeping the last good one.
 *
 * @author John Grimes
 */

/**
 * The checks the registration profile's normative summary names (FR-029).
 *
 * Named rather than numbered, because the report names them and a vendor reading
 * it is looking for the behaviour rather than for check four.
 */
export const harnessCheckNameSchema = z.enum([
  "validStatement",
  "tamperedSignature",
  "expiredStatement",
  "replayedStatement",
  "metadataFidelity",
  "statementOnly",
]);

/** One of the profile's conformance checks. */
export type HarnessCheckName = z.infer<typeof harnessCheckNameSchema>;

/**
 * One request the harness made, as the report shows it.
 *
 * The body is the object that was posted with the software statement redacted to
 * its header and claims: a reader can decode what was vouched for, and nobody
 * can register anything with what is on the page.
 */
export const harnessRequestEvidenceSchema = z.object({
  method: z.string(),
  url: z.string(),
  body: z.record(z.string(), z.unknown()),
});

/** One request the harness made. */
export type HarnessRequestEvidence = z.infer<
  typeof harnessRequestEvidenceSchema
>;

/**
 * What the server answered.
 *
 * `body` is the parsed JSON object with credentials redacted; `text` carries what
 * came back when it was not a JSON object, or was too long to keep, so a server
 * answering with an HTML error page is still evidence rather than a blank.
 */
export const harnessResponseEvidenceSchema = z.object({
  status: z.number().int(),
  body: z.record(z.string(), z.unknown()).nullable(),
  text: z.string().nullable(),
});

/** What the server answered. */
export type HarnessResponseEvidence = z.infer<
  typeof harnessResponseEvidenceSchema
>;

/**
 * One check of one run: what was asked, what came back, and the judgement.
 *
 * `advisory` is where the profile says SHOULD rather than MUST - the RFC 7591
 * error vocabulary - and it does not fail the run.
 */
export const harnessCheckSchema = z.object({
  name: harnessCheckNameSchema,
  title: z.string(),
  outcome: harnessCheckOutcomeSchema,
  detail: z.string(),
  request: harnessRequestEvidenceSchema,
  response: harnessResponseEvidenceSchema,
});

/** One check of one run. */
export type HarnessCheck = z.infer<typeof harnessCheckSchema>;

/**
 * One recorded run.
 *
 * `cleanup` says what became of the throwaway clients the run registered: what
 * was deleted, and what was left behind for its owner to remove by hand
 * (acceptance scenario 4).
 */
export const harnessRunSchema = z.object({
  id: z.string(),
  enrolmentId: z.string(),
  ranAt: z.string(),
  verdict: harnessVerdictSchema,
  checks: z.array(harnessCheckSchema),
  cleanup: z.string(),
});

/** One recorded run. */
export type HarnessRun = z.infer<typeof harnessRunSchema>;

/** `GET /api/enrolments/{id}/harness-runs`: an entry's runs, newest first. */
export const harnessRunsResponseSchema = z.object({
  event: eventDetailSchema,
  system: enrolledSystemSchema,
  /** whether this caller may add a run, so the console can say why not */
  mayRun: z.boolean(),
  runs: z.array(harnessRunSchema),
});

/** An entry's conformance runs. */
export type HarnessRunsResponse = z.infer<typeof harnessRunsResponseSchema>;

/**
 * `GET /api/harness-runs/{id}`, and the answer to a run: one report.
 *
 * The entry and the event travel with the run because a report is shared with
 * people who were not looking at the console when it was made, and a verdict
 * with nothing to say what it was a verdict about is not a report.
 */
export const harnessRunResponseSchema = z.object({
  event: eventDetailSchema,
  system: enrolledSystemSchema,
  run: harnessRunSchema,
});

/** One report. */
export type HarnessRunResponse = z.infer<typeof harnessRunResponseSchema>;
