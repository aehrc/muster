/**
 * What the self-contained-bundle gate accepts and refuses.
 *
 * `scripts/checkBundle.mjs` is what stands between a dependency that cannot be
 * bundled and a deployment that crashes on startup, and it decides by scanning the
 * bundled text rather than by parsing it. That is the right trade for a build step -
 * a parser for whatever a bundler emitted is a much larger thing to maintain - but
 * it means the gate has two ways to be wrong, and only one of them is visible.
 *
 * A missed import ships a broken image. A false positive is worse in a subtler way:
 * it fails a build for a dependency that is perfectly bundlable, and the fix that
 * suggests itself is to loosen the check until it passes. Prose containing the word
 * `from` inside a quoted error message is exactly that case.
 *
 * So both directions are asserted here: every form a bundler emits an external
 * import in is caught, and prose that merely contains the word `from` is not. The
 * script is run as a subprocess, the way the Dockerfile runs it, so what is under
 * test is the artefact rather than a copy of its patterns.
 *
 * This suite lives in `apps/server` because the bundle it guards is the server's,
 * and because `bun test src/` is how the whole suite is discovered - a test outside
 * a package's `src` would not be run at all.
 *
 * Author: John Grimes
 */

import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The script the Docker build runs against the server bundle. */
const script = fileURLToPath(
  new URL("../../../scripts/checkBundle.mjs", import.meta.url),
);

/**
 * Runs the gate over one file of bundled text.
 *
 * @param source - What the bundle would contain.
 * @returns The exit code, and what the script said.
 */
async function check(
  source: string,
): Promise<{ readonly code: number; readonly output: string }> {
  const directory = mkdtempSync(path.join(tmpdir(), "muster-bundle-"));
  const file = path.join(directory, "bundle.js");
  writeFileSync(file, source, "utf8");

  const run = Bun.spawn(["node", script, file], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = `${await new Response(run.stdout).text()}${await new Response(run.stderr).text()}`;
  return { code: await run.exited, output };
}

describe("the self-contained bundle gate", () => {
  // Every shape a bundler leaves behind when it does not inline a dependency. A
  // gate that missed any one of them would pass an image that cannot start.
  it.each([
    ["a named import", 'import { thing } from "left-pad";'],
    ["a default import", 'import thing from "left-pad";'],
    ["a namespace import", 'import * as thing from "left-pad";'],
    ["a bare import", 'import "left-pad";'],
    ["a re-export", 'export { thing } from "left-pad";'],
    ["a require", 'const thing = require("left-pad");'],
    ["a dynamic import", 'const thing = await import("left-pad");'],
  ])("refuses %s of a package that was left external", async (_name, line) => {
    const { code, output } = await check(line);

    expect(code).toBe(1);
    expect(output).toContain("left-pad");
    expect(output).toContain("NOT self-contained");
  });

  it("accepts a bundle that imports only Node builtins", async () => {
    // Both spellings: the Postgres driver imports `crypto` without the prefix,
    // which is legitimate and must not be refused.
    const { code, output } = await check(
      [
        'import { readFileSync } from "node:fs";',
        'import crypto from "crypto";',
        'const net = require("net");',
      ].join("\n"),
    );

    expect(code).toBe(0);
    expect(output).toContain("self-contained");
  });

  it("accepts prose that merely contains the word from", async () => {
    // The shape that makes a lexical scan dangerous: an error message quoting
    // words that read as an import clause. Refusing this fails a build for a
    // dependency that bundles perfectly well.
    const { code } = await check(
      [
        "const message = \"Cannot get 'saltLength' from 'alg' argument\";",
        "const other = \"expected a value from 'options' here\";",
      ].join("\n"),
    );

    expect(code).toBe(0);
  });

  it("accepts relative and absolute specifiers", async () => {
    // A bundler emits these for its own chunks and for assets; neither is an
    // unbundled dependency.
    const { code } = await check(
      ['import a from "./chunk.js";', 'import b from "/app/other.js";'].join(
        "\n",
      ),
    );

    expect(code).toBe(0);
  });

  it("reports every external import rather than only the first", async () => {
    const { code, output } = await check(
      ['import a from "left-pad";', 'import b from "right-pad";'].join("\n"),
    );

    expect(code).toBe(1);
    expect(output).toContain("left-pad");
    expect(output).toContain("right-pad");
  });

  it("refuses to run with no file named", async () => {
    // Exiting 0 on no arguments would let a mis-wired build step report success
    // having checked nothing.
    const run = Bun.spawn(["node", script], { stdout: "pipe", stderr: "pipe" });
    const output = await new Response(run.stderr).text();

    expect(await run.exited).toBe(2);
    expect(output).toContain("usage");
  });
});
