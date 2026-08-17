import { expect, test } from "bun:test";

import { quoteIdentifier } from "./quoting.ts";
import { bootstrapServerRole } from "./roles.ts";
import {
  createScratchSchema,
  describeDatabase,
  dropScratchSchema,
} from "./test/harness.ts";

describeDatabase(
  "two-role bootstrap against PostgreSQL",
  ({ sql, uniqueName }) => {
    const currentDatabase = async (): Promise<string> => {
      const rows = await sql()`select current_database() as name`;
      return rows[0]?.name as string;
    };

    // Arranges an isolated schema and an unused role name for one test.
    const arrange = async () => {
      const schema = uniqueName("roles");
      const role = uniqueName("srv");
      await createScratchSchema(sql(), schema);
      return {
        schema,
        role,
        // Drops the role's grants, the role itself and the schema.
        cleanup: async () => {
          const quotedRole = quoteIdentifier(role);
          const database = quoteIdentifier(await currentDatabase());
          await sql().unsafe(
            `revoke all on database ${database} from ${quotedRole}`,
          );
          await sql().unsafe(`drop owned by ${quotedRole} cascade`);
          await sql().unsafe(`drop role ${quotedRole}`);
          await dropScratchSchema(sql(), schema);
        },
      };
    };

    const schemaPrivilege = async (
      role: string,
      schema: string,
      privilege: string,
    ): Promise<boolean> => {
      const rows =
        await sql()`select has_schema_privilege(${role}, ${schema}, ${privilege}) as granted`;
      return rows[0]?.granted as boolean;
    };

    const tablePrivilege = async (
      role: string,
      table: string,
      privilege: string,
    ): Promise<boolean> => {
      const rows =
        await sql()`select has_table_privilege(${role}, ${table}, ${privilege}) as granted`;
      return rows[0]?.granted as boolean;
    };

    test("creates a login role that may connect to the database", async () => {
      const { schema, role, cleanup } = await arrange();

      try {
        await bootstrapServerRole(sql(), { role, schema, password: "s3cret" });

        const roles =
          await sql()`select rolcanlogin from pg_roles where rolname = ${role}`;
        expect(roles).toHaveLength(1);
        expect(roles[0]?.rolcanlogin).toBe(true);

        const database = await currentDatabase();
        const connect =
          await sql()`select has_database_privilege(${role}, ${database}, 'CONNECT') as granted`;
        expect(connect[0]?.granted).toBe(true);
      } finally {
        await cleanup();
      }
    });

    // The point of the split: the serving role reads and writes data and cannot
    // create, drop or truncate anything.
    test("grants data rights on existing tables but no schema CREATE", async () => {
      const { schema, role, cleanup } = await arrange();
      await sql().unsafe(
        `create table ${quoteIdentifier(schema)}.account (id uuid primary key)`,
      );

      try {
        await bootstrapServerRole(sql(), { role, schema });

        const table = `${quoteIdentifier(schema)}.account`;
        expect(await tablePrivilege(role, table, "SELECT")).toBe(true);
        expect(await tablePrivilege(role, table, "INSERT")).toBe(true);
        expect(await tablePrivilege(role, table, "UPDATE")).toBe(true);
        expect(await tablePrivilege(role, table, "DELETE")).toBe(true);
        expect(await schemaPrivilege(role, schema, "USAGE")).toBe(true);
        expect(await schemaPrivilege(role, schema, "CREATE")).toBe(false);
        expect(await tablePrivilege(role, table, "TRUNCATE")).toBe(false);
      } finally {
        await cleanup();
      }
    });

    // Later migrations create tables after bootstrap has run, so the grant has
    // to be a default privilege rather than a one-off sweep.
    test("grants data rights on tables the owner creates after bootstrap", async () => {
      const { schema, role, cleanup } = await arrange();

      try {
        await bootstrapServerRole(sql(), { role, schema });
        await sql().unsafe(
          `create table ${quoteIdentifier(schema)}.later (id uuid primary key)`,
        );

        const table = `${quoteIdentifier(schema)}.later`;
        expect(await tablePrivilege(role, table, "SELECT")).toBe(true);
        expect(await tablePrivilege(role, table, "INSERT")).toBe(true);
        expect(await tablePrivilege(role, table, "TRUNCATE")).toBe(false);
      } finally {
        await cleanup();
      }
    });

    // Sequences back generated columns; without USAGE the serving role could not
    // insert into a table that uses one.
    test("grants usage on sequences the owner creates after bootstrap", async () => {
      const { schema, role, cleanup } = await arrange();

      try {
        await bootstrapServerRole(sql(), { role, schema });
        await sql().unsafe(
          `create sequence ${quoteIdentifier(schema)}.counter`,
        );

        const sequence = `${schema}.counter`;
        const rows =
          await sql()`select has_sequence_privilege(${role}, ${sequence}, 'USAGE') as granted`;
        expect(rows[0]?.granted).toBe(true);
      } finally {
        await cleanup();
      }
    });

    // Ownership stays with the migrating role, whatever the serving role does.
    test("leaves table ownership with the owning role", async () => {
      const { schema, role, cleanup } = await arrange();

      try {
        await bootstrapServerRole(sql(), { role, schema });
        await sql().unsafe(
          `create table ${quoteIdentifier(schema)}.owned (id uuid primary key)`,
        );

        const rows = await sql()`select tableowner
                               from pg_tables
                               where schemaname = ${schema} and tablename = 'owned'`;
        expect(rows[0]?.tableowner).not.toBe(role);
      } finally {
        await cleanup();
      }
    });

    // Bootstrap runs on every deployment, so repeating it must be harmless -
    // including when the password has changed.
    test("is idempotent across repeated runs", async () => {
      const { schema, role, cleanup } = await arrange();

      try {
        await bootstrapServerRole(sql(), { role, schema, password: "first" });
        await bootstrapServerRole(sql(), { role, schema, password: "second" });

        const roles =
          await sql()`select rolname from pg_roles where rolname = ${role}`;
        expect(roles).toHaveLength(1);
        expect(await schemaPrivilege(role, schema, "USAGE")).toBe(true);
      } finally {
        await cleanup();
      }
    });

    // A password carrying a quote must not break out of its literal.
    test("accepts a password containing quotes and backslashes", async () => {
      const { schema, role, cleanup } = await arrange();

      try {
        await bootstrapServerRole(sql(), {
          role,
          schema,
          password: 'it\'s \\ "fine"',
        });

        const roles =
          await sql()`select rolname from pg_roles where rolname = ${role}`;
        expect(roles).toHaveLength(1);
      } finally {
        await cleanup();
      }
    });
  },
);
