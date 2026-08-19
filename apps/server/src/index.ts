import { openEventCheckIntervalMs } from "@muster/core";
import { bootstrapServerRole, runMigrations } from "@muster/db";
import { SQL } from "bun";
import { stat } from "node:fs/promises";

import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { createMailTransport } from "./mail/transport.ts";
import { createScheduler } from "./scheduler/scheduler.ts";

import type { MusterConfig } from "./config.ts";

/**
 * Muster server entry point.
 *
 * Configuration is read once, here, and a deployment that is misconfigured
 * fails to start rather than serving on a guess. What it starts with is then
 * stated in the log, because an operator should not have to infer from
 * behaviour whether mail is being sent or written to the log.
 *
 * Start-up applies the migrations and bootstraps the serving role with the
 * owning role's connection, then drops that connection and serves with the
 * non-owning one: the running server has data rights and no DDL rights.
 *
 * One process serves both the JSON API and the built console, so a deployment is
 * one image behind one public URL. Whether the console is there is stated in the
 * log, because an operator should not have to browse to find out.
 *
 * @author John Grimes
 */

let config: MusterConfig;
try {
  config = loadConfig(process.env);
} catch (cause) {
  console.error(cause instanceof Error ? cause.message : String(cause));
  process.exit(1);
}

const owner = new SQL(config.migrationDatabaseUrl);
try {
  const applied = await runMigrations({
    sql: owner,
    directory: config.migrationsDirectory,
  });
  await bootstrapServerRole(owner, {
    role: config.serverDatabaseRole,
    ...(config.serverDatabasePassword === undefined
      ? {}
      : { password: config.serverDatabasePassword }),
  });
  console.log(
    `Database ready: applied ${String(applied.applied.length)} migration(s), ` +
      `${String(applied.alreadyApplied.length)} already present, ` +
      `serving role ${config.serverDatabaseRole}`,
  );
} catch (cause) {
  console.error(
    `Database preparation failed: ${cause instanceof Error ? cause.message : String(cause)}`,
  );
  process.exit(1);
} finally {
  await owner.end();
}

const sql = new SQL(config.databaseUrl);
const mail = createMailTransport({
  from: config.mailFrom,
  delivery: config.mail,
});

const server = Bun.serve({
  port: config.port,
  fetch: createApp({ config, mail, sql }).fetch,
});

// One interval in one instance, per the constitution: a deployment must pin a
// single replica, because a second copy of this would double every
// participant's inbound traffic. Every result is persisted, so a restart loses
// nothing.
const scheduler = createScheduler({ config, sql });
scheduler.start();

// Stated rather than implied: an image built without the console still serves
// the API, and the operator should be able to see which one they have.
const consolePresent = await stat(config.webDirectory)
  .then((found) => found.isDirectory())
  .catch(() => false);

console.log(
  `Muster listening on ${server.url.toString()}, public URL ${config.publicUrl}, ` +
    `mail ${config.mail.kind === "smtp" ? "over SMTP" : "written to this log"}, ` +
    `checks every ${String(openEventCheckIntervalMs / 60_000)} minutes while an event is open, ` +
    `${consolePresent ? `console served from ${config.webDirectory}` : `no console at ${config.webDirectory}, so the API is served alone`}`,
);
