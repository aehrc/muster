/*
 * Copyright © 2026 Commonwealth Scientific and Industrial Research Organisation
 * (CSIRO) ABN 41 687 119 230. Licensed under the Apache License, Version 2.0.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { quoteIdentifier, quoteLiteral } from "./quoting.ts";

import type { SQL } from "bun";

/**
 * Migration runner.
 *
 * Migrations are plain `.sql` files applied in filename order - the shape
 * `drizzle-kit generate` writes into `packages/db/migrations`. Each file is
 * applied in its own transaction together with its ledger row, so a failure
 * leaves the database on the last complete migration and the repaired file
 * applies on the next run.
 *
 * The runner is used with the owning role only; the serving role has no DDL
 * rights (see `roles.ts`).
 *
 * @author John Grimes
 */

/** The unqualified name of the table recording applied migrations. */
export const migrationLedgerTable = "muster_migration";

/** A migration read from disk. */
export type Migration = {
  /** the file name, which is also the ledger key */
  readonly name: string;
  /** the file contents, applied verbatim */
  readonly sql: string;
};

/** What a run did. */
export type MigrationRunResult = {
  /** migrations applied by this run, in the order applied */
  readonly applied: readonly string[];
  /** migrations already recorded in the ledger before this run */
  readonly alreadyApplied: readonly string[];
};

/** Options for {@link runMigrations}. */
export type RunMigrationsOptions = {
  /** an open connection held by the owning role */
  readonly sql: SQL;
  /** directory holding the `.sql` files */
  readonly directory: string;
  /** schema the ledger and the migrations act on; defaults to `public` */
  readonly schema?: string;
};

/**
 * Reads the migrations held in a directory.
 *
 * @param directory - directory holding `.sql` migration files
 * @returns the migrations, ordered by file name ascending
 * @throws {Error} when the directory cannot be read
 */
export const readMigrations = async (
  directory: string,
): Promise<Migration[]> => {
  const entries = await readdir(directory);
  const names = entries.filter((name) => name.endsWith(".sql")).sort();
  return Promise.all(
    names.map(async (name) => ({
      name,
      sql: await readFile(join(directory, name), "utf8"),
    })),
  );
};

/**
 * Selects the migrations that have not yet been applied.
 *
 * @param available - migrations found on disk, in order
 * @param applied - names already recorded in the ledger
 * @returns the migrations still to apply, in on-disk order
 */
export const pendingMigrations = (
  available: readonly Migration[],
  applied: readonly string[],
): Migration[] => {
  const done = new Set(applied);
  return available.filter((migration) => !done.has(migration.name));
};

/**
 * Creates the migration ledger if it is absent.
 *
 * @param sql - an open connection held by the owning role
 * @param schema - schema to hold the ledger
 */
export const ensureMigrationLedger = async (
  sql: SQL,
  schema: string,
): Promise<void> => {
  await sql.unsafe(`create table if not exists ${ledgerFor(schema)} (
    name text primary key,
    applied_at timestamptz not null default now()
  )`);
};

/**
 * Reads the names recorded in the migration ledger.
 *
 * @param sql - an open connection
 * @param schema - schema holding the ledger
 * @returns the applied migration names, ordered ascending
 */
export const appliedMigrationNames = async (
  sql: SQL,
  schema: string,
): Promise<string[]> => {
  const rows = await sql.unsafe<{ name: string }[]>(
    `select name from ${ledgerFor(schema)} order by name`,
  );
  return rows.map((row) => row.name);
};

/**
 * Applies every migration not yet recorded in the ledger.
 *
 * @param options - connection, migration directory and target schema
 * @returns which migrations were applied and which were already present
 * @throws {Error} naming the migration that failed; that migration is rolled back
 *   whole, including its ledger row
 * @example
 * ```ts
 * const result = await runMigrations({ sql, directory: "packages/db/migrations" });
 * console.log(`applied ${result.applied.length} migration(s)`);
 * ```
 */
export const runMigrations = async (
  options: RunMigrationsOptions,
): Promise<MigrationRunResult> => {
  const { sql, directory } = options;
  const schema = options.schema ?? "public";
  const ledger = ledgerFor(schema);

  const available = await readMigrations(directory);
  await ensureMigrationLedger(sql, schema);
  const alreadyApplied = await appliedMigrationNames(sql, schema);
  const pending = pendingMigrations(available, alreadyApplied);

  const applied: string[] = [];
  for (const migration of pending) {
    try {
      await sql.begin(async (transaction) => {
        // Pinning the search path keeps an unqualified `create table` inside
        // the target schema, which is what makes the suites hermetic and lets a
        // deployment hold Muster in a schema of its own.
        await transaction.unsafe(
          `set local search_path to ${quoteIdentifier(schema)}, public`,
        );
        await transaction.unsafe(migration.sql);
        await transaction.unsafe(
          `insert into ${ledger} (name) values (${quoteLiteral(migration.name)})`,
        );
      });
    } catch (cause) {
      throw new Error(
        `Migration ${migration.name} failed and was rolled back`,
        { cause },
      );
    }
    applied.push(migration.name);
  }

  return { applied, alreadyApplied };
};

/**
 * Names the ledger table, qualified by its schema.
 *
 * @param schema - schema holding the ledger
 * @returns the quoted, qualified table name
 */
const ledgerFor = (schema: string): string =>
  `${quoteIdentifier(schema)}.${quoteIdentifier(migrationLedgerTable)}`;
