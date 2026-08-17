import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  pendingMigrations,
  readMigrations,
  type Migration,
} from "./migrations.ts";

describe("readMigrations", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "muster-migrations-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  // Drizzle Kit writes files named `0000_name.sql`, so plain ascending file
  // name order is the application order. Files must not be re-sorted by
  // directory-listing order, which is arbitrary.
  test("returns .sql files ordered by name ascending", async () => {
    await writeFile(join(directory, "0002_third.sql"), "select 3");
    await writeFile(join(directory, "0000_first.sql"), "select 1");
    await writeFile(join(directory, "0001_second.sql"), "select 2");

    const migrations = await readMigrations(directory);

    expect(migrations.map((migration) => migration.name)).toEqual([
      "0000_first.sql",
      "0001_second.sql",
      "0002_third.sql",
    ]);
  });

  test("carries each file's contents verbatim", async () => {
    const body =
      "create table thing (id uuid primary key);\n--> statement-breakpoint\nselect 1;\n";
    await writeFile(join(directory, "0000_first.sql"), body);

    const migrations = await readMigrations(directory);

    expect(migrations).toHaveLength(1);
    expect(migrations[0]?.sql).toBe(body);
  });

  // The journal and README that Drizzle Kit leaves alongside the SQL must not
  // be mistaken for migrations.
  test("ignores files that are not .sql", async () => {
    await writeFile(join(directory, "0000_first.sql"), "select 1");
    await writeFile(join(directory, "README.md"), "notes");
    await writeFile(join(directory, "_journal.json"), "{}");

    const migrations = await readMigrations(directory);

    expect(migrations.map((migration) => migration.name)).toEqual([
      "0000_first.sql",
    ]);
  });

  test("returns nothing for an empty directory", async () => {
    expect(await readMigrations(directory)).toEqual([]);
  });

  // A missing directory in a deployment means the image was built wrong; that
  // must fail loudly rather than silently apply nothing.
  test("refuses a directory that does not exist", async () => {
    await expect(readMigrations(join(directory, "absent"))).rejects.toThrow(
      /absent/,
    );
  });
});

describe("pendingMigrations", () => {
  const migration = (name: string): Migration => ({ name, sql: `-- ${name}` });

  test("returns every migration when the ledger is empty", () => {
    const available = [migration("0000_a.sql"), migration("0001_b.sql")];

    expect(pendingMigrations(available, [])).toEqual(available);
  });

  test("drops migrations already recorded in the ledger", () => {
    const available = [
      migration("0000_a.sql"),
      migration("0001_b.sql"),
      migration("0002_c.sql"),
    ];

    const pending = pendingMigrations(available, ["0000_a.sql", "0001_b.sql"]);

    expect(pending.map((entry) => entry.name)).toEqual(["0002_c.sql"]);
  });

  // Ledger order is not application order; the on-disk order decides.
  test("preserves the on-disk order of the remaining migrations", () => {
    const available = [
      migration("0000_a.sql"),
      migration("0001_b.sql"),
      migration("0002_c.sql"),
    ];

    const pending = pendingMigrations(available, ["0001_b.sql"]);

    expect(pending.map((entry) => entry.name)).toEqual([
      "0000_a.sql",
      "0002_c.sql",
    ]);
  });

  test("returns nothing when every migration is applied", () => {
    const available = [migration("0000_a.sql")];

    expect(pendingMigrations(available, ["0000_a.sql"])).toEqual([]);
  });

  // A ledger entry with no file is a red flag but not this function's problem;
  // it must not invent work or throw.
  test("ignores ledger entries with no corresponding file", () => {
    const available = [migration("0000_a.sql")];

    expect(
      pendingMigrations(available, ["0000_a.sql", "0009_gone.sql"]),
    ).toEqual([]);
  });
});
