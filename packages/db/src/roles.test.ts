/**
 * The two-role bootstrap, as far as it can be judged without a database.
 *
 * Muster migrates as an identity that owns the schema and serves as one that does
 * not. The serving role's access is therefore generated rather than written into a
 * migration, because every statement names the role and the role name is
 * configuration - an operator chooses it, or a managed database hands one out.
 *
 * What is asserted here is the shape of those statements and the parsing of the
 * role name out of a connection URL. That the split actually holds - that the
 * serving role can read and cannot migrate - is a property of Postgres and is
 * asserted in `roles.integration.test.ts`.
 *
 * Author: John Grimes
 */

import { describe, expect, it } from "bun:test";

import {
  roleNameFromDatabaseUrl,
  servingRolePrivilegeStatements,
} from "./roles.js";

describe("servingRolePrivilegeStatements", () => {
  it("grants schema usage before anything that depends on it", () => {
    // Without `usage on schema` every grant below names something the role cannot
    // reach, and the failure presents as a permission error on a correct query.
    const statements = servingRolePrivilegeStatements("muster_app");

    expect(statements[0]).toBe('grant usage on schema public to "muster_app"');
  });

  it("grants the four data-manipulation privileges on every table", () => {
    const statements = servingRolePrivilegeStatements("muster_app");

    expect(statements).toContain(
      'grant select, insert, update, delete on all tables in schema public to "muster_app"',
    );
  });

  it("grants the same on tables a later migration creates", () => {
    // Otherwise every migration that adds a table has to remember to re-run the
    // grants, and the one that forgets ships a table the server cannot read.
    const statements = servingRolePrivilegeStatements("muster_app");

    expect(
      statements.some(
        (statement) =>
          statement.startsWith("alter default privileges") &&
          statement.includes("on tables"),
      ),
    ).toBe(true);
  });

  it("grants sequence access, current and future", () => {
    const statements = servingRolePrivilegeStatements("muster_app");

    expect(statements).toContain(
      'grant usage, select on all sequences in schema public to "muster_app"',
    );
    expect(
      statements.some(
        (statement) =>
          statement.startsWith("alter default privileges") &&
          statement.includes("on sequences"),
      ),
    ).toBe(true);
  });

  it("never grants the serving role authority to create or drop", () => {
    // The whole point of the split: a role that can create a table can also
    // migrate, and then "the migrations ran as the owner" stops being true.
    const statements = servingRolePrivilegeStatements("muster_app");

    for (const statement of statements) {
      expect(statement).not.toContain("grant create");
      expect(statement).not.toContain("grant all");
    }
  });

  it("quotes the role name", () => {
    // A managed database hands out mixed-case role names, which Postgres folds to
    // lower case unless they are quoted.
    const statements = servingRolePrivilegeStatements("Muster-App");

    for (const statement of statements) {
      expect(statement).toContain('"Muster-App"');
    }
  });

  it("escapes an embedded quote in the role name", () => {
    // Unescaped, the identifier ends early and the remainder is left as SQL.
    const statements = servingRolePrivilegeStatements('we"ird');

    for (const statement of statements) {
      expect(statement).toContain('"we""ird"');
    }
  });

  it("refuses a blank role name", () => {
    // A blank name generates a syntactically valid statement that grants to
    // nothing, which would report success while leaving the server unable to read.
    expect(() => servingRolePrivilegeStatements("   ")).toThrow(
      /serving role name/i,
    );
  });
});

describe("roleNameFromDatabaseUrl", () => {
  it("returns the role the connection authenticates as", () => {
    expect(
      roleNameFromDatabaseUrl("postgres://muster_app:pw@db:5432/muster"),
    ).toBe("muster_app");
  });

  it("percent-decodes the role name", () => {
    // A role name with a reserved character reaches the URL encoded, and the
    // grants must name the role Postgres knows rather than its encoding.
    expect(
      roleNameFromDatabaseUrl("postgres://muster%40app:pw@db:5432/muster"),
    ).toBe("muster@app");
  });

  it("refuses a URL that names no role", () => {
    expect(() => roleNameFromDatabaseUrl("postgres://db:5432/muster")).toThrow(
      /names no role/i,
    );
  });

  it("refuses an unparseable URL", () => {
    expect(() => roleNameFromDatabaseUrl("not a url")).toThrow(
      /valid connection URL/i,
    );
  });

  it("names the variable rather than quoting the URL", () => {
    // A connection URL contains a password, so it must not reach an error message
    // or a log line.
    expect(() =>
      roleNameFromDatabaseUrl("postgres://db/muster", "MUSTER_DATABASE_URL"),
    ).toThrow(/MUSTER_DATABASE_URL/);
    expect(() =>
      roleNameFromDatabaseUrl("postgres://:hunter2@db/muster"),
    ).not.toThrow(/hunter2/);
  });
});
