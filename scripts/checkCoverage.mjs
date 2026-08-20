#!/usr/bin/env bun
/*
 * Copyright © 2026 Commonwealth Scientific and Industrial Research Organisation
 * (CSIRO) ABN 41 687 119 230. Licensed under the Apache License, Version 2.0.
 */

/**
 * Coverage gate.
 *
 * `bun test --coverage` writes `coverage/lcov.info`; this script totals it and
 * fails the build when either lines or functions fall below the threshold. The
 * per-file view is left to the text reporter - the gate is on the totals, so
 * one thin file cannot fail a healthy repository and a wall of untested code
 * cannot hide behind a handful of well-tested files.
 *
 * Usage: `bun scripts/checkCoverage.mjs [path/to/lcov.info]`
 *
 * @author John Grimes
 */

import { readFile } from "node:fs/promises";
import { argv, exit } from "node:process";

const THRESHOLD_PERCENT = 80;

const lcovPath = argv[2] ?? "coverage/lcov.info";

let lcov;
try {
  lcov = await readFile(lcovPath, "utf8");
} catch (cause) {
  console.error(
    `Coverage gate: cannot read ${lcovPath}. Run \`bun test --coverage\` first. (${cause.message})`,
  );
  exit(1);
}

// LCOV records: LF/LH are lines found/hit, FNF/FNH functions found/hit.
const totalFor = (prefix) =>
  lcov
    .split("\n")
    .filter((line) => line.startsWith(`${prefix}:`))
    .reduce((sum, line) => sum + Number(line.slice(prefix.length + 1)), 0);

const metrics = [
  { name: "lines", found: totalFor("LF"), hit: totalFor("LH") },
  { name: "functions", found: totalFor("FNF"), hit: totalFor("FNH") },
];

if (metrics.every((metric) => metric.found === 0)) {
  console.error(
    `Coverage gate: ${lcovPath} records no lines. Refusing to pass on an empty report.`,
  );
  exit(1);
}

let failed = false;
for (const { name, found, hit } of metrics) {
  // A metric absent from the report cannot be judged; say so rather than
  // scoring it zero or silently passing it.
  if (found === 0) {
    console.log(`Coverage gate: ${name} not reported, skipped.`);
    continue;
  }
  const percent = (hit / found) * 100;
  const verdict = percent >= THRESHOLD_PERCENT ? "ok" : "FAIL";
  console.log(
    `Coverage gate: ${name} ${percent.toFixed(2)}% (${hit}/${found}), ` +
      `threshold ${THRESHOLD_PERCENT}% - ${verdict}`,
  );
  failed ||= percent < THRESHOLD_PERCENT;
}

exit(failed ? 1 : 0);
