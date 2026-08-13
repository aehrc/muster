/**
 * What the coverage gate accepts and refuses.
 *
 * `scripts/checkCoverage.mjs` is the floor the constitution names, and it computes
 * it from an lcov report rather than from Bun's own "All files" row - which is the
 * unweighted mean of the per-file percentages, in which a fully covered one-line
 * module counts as much as a barely covered five-hundred-line one. The arithmetic
 * that difference rests on is the subject here.
 *
 * The two ways this gate can be silently wrong are both asserted: a report that was
 * never written, and a report that parses but records nothing. Either would divide
 * to nothing and pass every floor, which is the one outcome a coverage gate must
 * never produce.
 *
 * Run as a subprocess, the way `test:coverage` runs it, so what is under test is the
 * artefact rather than a copy of its arithmetic. It lives here rather than beside
 * the script because `bun test src/` is how the whole suite is discovered - a test
 * outside a package's `src` would not be run at all.
 *
 * Author: John Grimes
 */

import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The script `test:coverage` runs after the suite. */
const script = fileURLToPath(
  new URL("../../../scripts/checkCoverage.mjs", import.meta.url),
);

/** One file's worth of lcov records. */
interface FileCoverage {
  readonly name: string;
  readonly linesFound: number;
  readonly linesHit: number;
  readonly functionsFound: number;
  readonly functionsHit: number;
}

/** Renders lcov records for the given files. */
function lcov(files: readonly FileCoverage[]): string {
  return files
    .map((file) =>
      [
        `SF:${file.name}`,
        `FNF:${file.functionsFound}`,
        `FNH:${file.functionsHit}`,
        `LF:${file.linesFound}`,
        `LH:${file.linesHit}`,
        "end_of_record",
      ].join("\n"),
    )
    .join("\n");
}

/**
 * Runs the gate over a report.
 *
 * @param report - The lcov text to write, or `undefined` to write no file at all.
 * @param extraArguments - Arguments to append, such as `--floor`.
 * @returns The exit code, and what the script said.
 */
async function check(
  report: string | undefined,
  ...extraArguments: readonly string[]
): Promise<{ readonly code: number; readonly output: string }> {
  const directory = mkdtempSync(path.join(tmpdir(), "muster-coverage-"));
  const file = path.join(directory, "lcov.info");
  if (report !== undefined) {
    writeFileSync(file, report, "utf8");
  }

  const run = Bun.spawn(["node", script, file, ...extraArguments], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = `${await new Response(run.stdout).text()}${await new Response(run.stderr).text()}`;
  return { code: await run.exited, output };
}

describe("the coverage gate", () => {
  it("accepts totals at the floor", async () => {
    const { code, output } = await check(
      lcov([
        {
          name: "a.ts",
          linesFound: 10,
          linesHit: 8,
          functionsFound: 10,
          functionsHit: 8,
        },
      ]),
    );

    expect(code).toBe(0);
    expect(output).toContain("80.00%");
  });

  it("refuses totals below the floor on lines", async () => {
    const { code, output } = await check(
      lcov([
        {
          name: "a.ts",
          linesFound: 10,
          linesHit: 7,
          functionsFound: 10,
          functionsHit: 10,
        },
      ]),
    );

    expect(code).toBe(1);
    expect(output).toContain("BELOW FLOOR");
  });

  it("refuses totals below the floor on functions", async () => {
    const { code, output } = await check(
      lcov([
        {
          name: "a.ts",
          linesFound: 10,
          linesHit: 10,
          functionsFound: 10,
          functionsHit: 3,
        },
      ]),
    );

    expect(code).toBe(1);
    expect(output).toContain("BELOW FLOOR");
  });

  // The whole reason this script exists rather than Bun's per-file threshold: a
  // small fully covered file must not offset a large uncovered one. Totals here
  // are 11/110 lines, which no averaging of 100% and 1% would report as failing
  // by enough to be obvious.
  it("totals across files rather than averaging them", async () => {
    const { code, output } = await check(
      lcov([
        {
          name: "small.ts",
          linesFound: 10,
          linesHit: 10,
          functionsFound: 2,
          functionsHit: 2,
        },
        {
          name: "large.ts",
          linesFound: 100,
          linesHit: 1,
          functionsFound: 20,
          functionsHit: 1,
        },
      ]),
    );

    expect(code).toBe(1);
    expect(output).toContain("11/110");
  });

  it("honours an explicit floor", async () => {
    const report = lcov([
      {
        name: "a.ts",
        linesFound: 10,
        linesHit: 5,
        functionsFound: 10,
        functionsHit: 5,
      },
    ]);

    await expect(check(report, "--floor", "0.4")).resolves.toMatchObject({
      code: 0,
    });
    await expect(check(report, "--floor", "0.6")).resolves.toMatchObject({
      code: 1,
    });
  });

  it("refuses a report that was never written", async () => {
    // No report means the suite ran without coverage. Reporting success on an
    // absent measurement is the one outcome this script exists to prevent.
    const { code, output } = await check(undefined);

    expect(code).toBe(1);
    expect(output).toContain("was not written");
  });

  it("refuses a report that records no coverage at all", async () => {
    // An empty report parses perfectly and divides to nothing, which would pass
    // every floor below.
    const { code, output } = await check("");

    expect(code).toBe(1);
    expect(output).toContain("records no coverage");
  });

  it("refuses a floor outside zero to one", async () => {
    const { code, output } = await check(
      lcov([
        {
          name: "a.ts",
          linesFound: 1,
          linesHit: 1,
          functionsFound: 1,
          functionsHit: 1,
        },
      ]),
      "--floor",
      "80",
    );

    expect(code).toBe(2);
    expect(output).toContain("usage");
  });
});
