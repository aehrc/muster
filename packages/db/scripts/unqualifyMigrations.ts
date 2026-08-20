#!/usr/bin/env bun
/*
 * Copyright © 2026 Commonwealth Scientific and Industrial Research Organisation
 * (CSIRO) ABN 41 687 119 230. Licensed under the Apache License, Version 2.0.
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Removes the `"public".` qualification Drizzle Kit writes into generated
 * migrations.
 *
 * Muster's migration runner pins `search_path` to the target schema, which is
 * what lets a suite migrate into a scratch schema and a deployment hold Muster
 * in a schema of its own. A migration that names `"public"."account"` ignores
 * that, so `bun run db:generate` pipes its output through here and the SQL comes
 * out schema-relative.
 *
 * Idempotent: running it on already-processed files changes nothing.
 *
 * @author John Grimes
 */

/** Where the generated migrations live, relative to this script. */
const migrationsDirectory = join(import.meta.dir, "..", "migrations");

/**
 * Strips the `"public".` qualifier from every generated migration.
 *
 * @returns the names of the files that changed
 */
const unqualifyMigrations = async (): Promise<string[]> => {
  const names = (await readdir(migrationsDirectory))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const changed: string[] = [];
  for (const name of names) {
    const path = join(migrationsDirectory, name);
    const before = await readFile(path, "utf8");
    const after = before.replaceAll('"public".', "");
    if (after !== before) {
      await writeFile(path, after);
      changed.push(name);
    }
  }
  return changed;
};

const changed = await unqualifyMigrations();
console.log(
  changed.length === 0
    ? "Migrations are already schema-relative."
    : `Made schema-relative: ${changed.join(", ")}`,
);
