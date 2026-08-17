import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appliedMigrationNames, runMigrations } from "./migrations.ts";
import { quoteIdentifier } from "./quoting.ts";
import {
  createScratchSchema,
  describeDatabase,
  dropScratchSchema,
} from "./test/harness.ts";

describeDatabase(
  "migration runner against PostgreSQL",
  ({ sql, uniqueName }) => {
    // Arranges an isolated schema and migration directory for one test.
    const arrange = async (files: Record<string, string>) => {
      const schema = uniqueName("mig");
      const directory = await mkdtemp(join(tmpdir(), "muster-migrations-"));
      for (const [name, body] of Object.entries(files)) {
        await writeFile(join(directory, name), body);
      }
      await createScratchSchema(sql(), schema);
      return {
        schema,
        directory,
        // Removes the schema and the temporary directory.
        cleanup: async () => {
          await dropScratchSchema(sql(), schema);
          await rm(directory, { recursive: true, force: true });
        },
      };
    };

    const tableExists = async (
      schema: string,
      table: string,
    ): Promise<boolean> => {
      const rows = await sql()`select 1
                             from information_schema.tables
                             where table_schema = ${schema}
                               and table_name = ${table}`;
      return rows.length === 1;
    };

    // The happy path: every file applies, in order, and each is recorded.
    test("applies pending migrations and records them in the ledger", async () => {
      const { schema, directory, cleanup } = await arrange({
        "0000_account.sql": "create table account (id uuid primary key);",
        "0001_organisation.sql":
          "create table organisation (id uuid primary key, name text not null);",
      });

      try {
        const result = await runMigrations({ sql: sql(), directory, schema });

        expect(result.applied).toEqual([
          "0000_account.sql",
          "0001_organisation.sql",
        ]);
        expect(result.alreadyApplied).toEqual([]);
        expect(await appliedMigrationNames(sql(), schema)).toEqual([
          "0000_account.sql",
          "0001_organisation.sql",
        ]);
        // The migration acted on the target schema, not on public.
        expect(await tableExists(schema, "account")).toBe(true);
        expect(await tableExists("public", "account")).toBe(false);
      } finally {
        await cleanup();
      }
    });

    // Restarts re-run the runner; it must be a no-op the second time.
    test("applies nothing on a second run", async () => {
      const { schema, directory, cleanup } = await arrange({
        "0000_account.sql": "create table account (id uuid primary key);",
      });

      try {
        await runMigrations({ sql: sql(), directory, schema });
        const second = await runMigrations({ sql: sql(), directory, schema });

        expect(second.applied).toEqual([]);
        expect(second.alreadyApplied).toEqual(["0000_account.sql"]);
      } finally {
        await cleanup();
      }
    });

    // Multi-statement files are what Drizzle Kit produces, including its
    // `--> statement-breakpoint` comments.
    test("applies a file containing several statements", async () => {
      const { schema, directory, cleanup } = await arrange({
        "0000_two.sql": [
          "create table account (id uuid primary key);",
          "--> statement-breakpoint",
          "create table session (id uuid primary key, account_id uuid not null references account(id));",
        ].join("\n"),
      });

      try {
        await runMigrations({ sql: sql(), directory, schema });

        expect(await tableExists(schema, "account")).toBe(true);
        expect(await tableExists(schema, "session")).toBe(true);
      } finally {
        await cleanup();
      }
    });

    // A half-applied migration is the failure mode worth engineering against:
    // the file and its ledger row share one transaction.
    test("rolls a failing migration back whole and leaves it out of the ledger", async () => {
      const { schema, directory, cleanup } = await arrange({
        "0000_account.sql": "create table account (id uuid primary key);",
        "0001_broken.sql":
          "create table good (id uuid primary key); create table bad (this is not sql);",
      });

      try {
        await expect(
          runMigrations({ sql: sql(), directory, schema }),
        ).rejects.toThrow(/0001_broken\.sql/);

        // The first migration stands, the failing one left nothing behind.
        expect(await appliedMigrationNames(sql(), schema)).toEqual([
          "0000_account.sql",
        ]);
        expect(await tableExists(schema, "account")).toBe(true);
        expect(await tableExists(schema, "good")).toBe(false);
      } finally {
        await cleanup();
      }
    });

    // A fixed migration applies on the next run without manual ledger surgery.
    test("applies a repaired migration on the next run", async () => {
      const { schema, directory, cleanup } = await arrange({
        "0000_account.sql": "create table account (id uuid primary key);",
        "0001_broken.sql": "create table bad (this is not sql);",
      });

      try {
        await expect(
          runMigrations({ sql: sql(), directory, schema }),
        ).rejects.toThrow();
        await writeFile(
          join(directory, "0001_broken.sql"),
          "create table repaired (id uuid primary key);",
        );

        const result = await runMigrations({ sql: sql(), directory, schema });

        expect(result.applied).toEqual(["0001_broken.sql"]);
        expect(await tableExists(schema, "repaired")).toBe(true);
      } finally {
        await cleanup();
      }
    });

    // The ledger is created on demand, in the target schema.
    test("creates the ledger in the target schema", async () => {
      const { schema, directory, cleanup } = await arrange({});

      try {
        const result = await runMigrations({ sql: sql(), directory, schema });

        expect(result.applied).toEqual([]);
        const rows = await sql().unsafe(
          `select count(*)::int as total from ${quoteIdentifier(schema)}.muster_migration`,
        );
        expect(rows[0]?.total).toBe(0);
      } finally {
        await cleanup();
      }
    });
  },
);
