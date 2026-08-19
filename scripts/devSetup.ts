#!/usr/bin/env bun
import { SQL } from "bun";

import { quoteIdentifier, quoteLiteral } from "@muster/db";

/**
 * Bootstraps the native dev database: idempotent, safe to run on every checkout.
 *
 * Creates the single role and database the README's "from source" section
 * already documents - `muster`/`muster`, used for both `MUSTER_DATABASE_URL`
 * and `MUSTER_MIGRATION_DATABASE_URL` - plus `muster_test` for the integration
 * suites. The server bootstraps its own serving role (`muster_server`) the
 * first time it starts against that database, so this script never touches it.
 *
 * Connects as whatever role owns the local Postgres instance: a Homebrew
 * install makes the OS user a superuser by default, so nothing needs to be
 * typed in for that connection. `MUSTER_DEV_ADMIN_DATABASE_URL` overrides it
 * for anyone whose local Postgres is set up differently.
 *
 * @author John Grimes
 */

/** The role and password the README's from-source flow already documents. */
const devRole = "muster";

/** Not a secret: a development-only role on a local, non-networked database. */
const devPassword = "muster";

/** Databases the native dev flow needs: the app's own, and the test suites'. */
const devDatabases = ["muster", "muster_test"];

/**
 * Creates a login role if it does not already exist, then sets its password.
 *
 * Idempotent: safe to run on every checkout. The password is set on every run
 * rather than only at creation, so a role left over from a change to this
 * script never ends up without one.
 *
 * @param sql - an admin connection able to create roles
 * @param role - the role to create or refresh
 * @param password - the password to set
 */
const createRoleIfMissing = async (
  sql: SQL,
  role: string,
  password: string,
): Promise<void> => {
  await sql.unsafe(`do $$
    begin
      if not exists (select 1 from pg_roles where rolname = ${quoteLiteral(role)}) then
        create role ${quoteIdentifier(role)} login;
      end if;
    end
  $$`);
  await sql.unsafe(
    `alter role ${quoteIdentifier(role)} with password ${quoteLiteral(password)}`,
  );
};

/**
 * Creates a database owned by the given role, if it does not already exist.
 *
 * `create database` cannot run inside a transaction or a procedural block, so
 * this checks first rather than using the `do $$ ... $$` idiom {@link createRoleIfMissing}
 * uses.
 *
 * @param sql - an admin connection able to create databases
 * @param name - the database to create
 * @param owner - the role that owns it
 */
const createDatabaseIfMissing = async (
  sql: SQL,
  name: string,
  owner: string,
): Promise<void> => {
  const rows = await sql<
    { datname: string }[]
  >`select datname from pg_database where datname = ${name}`;
  if (rows.length === 0) {
    await sql.unsafe(
      `create database ${quoteIdentifier(name)} owner ${quoteIdentifier(owner)}`,
    );
  }
};

const adminDatabaseUrl =
  process.env["MUSTER_DEV_ADMIN_DATABASE_URL"] ??
  "postgresql://localhost:5432/postgres";

const admin = new SQL(adminDatabaseUrl);
try {
  await createRoleIfMissing(admin, devRole, devPassword);
  for (const database of devDatabases) {
    await createDatabaseIfMissing(admin, database, devRole);
  }
} finally {
  await admin.end();
}

console.log(
  `Ready: role "${devRole}" and databases ${devDatabases.map((name) => `"${name}"`).join(", ")}. ` +
    "Copy .env.example to .env, then `bun run dev`.",
);
