#!/usr/bin/env bun
import { SQL } from "bun";

import {
  findAccountByEmail,
  findEventBySlug,
  insertAccount,
  insertEvent,
  markAccountVerified,
  runMigrations,
  updateAccountStatus,
  updateEvent,
} from "@muster/db";

import { loadConfig } from "../apps/server/src/config.ts";

/**
 * Seeds a database with the admin account and the open event that quickstart
 * scenario 1 starts from.
 *
 * Idempotent: run it twice and nothing doubles up, because a stack that has to
 * be torn down before it can be reseeded is a stack nobody reseeds. The admin's
 * address is verified and its membership approved directly - it is the account
 * that approves everyone else, so nobody is left with a chicken-and-egg problem.
 *
 * Usage: `bun scripts/seed.ts`, with the same environment the server reads.
 * `MUSTER_SEED_ADMIN_EMAIL` and `MUSTER_SEED_ADMIN_PASSWORD` override the
 * defaults, and `MUSTER_SEED_EVENT_SLUG` names the event.
 *
 * @author John Grimes
 */

/** The event seeded when the environment does not name one. */
const defaultEventSlug = "sparked-2026-09";

/** The capability tags the seeded event defines. */
const seedCapabilityTags = [
  "form renderer host",
  "form filler",
  "questionnaire author",
  "data holder",
];

const config = loadConfig(process.env);
const adminEmail =
  process.env["MUSTER_SEED_ADMIN_EMAIL"] ?? "admin@example.org";
const adminPassword =
  process.env["MUSTER_SEED_ADMIN_PASSWORD"] ?? "muster-admin-password";
const eventSlug = process.env["MUSTER_SEED_EVENT_SLUG"] ?? defaultEventSlug;

const sql = new SQL(config.migrationDatabaseUrl);
try {
  const migrated = await runMigrations({
    sql,
    directory: config.migrationsDirectory,
  });
  console.log(
    `Applied ${String(migrated.applied.length)} migration(s); ` +
      `${String(migrated.alreadyApplied.length)} were already present.`,
  );

  const existingAdmin = await findAccountByEmail(sql, adminEmail);
  if (existingAdmin === undefined) {
    const admin = await insertAccount(sql, {
      email: adminEmail,
      displayName: "Track Admin",
      passwordHash: await Bun.password.hash(adminPassword, "argon2id"),
      isAdmin: true,
    });
    await markAccountVerified(sql, admin.id, new Date());
    await updateAccountStatus(sql, {
      accountId: admin.id,
      status: "approved",
      decidedBy: admin.id,
      decidedAt: new Date(),
    });
    console.log(`Created the admin account ${adminEmail}.`);
  } else {
    console.log(`The admin account ${adminEmail} already exists.`);
  }

  const existingEvent = await findEventBySlug(sql, eventSlug);
  if (existingEvent === undefined) {
    const event = await insertEvent(sql, {
      slug: eventSlug,
      name: "Sparked FHIR Connectathon, September 2026",
      startsOn: "2026-09-01",
      endsOn: "2026-09-03",
      status: "open",
      capabilityTags: seedCapabilityTags,
      graceDays: 7,
    });
    console.log(
      `Created the open event ${event.slug} with tags: ${event.capabilityTags.join(", ")}.`,
    );
  } else if (existingEvent.status !== "open") {
    const opened = await updateEvent(sql, eventSlug, { status: "open" });
    console.log(`Opened the existing event ${String(opened?.slug)}.`);
  } else {
    console.log(`The open event ${eventSlug} already exists.`);
  }
} finally {
  await sql.end();
}
