#!/usr/bin/env bun
/*
 * Copyright © 2026 Commonwealth Scientific and Industrial Research Organisation
 * (CSIRO) ABN 41 687 119 230. Licensed under the Apache License, Version 2.0.
 */

/**
 * Bundle gate.
 *
 * The server ships as one JavaScript file with no `node_modules` and no native
 * addons, so the container image is a Bun runtime plus a single artefact. This
 * script asserts that after a build: the bundle exists, nothing else was
 * emitted beside it, and nothing in it reaches for a compiled binary.
 *
 * Usage: `bun scripts/checkBundle.mjs [path/to/bundle.js]`
 *
 * @author John Grimes
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { argv, exit } from "node:process";

const bundlePath = argv[2] ?? "dist/server.js";
const directory = dirname(bundlePath);
const bundleName = basename(bundlePath);

const failures = [];

let bytes = 0;
try {
  bytes = (await stat(bundlePath)).size;
} catch {
  console.error(
    `Bundle gate: ${bundlePath} does not exist. Run \`bun run build:server\` first.`,
  );
  exit(1);
}

if (bytes === 0) {
  failures.push(`${bundlePath} is empty`);
}

// Anything else executable beside the bundle means the build split output or
// dragged a compiled addon along.
const disallowedExtensions = [
  ".js",
  ".mjs",
  ".cjs",
  ".node",
  ".so",
  ".dylib",
  ".dll",
];
const siblings = await readdir(directory, { withFileTypes: true });
for (const entry of siblings) {
  if (
    !entry.isFile() ||
    entry.name === bundleName ||
    entry.name === `${bundleName}.map`
  ) {
    continue;
  }
  if (
    disallowedExtensions.some((extension) => entry.name.endsWith(extension))
  ) {
    failures.push(`unexpected file beside the bundle: ${entry.name}`);
  }
}

// Native addons are loaded either as a `.node` file or through dlopen; neither
// survives a single-file bundle on a fresh container.
const source = await readFile(bundlePath, "utf8");
const nativeMarkers = [
  '.node"',
  ".node'",
  ".node`",
  "process.dlopen",
  "dlopen(",
];
for (const marker of nativeMarkers) {
  if (source.includes(marker)) {
    failures.push(`bundle references a native addon (${marker})`);
  }
}

for (const failure of failures) {
  console.error(`Bundle gate: ${failure}`);
}

if (failures.length > 0) {
  exit(1);
}

console.log(
  `Bundle gate: ${bundlePath} is a single file of ${(bytes / 1024).toFixed(1)} KiB ` +
    `with no native addons - ok`,
);
