import { defineConfig } from "drizzle-kit";

/**
 * Drizzle Kit configuration.
 *
 * Generation only ever writes SQL into `migrations/`; applying them is the job
 * of the runner in `src/migrations.ts`, which uses the owner role. The URL is
 * therefore the migration (owner) URL, never the serving URL.
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema",
  out: "./migrations",
  casing: "snake_case",
  strict: true,
  verbose: true,
  dbCredentials: {
    url: process.env["MUSTER_MIGRATION_DATABASE_URL"] ?? "",
  },
});
