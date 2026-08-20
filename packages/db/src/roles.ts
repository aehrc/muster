/*
 * Copyright © 2026 Commonwealth Scientific and Industrial Research Organisation
 * (CSIRO) ABN 41 687 119 230. Licensed under the Apache License, Version 2.0.
 */

import { quoteIdentifier, quoteLiteral } from "./quoting.ts";

import type { SQL } from "bun";

/**
 * Two-role bootstrap.
 *
 * Muster runs with two database roles: the owning role that created the schema
 * and applies migrations, and a non-owning serving role used by the running
 * server. The serving role gets data rights and nothing else - no schema
 * CREATE, no TRUNCATE, no ownership - so an application-level defect cannot
 * drop or alter a table.
 *
 * @author John Grimes
 */

/** Options for {@link bootstrapServerRole}. */
export type ServerRoleOptions = {
  /** the serving role to create or refresh */
  readonly role: string;
  /** password to set; omit when the deployment authenticates another way */
  readonly password?: string;
  /** schema the role is granted data rights on; defaults to `public` */
  readonly schema?: string;
};

/**
 * Creates or refreshes the non-owning serving role.
 *
 * Idempotent: safe to run on every deployment. Must be run by the owning role,
 * because the default privileges it sets apply to the objects that role goes on
 * to create - which is how tables added by later migrations become readable by
 * the serving role without a second bootstrap.
 *
 * @param sql - an open connection held by the owning role
 * @param options - the role to bootstrap, its password and target schema
 * @throws {Error} when the role or schema name is empty
 * @example
 * ```ts
 * await bootstrapServerRole(sql, { role: "muster_server", password: secret });
 * ```
 */
export const bootstrapServerRole = async (
  sql: SQL,
  options: ServerRoleOptions,
): Promise<void> => {
  const schema = options.schema ?? "public";
  if (options.role.length === 0) {
    throw new Error("The serving role name cannot be empty");
  }
  if (schema.length === 0) {
    throw new Error("The schema name cannot be empty");
  }

  const role = quoteIdentifier(options.role);
  const target = quoteIdentifier(schema);

  await sql.unsafe(`do $$
    begin
      if not exists (select 1 from pg_roles where rolname = ${quoteLiteral(options.role)}) then
        create role ${role} login;
      end if;
    end
  $$`);

  if (options.password !== undefined) {
    await sql.unsafe(
      `alter role ${role} with password ${quoteLiteral(options.password)}`,
    );
  }

  const rows = await sql<{ name: string }[]>`select current_database() as name`;
  const database = quoteIdentifier(rows[0]?.name ?? "");

  await sql.unsafe(`grant connect on database ${database} to ${role}`);

  // Usage without CREATE is the whole point: the serving role can reach the
  // objects in the schema and cannot add or replace any.
  await sql.unsafe(`grant usage on schema ${target} to ${role}`);
  await sql.unsafe(`revoke create on schema ${target} from ${role}`);

  await sql.unsafe(
    `grant select, insert, update, delete on all tables in schema ${target} to ${role}`,
  );
  await sql.unsafe(
    `grant usage, select on all sequences in schema ${target} to ${role}`,
  );

  // Tables and sequences created by later migrations are covered without
  // re-running the sweep above.
  await sql.unsafe(
    `alter default privileges in schema ${target} grant select, insert, update, delete on tables to ${role}`,
  );
  await sql.unsafe(
    `alter default privileges in schema ${target} grant usage, select on sequences to ${role}`,
  );
};
