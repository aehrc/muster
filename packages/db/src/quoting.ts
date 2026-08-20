/*
 * Copyright © 2026 Commonwealth Scientific and Industrial Research Organisation
 * (CSIRO) ABN 41 687 119 230. Licensed under the Apache License, Version 2.0.
 */

/**
 * PostgreSQL quoting primitives.
 *
 * Statements that name roles, schemas or tables cannot use bind parameters, so
 * those fragments are quoted here rather than concatenated at the call site.
 *
 * @author John Grimes
 */

/**
 * Quotes an SQL identifier (role, schema, table or column name).
 *
 * Always quotes, so case is preserved and reserved words are safe. Equivalent
 * to PostgreSQL's `quote_ident` without the round trip.
 *
 * @param identifier - the identifier to quote
 * @returns the identifier in double-quoted form, embedded quotes doubled
 * @throws {Error} when the identifier is empty or contains a NUL character
 * @example
 * ```ts
 * `grant usage on schema ${quoteIdentifier(schema)} to ${quoteIdentifier(role)}`;
 * ```
 */
export const quoteIdentifier = (identifier: string): string => {
  if (identifier.length === 0) {
    throw new Error("An SQL identifier cannot be empty");
  }
  if (identifier.includes("\u0000")) {
    throw new Error("An SQL identifier cannot contain a NUL character");
  }
  return `"${identifier.replaceAll('"', '""')}"`;
};

/**
 * Quotes an SQL string literal.
 *
 * Doubling the single quote is the complete escape while
 * `standard_conforming_strings` is on, which has been the default since
 * PostgreSQL 9.1; backslashes are therefore literal and are left alone.
 *
 * @param value - the value to quote
 * @returns the value in single-quoted form, embedded quotes doubled
 * @throws {Error} when the value contains a NUL character
 */
export const quoteLiteral = (value: string): string => {
  if (value.includes("\u0000")) {
    throw new Error("An SQL literal cannot contain a NUL character");
  }
  return `'${value.replaceAll("'", "''")}'`;
};
