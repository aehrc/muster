/**
 * The two identities a Muster deployment runs as.
 *
 * Migrations are applied by an identity that owns the schema. The server serves with
 * one that does not: it can read and write every table and it cannot create, alter
 * or drop anything. That split costs one extra role and removes a whole class of
 * operational mistake - a server that cannot issue DDL cannot half-migrate a
 * database, and an injected statement that reaches the database cannot drop a table.
 *
 * The serving role's access is generated here rather than written into a migration
 * because every statement names the role, and the role name is configuration: an
 * operator chooses it, or a managed database hands one out.
 * {@link servingRolePrivilegeStatements} produces the statements and the migrate
 * command applies them immediately after the migrations, inside the same advisory
 * lock.
 *
 * Author: John Grimes
 */

import { sql } from "drizzle-orm";

import type { Executor } from "./executor.js";

/**
 * Quotes an identifier the way Postgres does.
 *
 * An embedded double quote is escaped by doubling it. Emitting the name raw would
 * work for the lower-case name a developer picks and break on the mixed-case one a
 * managed database hands out, and emitting it unescaped would end the identifier
 * early and leave the remainder as SQL.
 */
function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/**
 * The statements that give a serving role exactly the access Muster needs.
 *
 * Idempotent - every statement is a grant of a fixed set - so the migrate command
 * can apply them on every run rather than working out whether they are already in
 * force.
 *
 * There is deliberately no `grant create`, and no `grant all`: a role that can
 * create a table can also migrate, and then "the migrations ran as the owner" is a
 * convention rather than a constraint.
 *
 * @param role - The serving role's name, as parsed from its connection URL.
 * @returns The statements, in the order they must be applied - schema usage first,
 *   because without it every later grant names something the role cannot reach.
 * @throws {Error} When the role name is blank, which would otherwise generate a
 *   syntactically valid statement that grants to nothing.
 * @example
 * ```ts
 * for (const statement of servingRolePrivilegeStatements("muster_app")) {
 *   await db.execute(sql.raw(statement));
 * }
 * ```
 */
export function servingRolePrivilegeStatements(
  role: string,
): readonly string[] {
  if (role.trim().length === 0) {
    throw new Error(
      "A serving role name is required in order to generate its privileges",
    );
  }

  const target = quoteIdentifier(role);

  return [
    // Schema usage first: without it every grant below names something the role
    // cannot reach.
    `grant usage on schema public to ${target}`,

    // The data the server reads and writes. What it may not do is absent rather
    // than revoked: `create`, `truncate` and `references` were never granted.
    `grant select, insert, update, delete on all tables in schema public to ${target}`,
    `grant usage, select on all sequences in schema public to ${target}`,

    // So that a table created by a later migration is granted without anybody
    // remembering to. Applies to objects created by the owning identity, which is
    // the only identity that runs migrations.
    `alter default privileges in schema public grant select, insert, update, delete on tables to ${target}`,
    `alter default privileges in schema public grant usage, select on sequences to ${target}`,
  ];
}

/**
 * Grants a serving role its access.
 *
 * Issued by the owning identity, immediately after the migrations and under the same
 * advisory lock, because the grants and the tables they name are two halves of one
 * operation.
 *
 * Not wrapped in a transaction. Each `grant` is individually atomic, the whole set
 * is idempotent, and a partial application is repaired by the next run rather than
 * needing to be rolled back - whereas holding one transaction open across a
 * `grant ... on all tables` on a busy database is a lock nobody asked for.
 *
 * @param db - A connection with authority to grant on the tables, which in practice
 *   means the identity that owns them.
 * @param role - The serving role's name, as parsed from its connection URL.
 * @throws {Error} When the role name is blank, or when a statement fails - a
 *   migration that reported success while leaving the serving role unable to reach a
 *   table would present later as an empty result.
 */
export async function applyServingRolePrivileges(
  db: Executor,
  role: string,
): Promise<void> {
  for (const statement of servingRolePrivilegeStatements(role)) {
    await db.execute(sql.raw(statement));
  }
}

/**
 * The role a connection URL authenticates as.
 *
 * Needed because the grants name the serving role and the only place that name is
 * configured is the serving connection string: asking the operator to state it twice
 * is asking for the two to disagree.
 *
 * @param url - A Postgres connection URL.
 * @param variable - The environment variable it came from, named in any error rather
 *   than quoted: a connection URL contains a password.
 * @returns The role name, percent-decoded.
 * @throws {Error} When the URL cannot be parsed, or names no role.
 * @example
 * ```ts
 * const role = roleNameFromDatabaseUrl(config.databaseUrl);
 * await applyServingRolePrivileges(owner.db, role);
 * ```
 */
export function roleNameFromDatabaseUrl(
  url: string,
  variable = "MUSTER_DATABASE_URL",
): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${variable} is not a valid connection URL`);
  }

  if (parsed.username.length === 0) {
    throw new Error(`${variable} names no role to connect as`);
  }

  return decodeURIComponent(parsed.username);
}
