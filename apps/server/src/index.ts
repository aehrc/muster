/**
 * The server's entry point.
 *
 * Two things run from here: the server, and the `migrate` command the deployment's
 * pre-install hook invokes. The command is dispatched before the configuration is
 * resolved, because it needs less than the server does - a migration uses a connection
 * and nothing else, and demanding a public URL and a master key to run one would be an
 * operator told off by name for omitting something the command never reads.
 *
 * Author: John Grimes
 */

import { serve } from "@hono/node-server";
import { createDatabase } from "@muster/db";

import { createApp } from "./app.js";
import {
  ConfigError,
  loadConfig,
  resolveDatabaseUrl,
  resolveMigrationIdentities,
} from "./config.js";
import { createRateLimitStore } from "./http/rateLimit.js";
import {
  createMailTransport,
  describeMailTransport,
} from "./mail/transport.js";
import { runMigrateCommand } from "./migrate.js";
import { checkCadence, startCheckScheduler } from "./scheduler/scheduler.js";
import { runSeedCommand, seedOptionsFrom } from "./seed.js";

/** Reports a problem the way an operator can act on, and stops. */
function fail(prefix: string, error: unknown): never {
  console.error(
    error instanceof ConfigError
      ? `Muster configuration error: ${error.message}`
      : `${prefix}: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}

if (process.argv[2] === "migrate") {
  try {
    const identities = resolveMigrationIdentities(process.env);
    await runMigrateCommand(identities.ownerUrl, identities.servingRole);
  } catch (error) {
    fail("Muster migration failed", error);
  }
  process.exit(0);
}

// The first admin and the first event. Dispatched here, and reachable over no route, because
// every route that could create an admin requires already being one. See `./seed.ts`.
if (process.argv[2] === "seed") {
  const handle = (() => {
    try {
      return createDatabase({
        url: resolveDatabaseUrl(process.env),
        applicationName: "muster-seed",
      });
    } catch (error) {
      return fail("Muster could not seed", error);
    }
  })();
  try {
    await runSeedCommand(handle.db, seedOptionsFrom(process.env), new Date());
  } catch (error) {
    await handle.close();
    fail("Muster seeding failed", error);
  }
  await handle.close();
  process.exit(0);
}

let config;
try {
  config = loadConfig(process.env);
} catch (error) {
  fail("Muster could not start", error);
}

const { db, close } = createDatabase({
  url: config.databaseUrl,
  applicationName: "muster",
});

const app = createApp({
  config,
  db,
  mail: createMailTransport({
    smtpUrl: config.smtpUrl,
    from: config.mailFrom,
  }),
  rateLimits: createRateLimitStore(),
  clock: () => new Date(),
});

// Reported at startup rather than left to be discovered: a deployment that believes it
// is sending mail and is only logging it has an approval queue nobody is told about.
// The description never contains the credential in the SMTP URL.
console.log(`Muster mail transport: ${describeMailTransport(config.smtpUrl)}`);

// The liveness checks, on an in-process interval in this one instance - which is why the
// Helm chart pins `replicas: 1`. The first pass runs immediately, so a restart mid-event
// does not leave every entry stale for a whole interval, and what it did is logged rather
// than left to be inferred (FR-037).
const checks = startCheckScheduler({
  db,
  clock: () => new Date(),
  allowedHosts: config.outboundAllowedHosts,
  cadence: checkCadence(config.checkIntervalMs),
  log: (message) => {
    console.warn(message);
  },
});
void checks.firstPass.then((summary) => {
  console.log(`Muster check pass: ${JSON.stringify(summary)}`);
});

const server = serve({ fetch: app.fetch, port: config.port }, (address) => {
  console.log(
    `Muster listening on port ${String(address.port)}, public URL ${config.publicUrl}`,
  );
});

/**
 * Stops the scheduler, then accepting connections, then releases the database pool.
 *
 * In that order: closing the pool first would fail every request already in flight,
 * including one part-way through recording a pairing transition, and a check pass that
 * started after the pool closed would log a failure nobody caused.
 */
async function shutdown(signal: string): Promise<void> {
  console.log(`Muster shutting down on ${signal}`);
  checks.stop();
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  await close();
  process.exit(0);
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    void shutdown(signal);
  });
}
