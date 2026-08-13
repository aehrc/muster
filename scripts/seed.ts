/**
 * Seeds a Muster database with a track admin and an open event.
 *
 * The same work the server's `seed` subcommand does - `apps/server/src/seed.ts` holds it - reached
 * from the host rather than from inside the container, which is what `bun run stack:seed` needs and
 * what a developer running the server with `bun run dev` wants.
 *
 * Nothing but wiring lives here: the connection, the clock and the exit code. Everything worth
 * testing is in the module it calls.
 *
 * Author: John Grimes
 */

import { resolveDatabaseUrl } from "../apps/server/src/config.js";
import { runSeedCommand, seedOptionsFrom } from "../apps/server/src/seed.js";
import { createDatabase } from "../packages/db/src/index.js";

const handle = createDatabase({
  url: resolveDatabaseUrl(process.env),
  applicationName: "muster-seed",
});

try {
  await runSeedCommand(handle.db, seedOptionsFrom(process.env), new Date());
} catch (error) {
  console.error(
    `Muster seeding failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  await handle.close();
  process.exit(1);
}

await handle.close();
