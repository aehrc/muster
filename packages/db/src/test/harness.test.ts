/**
 * The integration-test harness's own behaviour.
 *
 * Every integration suite in this repository decides whether to run by asking this
 * harness, so a harness that answered wrongly would not fail - it would skip, and
 * report a green run that exercised no database at all. That is the failure mode
 * being guarded here.
 *
 * Author: John Grimes
 */

import { describe, expect, it } from "bun:test";

import {
  databaseUrlWith,
  hasTestDatabase,
  servingRoleUrl,
  testDatabaseUrl,
  TEST_DATABASE_URL_VARIABLE,
} from "./harness.js";

describe("testDatabaseUrl", () => {
  it("returns the configured URL", () => {
    const env = { [TEST_DATABASE_URL_VARIABLE]: "postgres://o:pw@db/muster" };

    expect(testDatabaseUrl(env)).toBe("postgres://o:pw@db/muster");
  });

  it("returns undefined when unset", () => {
    expect(testDatabaseUrl({})).toBeUndefined();
  });

  it("treats a blank value as unset", () => {
    // A CI job that exports an empty variable must skip rather than fail trying to
    // connect to nothing.
    expect(
      testDatabaseUrl({ [TEST_DATABASE_URL_VARIABLE]: "  " }),
    ).toBeUndefined();
  });

  it("reports whether a database is configured", () => {
    expect(
      hasTestDatabase({ [TEST_DATABASE_URL_VARIABLE]: "postgres://o@db/m" }),
    ).toBe(true);
    expect(hasTestDatabase({})).toBe(false);
  });
});

describe("databaseUrlWith", () => {
  it("replaces only the components named", () => {
    // Host, port, database and every connection parameter are how the developer
    // reached the database in the first place. A suite that guessed them would
    // fail for reasons unrelated to what it asserts.
    const derived = databaseUrlWith(
      "postgres://owner:secret@example:55433/muster_test?sslmode=disable",
      { user: "muster_app_test", password: "muster_app_test" },
    );

    expect(derived).toContain("muster_app_test:muster_app_test@");
    expect(derived).toContain("example:55433");
    expect(derived).toContain("/muster_test");
    expect(derived).toContain("sslmode=disable");
  });

  it("replaces the database when asked", () => {
    expect(
      databaseUrlWith("postgres://o:pw@db:5432/muster_test", {
        database: "scratch",
      }),
    ).toContain("/scratch");
  });

  it("percent-encodes every replacement", () => {
    // An unencoded userinfo component can terminate early and silently point the
    // connection at a different host - which, in a suite whose whole subject is
    // which identity connected, would be a false pass rather than a failure.
    const derived = databaseUrlWith("postgres://o:pw@db:5432/muster", {
      user: "role@host",
      password: "p@ss/word",
    });

    expect(derived).toContain("role%40host");
    expect(derived).toContain("p%40ss%2Fword");
    expect(new URL(derived).hostname).toBe("db");
  });

  it("names the variable rather than quoting an unparseable URL", () => {
    expect(() => databaseUrlWith("not a url", { user: "x" })).toThrow(
      new RegExp(TEST_DATABASE_URL_VARIABLE),
    );
  });
});

describe("servingRoleUrl", () => {
  it("derives the serving connection from the owning one", () => {
    const derived = servingRoleUrl("postgres://owner:secret@db:55433/muster");

    expect(derived).not.toContain("owner");
    expect(derived).not.toContain("secret");
    expect(derived).toContain("db:55433/muster");
  });
});
