/**
 * drizzle-kit configuration.
 *
 * `generate` diffs the schema modules against the recorded snapshot and needs no
 * database; the credentials below exist only for `migrate` and `studio`. There is no
 * fallback URL, deliberately: a default would let either command silently address
 * the wrong server.
 *
 * The variable is the owning identity's, because both commands issue DDL. The
 * serving role cannot.
 *
 * Author: John Grimes
 */

import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env["MUSTER_DATABASE_OWNER_URL"] ?? "",
  },
  // Refuse to apply a destructive statement without an explicit confirmation: a
  // dropped column in this schema is a dropped credential or audit record.
  strict: true,
  verbose: true,
});
