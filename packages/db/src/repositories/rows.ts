/*
 * Copyright © 2026 Commonwealth Scientific and Industrial Research Organisation
 * (CSIRO) ABN 41 687 119 230. Licensed under the Apache License, Version 2.0.
 */

/**
 * Reading rows back out of the driver, and writing values into it.
 *
 * The driver hands results back as `any` and renders a JavaScript array in a way
 * Postgres will not read as an array literal, so both boundaries are crossed in
 * one place: every repository narrows its rows here and renders its parameters
 * here, rather than each one deciding for itself how a jsonb column or a text
 * array is spelled.
 *
 * Nothing in here is exported from the package. It is how the repositories are
 * written, not part of what they offer.
 *
 * @author John Grimes
 */

/** How a row arrives from the driver, before it is mapped. */
export type RawRow = Record<string, unknown>;

/**
 * Runs a query and types its rows.
 *
 * The driver hands results back as `any`, which would otherwise spread through
 * every repository function. This is the one place that boundary is crossed: the
 * result is narrowed to an array of raw rows here, and each repository's mappers
 * turn those into Muster's own types.
 *
 * @param result - the query the caller built with the driver's template tag
 * @returns the rows, or an empty array for a statement that returns none
 * @example
 * ```ts
 * const rows = await queryRows(sql`select * from account where id = ${id}`);
 * ```
 */
export const queryRows = async (result: unknown): Promise<RawRow[]> => {
  const rows: unknown = await result;
  // The driver's own contract: a query resolves to an array of row objects.
  return Array.isArray(rows) ? (rows as RawRow[]) : [];
};

/**
 * Renders a text array as a Postgres array literal.
 *
 * The driver renders a JavaScript array as `a,b`, which Postgres refuses as an
 * array literal, so the literal is built here and passed as one text parameter
 * with a cast. Quoting each element keeps commas, braces and spaces inside the
 * values they belong to.
 *
 * @param values - the strings to render
 * @returns the array literal, for example `{"form filler"}`
 * @example
 * ```ts
 * sql`select * from event where capability_tags @> ${arrayLiteral(tags)}::text[]`;
 * ```
 */
export const arrayLiteral = (values: readonly string[]): string =>
  `{${values
    .map(
      (value) =>
        `"${value.replaceAll("\\", String.raw`\\`).replaceAll('"', String.raw`\"`)}"`,
    )
    .join(",")}}`;

/**
 * Renders a value for a jsonb parameter.
 *
 * @param value - the value to store, or null
 * @returns the JSON text, or null
 * @example
 * ```ts
 * sql`update system set server_profile = ${jsonParameter(profile)}::jsonb`;
 * ```
 */
export const jsonParameter = (value: unknown): string | null =>
  value === null || value === undefined ? null : JSON.stringify(value);

/**
 * Reads a nullable text column.
 *
 * @param value - the column value
 * @returns the text, or null when the column is null
 * @example
 * ```ts
 * asOptionalText(row["decline_reason"]);
 * ```
 */
export const asOptionalText = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

/**
 * Reads a column that the driver may hand over as text or as a date.
 *
 * @param value - the column value
 * @returns the day as `YYYY-MM-DD`
 * @example
 * ```ts
 * asDay(row["starts_on"]);
 * ```
 */
export const asDay = (value: unknown): string =>
  value instanceof Date ? value.toISOString().slice(0, 10) : String(value);

/**
 * Reads a JSON column, which the driver hands over as text.
 *
 * @param value - the column value
 * @returns the parsed value, or null
 * @example
 * ```ts
 * asJson(row["registration_fields"]);
 * ```
 */
export const asJson = (value: unknown): unknown =>
  typeof value === "string" ? JSON.parse(value) : (value ?? null);

/**
 * Reads a text array column.
 *
 * @param value - the column value
 * @returns the strings
 * @example
 * ```ts
 * asStrings(row["capability_tags"]);
 * ```
 */
export const asStrings = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.map(String) : [];
