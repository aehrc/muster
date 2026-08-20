/*
 * Copyright © 2026 Commonwealth Scientific and Industrial Research Organisation
 * (CSIRO) ABN 41 687 119 230. Licensed under the Apache License, Version 2.0.
 */

import { timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * The columns every table carries.
 *
 * Stated once, per the data model's own convention: an `id`, a `createdAt` and an
 * `updatedAt` on every table. Functions rather than shared values, because each
 * table needs its own column builders.
 *
 * @author John Grimes
 */

/**
 * The surrogate key every table carries.
 *
 * @returns the primary key column
 * @example
 * ```ts
 * export const pairing = pgTable("pairing", { id: surrogateKey(), ... });
 * ```
 */
export const surrogateKey = () => uuid().primaryKey().defaultRandom();

/**
 * The timestamps every table carries.
 *
 * @returns the created and updated columns
 * @example
 * ```ts
 * export const pairing = pgTable("pairing", { ...auditColumns() });
 * ```
 */
export const auditColumns = () => ({
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});
