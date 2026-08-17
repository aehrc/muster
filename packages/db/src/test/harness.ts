import { SQL } from "bun";
import { afterAll, beforeAll, describe, test } from "bun:test";
import { join } from "node:path";

import { runMigrations } from "../migrations.ts";
import { quoteIdentifier } from "../quoting.ts";

/**
 * Integration-test harness.
 *
 * Integration suites need a real PostgreSQL instance. They run when
 * `MUSTER_TEST_DATABASE_URL` is set and are skipped - visibly, as a reported
 * skipped test - when it is not. Continuous integration sets
 * `MUSTER_REQUIRE_DATABASE_TESTS` as well, which turns a missing URL into a
 * failure so the suites cannot go quiet.
 *
 * @author John Grimes
 */

/**
 * Reads the integration-test database URL.
 *
 * @returns the URL, or undefined when it is unset or empty
 */
export const testDatabaseUrl = (): string | undefined => {
  const url = process.env["MUSTER_TEST_DATABASE_URL"];
  return url === undefined || url.length === 0 ? undefined : url;
};

/**
 * Reports whether the environment forbids skipping integration tests.
 *
 * @returns true when `MUSTER_REQUIRE_DATABASE_TESTS` is set to a non-empty value
 */
export const databaseTestsRequired = (): boolean => {
  const flag = process.env["MUSTER_REQUIRE_DATABASE_TESTS"];
  return flag !== undefined && flag.length > 0;
};

/** What a database suite is handed. */
export type DatabaseTestContext = {
  /** the connection, valid from the first test onwards */
  readonly sql: () => SQL;
  /** a name unique to this process, safe to use for roles and schemas */
  readonly uniqueName: (prefix: string) => string;
};

/**
 * Builds a name unlikely to collide with a concurrent suite.
 *
 * @param prefix - a lower-case prefix identifying the suite
 * @returns the prefix with a random suffix appended
 */
export const uniqueName = (prefix: string): string =>
  `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;

/**
 * Declares a suite that needs a real database.
 *
 * @param label - the suite name
 * @param body - registers the suite's tests, given a connection accessor
 * @throws {Error} when the URL is absent but the environment requires the suite
 * @example
 * ```ts
 * describeDatabase("migrations", ({ sql }) => {
 *   test("applies pending migrations", async () => {
 *     await runMigrations({ sql: sql(), directory });
 *   });
 * });
 * ```
 */
export const describeDatabase = (
  label: string,
  body: (context: DatabaseTestContext) => void,
): void => {
  const url = testDatabaseUrl();

  if (url === undefined) {
    if (databaseTestsRequired()) {
      throw new Error(
        "MUSTER_REQUIRE_DATABASE_TESTS is set but MUSTER_TEST_DATABASE_URL is not; " +
          "refusing to skip integration tests",
      );
    }
    describe(label, () => {
      test.skip("skipped: MUSTER_TEST_DATABASE_URL is not set", () => {
        // Reported as a skipped test so an absent database is visible.
      });
    });
    return;
  }

  describe(label, () => {
    let connection: SQL | undefined;

    beforeAll(() => {
      connection = new SQL(url);
    });

    afterAll(async () => {
      await connection?.end();
      connection = undefined;
    });

    body({
      sql: () => {
        if (connection === undefined) {
          throw new Error(
            "The database connection is only available inside tests",
          );
        }
        return connection;
      },
      uniqueName,
    });
  });
};

/**
 * Creates an empty scratch schema, replacing any existing one.
 *
 * @param sql - an open connection
 * @param schema - the schema name
 */
export const createScratchSchema = async (
  sql: SQL,
  schema: string,
): Promise<void> => {
  const quoted = quoteIdentifier(schema);
  await sql.unsafe(`drop schema if exists ${quoted} cascade`);
  await sql.unsafe(`create schema ${quoted}`);
};

/**
 * Drops a scratch schema and everything in it.
 *
 * @param sql - an open connection
 * @param schema - the schema name
 */
export const dropScratchSchema = async (
  sql: SQL,
  schema: string,
): Promise<void> => {
  await sql.unsafe(`drop schema if exists ${quoteIdentifier(schema)} cascade`);
};

/**
 * Where the generated migrations live.
 *
 * Resolved from this module's own location, which is right for a suite and
 * wrong for the bundled server: the server is told its migration directory by
 * configuration, because the bundle is one file beside a copied directory.
 */
export const migrationsDirectory = join(
  import.meta.dir,
  "..",
  "..",
  "migrations",
);

/** A scratch schema with every migration applied, and a connection into it. */
export type MigratedSchema = {
  /** a connection whose search path is the scratch schema */
  readonly sql: SQL;
  /** the scratch schema's name */
  readonly schema: string;
  /** drops the schema and closes the connections */
  readonly close: () => Promise<void>;
};

/**
 * Creates a scratch schema, applies every migration to it, and connects.
 *
 * The connection carries the scratch schema as its startup `search_path`, so
 * unqualified statements land in it however the pool reconnects. That is what
 * keeps concurrent suites - and repeat runs against a developer's own database
 * - from seeing each other's rows.
 *
 * @param prefix - a lower-case prefix identifying the suite
 * @returns the connection, the schema name, and the teardown
 * @throws {Error} when `MUSTER_TEST_DATABASE_URL` is not set
 * @example
 * ```ts
 * const database = await createMigratedSchema("directory");
 * try {
 *   await insertAccount(database.sql, { ... });
 * } finally {
 *   await database.close();
 * }
 * ```
 */
export const createMigratedSchema = async (
  prefix: string,
): Promise<MigratedSchema> => {
  const url = testDatabaseUrl();
  if (url === undefined) {
    throw new Error(
      "MUSTER_TEST_DATABASE_URL must be set to create a migrated scratch schema",
    );
  }
  const schema = uniqueName(prefix);

  const owner = new SQL(url, { max: 1 });
  await createScratchSchema(owner, schema);
  await runMigrations({ sql: owner, directory: migrationsDirectory, schema });

  const sql = new SQL(url, { connection: { search_path: schema } });
  return {
    sql,
    schema,
    close: async () => {
      await sql.end();
      await dropScratchSchema(owner, schema);
      await owner.end();
    },
  };
};
