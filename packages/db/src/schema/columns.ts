/**
 * Column conventions shared across the schema.
 *
 * These are factories rather than shared builder instances: a Drizzle column builder
 * carries the name it was constructed with, so handing the same object to two tables
 * invites the sort of aliasing bug that only shows up in generated DDL. Calling a
 * factory per table keeps each column its own value.
 *
 * Naming the conventions in one place also means a table cannot quietly acquire a
 * timestamp without a time zone, which for a token expiry would be a correctness bug
 * rather than a style one.
 *
 * Author: John Grimes
 */

import { timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * A moment in time.
 *
 * Always with a time zone. Expiry decisions - a verification link, a session, a software
 * statement - are comparisons against this value, and a column without a zone compares
 * whatever the writer's offset happened to be against whatever the reader's is.
 *
 * @param name - The column name.
 * @returns The column builder, for the caller to make `notNull` or leave nullable.
 */
export function instant(name: string) {
  return timestamp(name, { withTimezone: true });
}

/** The generated primary key every table carries. */
export function primaryId() {
  return { id: uuid("id").primaryKey().defaultRandom() };
}

/** `created_at`, stamped by the database on insert. */
export function createdAt() {
  return {
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  };
}

/**
 * `created_at` and `updated_at`, for rows a participant edits over time.
 *
 * `updated_at` is never maintained by a trigger. The repositories set it, so that the
 * value is the one the request decided rather than whatever the database's clock said
 * when the statement happened to run.
 */
export function timestamps() {
  return {
    ...createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  };
}
