/**
 * The naming rule that keeps `bun test` and `playwright test` out of each other's way.
 *
 * Bun's test runner discovers `*.test.*`, `*_test.*`, `*.spec.*` and `*_spec.*` anywhere under
 * the working directory, and it cannot be told to ignore a path. A Playwright spec collected
 * that way does not merely fail: it aborts the file with "Playwright Test did not expect
 * test() to be called here", which is what a newcomer typing the obvious command would see.
 *
 * So the two runners are separated by name rather than by luck. Playwright's specs end in
 * `.e2e.ts`, which `playwright.config.ts` names in `testMatch` and which matches none of Bun's
 * patterns. This test is the guard: a spec added under the old convention fails here rather
 * than by breaking `bun test` for everybody.
 *
 * Author: John Grimes
 */

import { describe, expect, it } from "bun:test";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Bun's default test-file discovery patterns, as a single expression. */
const BUN_DISCOVERS =
  /\.(?:test|spec)\.[cm]?[jt]sx?$|_(?:test|spec)\.[cm]?[jt]sx?$/;

/** The Playwright suite's specs. */
const SPEC_DIRECTORY = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "tests",
);

describe("the end-to-end specs", () => {
  it("are named so that Bun's runner does not collect them", () => {
    const collected = readdirSync(SPEC_DIRECTORY).filter((name) =>
      BUN_DISCOVERS.test(name),
    );

    expect(collected).toEqual([]);
  });

  it("are named the way playwright.config.ts looks for them", () => {
    const specs = readdirSync(SPEC_DIRECTORY);

    // Not merely "not a Bun test": a file the naming rule renamed but Playwright's
    // `testMatch` does not match is a scenario that silently stops running.
    expect(specs.length).toBeGreaterThan(0);
    expect(specs.every((name) => name.endsWith(".e2e.ts"))).toBe(true);
  });
});
