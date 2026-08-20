/*
 * Copyright © 2026 Commonwealth Scientific and Industrial Research Organisation
 * (CSIRO) ABN 41 687 119 230. Licensed under the Apache License, Version 2.0.
 */

import type { z } from "zod";

/**
 * Turning form fields into contract-shaped requests.
 *
 * The schemas in `@muster/contracts` are the same ones the server validates
 * against, so a form that parses here is a form the server will accept, and a
 * refusal is reported against the field that caused it while the person is still
 * looking at that field. This is a convenience and never a defence: the server
 * validates every request again regardless of what the console believed.
 *
 * @author John Grimes
 */

/** What a form produced: a request, or the reasons it is not one yet. */
export type ParseOutcome<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly issues: readonly string[] };

/**
 * Reads a list out of a text area.
 *
 * Newlines, commas and spaces all separate entries, because a redirect URI list
 * or a scope list is pasted from wherever the person had it and no one should
 * have to reformat it first.
 *
 * @param text - what was typed
 * @returns the entries, trimmed, with the blanks dropped
 * @example
 * ```ts
 * splitList("launch/patient, patient/Observation.rs");
 * // ["launch/patient", "patient/Observation.rs"]
 * ```
 */
export const splitList = (text: string): string[] =>
  text
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

/**
 * Renders a list for a text area.
 *
 * @param values - the entries
 * @returns the entries, one per line
 * @example
 * ```ts
 * joinList(system.clientProfile.redirectUris);
 * ```
 */
export const joinList = (values: readonly string[]): string =>
  values.join("\n");

/**
 * Parses a request against its contract schema.
 *
 * @param schema - the contract the request must satisfy
 * @param value - the request as assembled from the form
 * @returns the parsed request, or one issue per offending field
 * @example
 * ```ts
 * const outcome = parseRequest(createOrganisationRequestSchema, { name });
 * if (!outcome.ok) {
 *   setIssues(outcome.issues);
 * }
 * ```
 */
export const parseRequest = <Schema extends z.ZodType>(
  schema: Schema,
  value: unknown,
): ParseOutcome<z.output<Schema>> => {
  const parsed = schema.safeParse(value);
  if (parsed.success) {
    return { ok: true, value: parsed.data };
  }
  return {
    ok: false,
    // A refinement over the whole object has no path; "body" is the honest name
    // for it, and it is what the server's own refusals say.
    issues: parsed.error.issues.map(
      (issue) => `${issue.path.join(".") || "body"}: ${issue.message}`,
    ),
  };
};
