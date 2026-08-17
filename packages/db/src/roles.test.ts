import { describe, expect, test } from "bun:test";

import { bootstrapServerRole } from "./roles.ts";

import type { SQL } from "bun";

// A connection that fails the test if it is touched at all, proving that the
// name checks happen before any statement is sent.
const unusableConnection = new Proxy(function noop() {}, {
  get() {
    throw new Error(
      "the connection must not be used when the options are invalid",
    );
  },
  apply() {
    throw new Error(
      "the connection must not be used when the options are invalid",
    );
  },
}) as unknown as SQL;

describe("bootstrapServerRole", () => {
  test("refuses an empty role name before opening a statement", async () => {
    await expect(
      bootstrapServerRole(unusableConnection, { role: "" }),
    ).rejects.toThrow(/empty/i);
  });

  test("refuses an empty schema name before opening a statement", async () => {
    await expect(
      bootstrapServerRole(unusableConnection, {
        role: "muster_server",
        schema: "",
      }),
    ).rejects.toThrow(/empty/i);
  });
});
