#!/usr/bin/env bun
/*
 * Copyright © 2026 Commonwealth Scientific and Industrial Research Organisation
 * (CSIRO) ABN 41 687 119 230. Licensed under the Apache License, Version 2.0.
 */

import { SQL } from "bun";

import { authoriseParticipantEndpoints } from "@muster/core";
import {
  describeConnection,
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
 * Usage: `bun run stack:seed` against the compose stack, which reads
 * `deploy/stack.env`; or `bun scripts/seed.ts` with the same environment the
 * server reads, against any other database.
 * `MUSTER_SEED_ADMIN_EMAIL` and `MUSTER_SEED_ADMIN_PASSWORD` override the
 * defaults, `MUSTER_SEED_EVENT_SLUG` names the event and
 * `MUSTER_SEED_PERSONA_SOURCE_URL` names the FHIR server its personas are
 * curated from.
 *
 * @author John Grimes
 */

/** The event seeded when the environment does not name one. */
const defaultEventSlug = "sparked-2026-09";

/**
 * The FHIR server the seeded event curates its personas from.
 *
 * The Sparked AU Core reference server, which permits anonymous reads and whose
 * test patients carry test IHIs (US7). `MUSTER_SEED_PERSONA_SOURCE_URL`
 * overrides it for a deployment that curates from somewhere else.
 */
const defaultPersonaSourceUrl = "https://aucore.aidbox.beda.software/fhir";

/** The capability tags the seeded event defines. */
const seedCapabilityTags = [
  "form renderer host",
  "form filler",
  "questionnaire author",
  "data holder",
];

/**
 * A calendar day relative to today, as `YYYY-MM-DD`.
 *
 * The seeded event is dated from the day it is seeded, so vouching for it never
 * lapses on a stack that was set up from an old checkout.
 *
 * @param offsetDays - days from today
 * @returns the day in UTC
 */
const dayFromToday = (offsetDays: number): string =>
  new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

const config = loadConfig(process.env);
const adminEmail =
  process.env["MUSTER_SEED_ADMIN_EMAIL"] ?? "admin@example.org";
const adminPassword =
  process.env["MUSTER_SEED_ADMIN_PASSWORD"] ?? "muster-admin-password";
const eventSlug = process.env["MUSTER_SEED_EVENT_SLUG"] ?? defaultEventSlug;
const personaSourceUrl =
  process.env["MUSTER_SEED_PERSONA_SOURCE_URL"] ?? defaultPersonaSourceUrl;

// The same rule the routes apply: a persona source Muster could not fetch is
// refused here rather than written into an event for a check to trip over later.
const sourceDecision = authoriseParticipantEndpoints(
  { personaSourceUrl },
  config.outbound.allowedHosts,
);
if (!sourceDecision.ok) {
  console.error(sourceDecision.refusal.detail);
  process.exit(1);
}

// Said rather than assumed: `bun --env-file` leaves a variable the shell already
// exports alone, so which database this is going to is worth stating. The URL
// itself is not logged - it carries a password.
console.log(
  `Seeding ${describeConnection(config.migrationDatabaseUrl)} ` +
    `with the admin account ${adminEmail} and the event ${eventSlug}.`,
);

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
      name: "Sparked FHIR Connectathon",
      startsOn: dayFromToday(0),
      endsOn: dayFromToday(2),
      status: "open",
      capabilityTags: seedCapabilityTags,
      personaSourceUrl,
      graceDays: 7,
    });
    console.log(
      `Created the open event ${event.slug} with tags: ${event.capabilityTags.join(", ")}.`,
    );
  } else if (
    existingEvent.status !== "open" ||
    existingEvent.personaSourceUrl !== personaSourceUrl
  ) {
    const updated = await updateEvent(sql, eventSlug, {
      status: "open",
      personaSourceUrl,
    });
    console.log(
      `Opened the existing event ${String(updated?.slug)} and set its persona source.`,
    );
  } else {
    console.log(`The open event ${eventSlug} already exists.`);
  }
} finally {
  await sql.end();
}
