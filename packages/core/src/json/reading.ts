/*
 * Copyright © 2026 Commonwealth Scientific and Industrial Research Organisation
 * (CSIRO) ABN 41 687 119 230. Licensed under the Apache License, Version 2.0.
 */

/**
 * Reading values out of documents somebody else wrote.
 *
 * Every module in this package that reads a fetched document - a SMART
 * configuration, a capability statement, a FHIR patient, a searchset - has to
 * answer the same three questions about an unknown value: is it an object, is it
 * text worth having, and is it a list of text. They are answered here once, so
 * two modules cannot disagree about whether a blank string counts as a value.
 *
 * Deny by default in miniature: each of these returns an absence rather than a
 * coerced value, so a caller has to decide what to do about a missing field
 * instead of being handed an empty string that looks like an answer.
 *
 * Nothing here is exported from the package. It is how the reading modules are
 * written, not part of what they offer.
 *
 * @author John Grimes
 */

/**
 * Narrows a value to a JSON object.
 *
 * @param value - the value to narrow
 * @returns the object, or undefined when the value is not one
 * @example
 * ```ts
 * const body = asObject(document);
 * ```
 */
export const asObject = (
  value: unknown,
): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/**
 * Reads a value that must be a non-blank string.
 *
 * @param value - the value to read
 * @returns the string, or null when it is absent or blank
 * @example
 * ```ts
 * const issuer = asText(body["issuer"]);
 * ```
 */
export const asText = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value : null;

/**
 * Reads the string entries of a list.
 *
 * A list with a stray number in it is read for the entries that are strings:
 * discarding a whole usable document over one bad entry would tell the reader
 * less, not more.
 *
 * @param value - the value to read
 * @returns its string entries, or an empty list when it is not a list
 * @example
 * ```ts
 * const scopes = asTextList(body["scopes_supported"]);
 * ```
 */
export const asTextList = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
