/**
 * The server's entry point.
 *
 * A placeholder, and deliberately the smallest one that can be deployed: it answers
 * the liveness probe the container image and the compose stack are wired to, so the
 * image can be built, started and proved before there is anything to serve. The
 * routing, the error envelope and the configuration loader arrive with the
 * foundational phase, which replaces the body of this file with the real app factory.
 *
 * Author: John Grimes
 */

import { serve } from "@hono/node-server";
import { Hono } from "hono";

import { ConfigError, resolveMigrationIdentities } from "./config.js";
import { runMigrateCommand } from "./migrate.js";

// The commands are dispatched before the server's configuration is resolved, because
// each needs less than the server does: a migration uses a connection and nothing
// else, and demanding a public URL and a master key to run one would be an operator
// told off by name for omitting something the command never reads.
if (process.argv[2] === "migrate") {
  try {
    const identities = resolveMigrationIdentities(process.env);
    await runMigrateCommand(identities.ownerUrl, identities.servingRole);
  } catch (error) {
    console.error(
      error instanceof ConfigError
        ? `Muster configuration error: ${error.message}`
        : `Muster migration failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
  process.exit(0);
}

const app = new Hono();

// The only route the image's HEALTHCHECK and the compose stack's `--wait` need.
app.get("/healthz", (context) => context.json({ status: "ok" }));

const port = Number(process.env["PORT"] ?? "3000");

serve({ fetch: app.fetch, port }, (address) => {
  console.log(`Muster listening on port ${address.port}`);
});
