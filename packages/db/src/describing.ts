/*
 * Copyright © 2026 Commonwealth Scientific and Industrial Research Organisation
 * (CSIRO) ABN 41 687 119 230. Licensed under the Apache License, Version 2.0.
 */

/**
 * Naming a database in a log line.
 *
 * A connection URL carries a user name and a password, and no credential is ever
 * written to a log, so an operator who needs to know which database is about to be
 * written to is told the host and the database and nothing else.
 *
 * The place this matters most is seeding. `bun --env-file` leaves a variable the
 * shell already exports alone, so somebody with `MUSTER_DATABASE_URL` set for
 * their own database can run the stack's seed and have it go somewhere they did
 * not intend; a seed run that says what it is seeding makes that visible instead
 * of silent.
 *
 * @author John Grimes
 */

/**
 * Describes a database connection URL without its credentials.
 *
 * @param url - the connection URL
 * @returns the database and where it is, or a statement that it could not be read
 * @example
 * ```ts
 * describeConnection("postgresql://muster:hunter2@db:5432/muster");
 * // "muster at db:5432"
 * ```
 */
export const describeConnection = (url: string): string => {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return "an unparseable database URL";
  }
  const database = target.pathname.replace(/^\/+/, "");
  const where = target.port === "" ? target.hostname : target.host;
  return `${database} at ${where}`;
};
