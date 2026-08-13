/**
 * Finding the migrations, which is the part of migrating that has no database in it.
 *
 * The folder is located by existence rather than by a build-time constant, because
 * `import.meta.url` means something different in each of the two layouts that have
 * to work: this package's source, and the single-file bundle the container runs.
 * A wrong answer there is not a missing-file inconvenience - a migration command
 * that found nothing would report success against an unmigrated database.
 *
 * Author: John Grimes
 */

import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import path from "node:path";

import { resolveMigrationsFolder } from "./migrations.js";

describe("resolveMigrationsFolder", () => {
  it("finds this package's migrations folder", () => {
    const folder = resolveMigrationsFolder();

    expect(existsSync(folder)).toBe(true);
    // The journal is what the migrator reads; a directory without one is not a
    // migrations folder even if it exists.
    expect(existsSync(path.join(folder, "meta", "_journal.json"))).toBe(true);
  });

  it("returns the first candidate that exists", () => {
    const real = resolveMigrationsFolder();

    expect(resolveMigrationsFolder(["/nonexistent/one", real])).toBe(real);
  });

  it("throws naming every path it tried when none exist", () => {
    // Naming them is the whole value of the failure: the two layouts differ, and
    // knowing which one was assumed is what identifies the mistake.
    expect(() =>
      resolveMigrationsFolder(["/nonexistent/one", "/nonexistent/two"]),
    ).toThrow(/nonexistent\/one.*nonexistent\/two/s);
  });
});
