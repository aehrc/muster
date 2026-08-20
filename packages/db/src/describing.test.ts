/*
 * Copyright © 2026 Commonwealth Scientific and Industrial Research Organisation
 * (CSIRO) ABN 41 687 119 230. Licensed under the Apache License, Version 2.0.
 */

import { describe, expect, test } from "bun:test";

import { describeConnection } from "./describing.ts";

/**
 * Naming a database without naming its credentials.
 *
 * The point of it is the one thing every test here checks: no password, and no
 * user name, survives into the description. A connection URL carries both, and
 * this is the only shape in which one may be written to a log (FR-036).
 *
 * @author John Grimes
 */

describe("describeConnection", () => {
  test("names the host, the port and the database", () => {
    expect(
      describeConnection(
        "postgresql://muster_owner:hunter2@postgres.example.org:5433/muster",
      ),
    ).toBe("muster at postgres.example.org:5433");
  });

  // The default port is not stated, because a URL that does not state it is not
  // saying anything about it.
  test("leaves an unstated port out", () => {
    expect(describeConnection("postgresql://muster@db/muster")).toBe(
      "muster at db",
    );
  });

  test.each([
    "postgresql://muster_owner:hunter2@db:5432/muster",
    "postgres://someone:a%20password@db:5432/muster",
  ])("keeps the credentials in %p out of the description", (url) => {
    const described = describeConnection(url);

    expect(described).not.toContain("hunter2");
    expect(described).not.toContain("password");
    expect(described).not.toContain("muster_owner");
    expect(described).not.toContain("someone");
  });

  // Deny by default: something that is not a URL is not echoed, because the
  // reason it could not be parsed may be that it is not what it was thought to be.
  test("says nothing about a value it could not parse", () => {
    expect(describeConnection("not a url")).toBe("an unparseable database URL");
  });
});
