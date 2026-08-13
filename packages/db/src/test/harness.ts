/**
 * The integration-test harness: one variable in, a usable database out.
 *
 * Three things have to be true for an integration suite in this repository to be
 * evidence rather than decoration, and this module is where all three are arranged.
 *
 * **It skips rather than fails when there is no database.** A developer running only
 * the unit suites must not have to stand up Postgres. Every integration file asks
 * {@link hasTestDatabase} and skips itself when the answer is no - which means a run
 * with the variable unset reports success having exercised no database at all, so CI
 * sets it and a skip there is a workflow failure.
 *
 * **The schema is migrated exactly once, before any test file is imported.**
 * Migrations are DDL, and DDL takes exclusive table locks; applying them lazily from
 * whichever file ran first means one suite altering tables while another holds row
 * locks on them, which Postgres resolves by killing one of the two. `./preload.ts`
 * does it, registered as `preload` under `[test]` in the repository's `bunfig.toml`.
 * A file run some other way - `bun test one.test.ts` from inside the package, where
 * Bun finds no `bunfig.toml` - sees the ready flag unset and migrates for itself.
 *
 * **The suites connect as the role a deployment serves with, not the one that owns
 * the schema.** The owning identity can create and drop tables; the serving role
 * cannot. A suite running as the owner would pass whether or not the grants in
 * `../roles.ts` were correct. The developer still configures one variable - the
 * owning identity - and every suite derives its connection from it by swapping the
 * credential.
 *
 * Author: John Grimes
 */

import { sql } from "drizzle-orm";

import { createDatabase } from "../client.js";
import { applyMigrations, withMigrationLock } from "../migrations.js";
import { applyServingRolePrivileges } from "../roles.js";

import type { DatabaseHandle } from "../client.js";
import type { Executor } from "../executor.js";

/** Names the throwaway database the suites may migrate, create roles in and write to. */
export const TEST_DATABASE_URL_VARIABLE = "MUSTER_TEST_DATABASE_URL";

/** Set by the preload once the schema has been migrated, and read by the suites. */
export const TEST_SCHEMA_READY_VARIABLE = "MUSTER_TEST_SCHEMA_READY";

/**
 * The role the suites connect as.
 *
 * Fixed rather than generated per run: the grants are applied once from the preload,
 * before any test file is imported.
 */
export const SERVING_TEST_ROLE = "muster_app_test";

/**
 * Its password.
 *
 * Not a secret, and not treated as one. It names a login on a throwaway database
 * that exists for the duration of a test run, and it is in the repository so that
 * the derivation below needs nothing passed to it. A generated password would have
 * to be communicated from the preload to every suite, which is a mechanism with more
 * ways to go wrong than the problem has.
 */
export const SERVING_TEST_PASSWORD = "muster_app_test";

/** A read-only view of the environment, as `process.env` presents it. */
type Environment = Readonly<Record<string, string | undefined>>;

/**
 * The configured test database URL, or `undefined` when there is none.
 *
 * A blank value counts as unset: a CI job that exports an empty variable should skip
 * rather than fail trying to connect to nothing.
 *
 * @param env - The environment to read. Defaults to the process's own.
 * @returns The owning identity's connection URL, or `undefined`.
 */
export function testDatabaseUrl(
  env: Environment = process.env,
): string | undefined {
  const url = env[TEST_DATABASE_URL_VARIABLE];
  return url === undefined || url.trim().length === 0 ? undefined : url;
}

/**
 * Whether an integration suite can run.
 *
 * @param env - The environment to read. Defaults to the process's own.
 * @returns `true` when a test database is configured.
 * @example
 * ```ts
 * describe.skipIf(!hasTestDatabase())("the repositories", () => {
 *   // ...
 * });
 * ```
 */
export function hasTestDatabase(env: Environment = process.env): boolean {
  return testDatabaseUrl(env) !== undefined;
}

/** Which components of a connection URL to replace. */
export interface ConnectionUrlChanges {
  /** The role to connect as. */
  readonly user?: string;
  /** Its password. */
  readonly password?: string;
  /** The database to connect to, unqualified. */
  readonly database?: string;
}

/**
 * Replaces the named components of a connection URL and keeps the rest.
 *
 * Host, port and every connection parameter are how the developer reached the
 * database in the first place, so a suite that guessed them would fail for reasons
 * unrelated to what it asserts.
 *
 * Every replacement is percent-encoded, because a userinfo component that is not
 * encoded can terminate early and silently point the connection at a different host -
 * which, in a suite whose whole subject is which identity connected, would be a
 * false pass rather than a failure.
 *
 * @param url - The connection URL to derive from.
 * @param changes - The components to replace. An absent one is carried across.
 * @param variable - The environment variable `url` came from, named in any error
 *   rather than quoted: a connection URL contains a password.
 * @returns The derived URL.
 * @throws {Error} When `url` cannot be parsed.
 * @example
 * ```ts
 * const asServer = databaseUrlWith(ownerUrl, { user: "muster_app_test" });
 * ```
 */
export function databaseUrlWith(
  url: string,
  changes: ConnectionUrlChanges,
  variable: string = TEST_DATABASE_URL_VARIABLE,
): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${variable} is not a valid connection URL`);
  }

  if (changes.user !== undefined) {
    parsed.username = encodeURIComponent(changes.user);
  }
  if (changes.password !== undefined) {
    parsed.password = encodeURIComponent(changes.password);
  }
  if (changes.database !== undefined) {
    parsed.pathname = `/${encodeURIComponent(changes.database)}`;
  }

  return parsed.toString();
}

/**
 * Derives the serving connection from the owning one.
 *
 * @param ownerUrl - The configured test database URL, naming the owning identity.
 * @returns The same database, reached as {@link SERVING_TEST_ROLE}.
 * @throws {Error} When the URL cannot be parsed.
 */
export function servingRoleUrl(ownerUrl: string): string {
  return databaseUrlWith(ownerUrl, {
    user: SERVING_TEST_ROLE,
    password: SERVING_TEST_PASSWORD,
  });
}

/**
 * Creates the serving role and grants it what the suites need.
 *
 * The role is created plainly: no `superuser`, no `createdb`, no membership of the
 * owning role, and it owns nothing, because everything it can reach was created by
 * the owner and granted to it here.
 *
 * @param db - A connection with authority to create roles and grant on the tables,
 *   which in practice is the owning identity.
 */
async function prepareServingRole(db: Executor): Promise<void> {
  // `create role` has no `if not exists`, and a second run over the same database
  // must be a no-op rather than an error.
  await db.execute(
    sql.raw(`
      do $$
      begin
        if not exists (select 1 from pg_roles where rolname = '${SERVING_TEST_ROLE}') then
          create role ${SERVING_TEST_ROLE} login password '${SERVING_TEST_PASSWORD}';
        end if;
      end
      $$;
    `),
  );

  await applyServingRolePrivileges(db, SERVING_TEST_ROLE);
}

/**
 * Migrates the test database and grants the serving role, once.
 *
 * Both steps happen under one advisory lock, because a second process that observed
 * the schema between them would see tables the serving role cannot reach.
 *
 * Idempotent, so a second run over the same database is a no-op. Called by the
 * preload, and again by any suite that may have been run without it.
 *
 * @param url - The owning identity's connection URL.
 */
export async function prepareTestDatabase(url: string): Promise<void> {
  if (isTestSchemaReady()) {
    return;
  }

  const handle = createDatabase({ url, maxConnections: 1 });
  try {
    await withMigrationLock(handle.db, async () => {
      await applyMigrations(handle.db);
      await prepareServingRole(handle.db);
    });
    markTestSchemaReady();
  } finally {
    await handle.close();
  }
}

/**
 * Opens a connection as the serving role, migrating first if nothing else has.
 *
 * @returns The handle, or `undefined` when no test database is configured - which is
 *   the caller's cue to skip.
 * @example
 * ```ts
 * const handle = await openTestDatabase();
 * ```
 */
export async function openTestDatabase(): Promise<DatabaseHandle | undefined> {
  const url = testDatabaseUrl();
  if (url === undefined) {
    return undefined;
  }
  await prepareTestDatabase(url);
  return createDatabase({ url: servingRoleUrl(url), maxConnections: 2 });
}

/**
 * Whether something has already migrated the test database this run.
 *
 * @param env - The environment to read. Defaults to the process's own.
 * @returns `true` when the schema is ready.
 */
export function isTestSchemaReady(env: Environment = process.env): boolean {
  return env[TEST_SCHEMA_READY_VARIABLE] === "1";
}

/** Records that the schema has been migrated, for the suites to read. */
export function markTestSchemaReady(): void {
  process.env[TEST_SCHEMA_READY_VARIABLE] = "1";
}
