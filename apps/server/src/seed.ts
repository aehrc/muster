/**
 * The `seed` command: a track admin and an open event, from nothing.
 *
 * Every other way into Muster requires somebody already being in it. An admin approves members, and
 * admins are approved by admins; an event is created by an admin. So the first admin and the first
 * event come from here, and from nowhere reachable over HTTP - which is the point rather than an
 * inconvenience, because a route that could create an admin without one would be the whole security
 * model's single point of failure.
 *
 * Idempotent, so it can be run before every end-to-end suite without tearing the stack down. An
 * account that already exists keeps its password and gains admin standing; an event that already
 * exists is opened if it is still a draft and otherwise left alone.
 *
 * What it does not do is print the password. The operator supplied it, the log is a place a
 * credential must not appear (FR-036), and a seed that echoed it back would put it in whatever
 * captured the command's output.
 *
 * Author: John Grimes
 */

import { canChangeEventStatus, foldEmail } from "@muster/core";
import {
  findEventBySlug,
  insertEvent,
  updateEvent,
  upsertAdminAccount,
} from "@muster/db";

import { hashPassword } from "./auth/passwords.js";

import type { Database, EventRow } from "@muster/db";

/** What the seed creates. */
export interface SeedOptions {
  readonly adminEmail: string;
  readonly adminDisplayName: string;
  readonly adminPassword: string;
  readonly eventSlug: string;
  readonly eventName: string;
  readonly startsOn: string;
  readonly endsOn: string;
  readonly capabilityTags: readonly string[];
  readonly personaSourceUrl: string | null;
  readonly graceDays: number;
}

/**
 * The values quickstart scenario 1 names.
 *
 * Written here rather than in the script, so that the end-to-end suite and a developer following the
 * quickstart get the same event without either of them restating it.
 */
export const QUICKSTART_SEED: SeedOptions = {
  adminEmail: "admin@muster.test",
  adminDisplayName: "Track Admin",
  adminPassword: "correct horse battery staple",
  eventSlug: "sparked-2026-09",
  eventName: "Sparked Connectathon September 2026",
  startsOn: "2026-09-15",
  endsOn: "2026-09-19",
  capabilityTags: [
    "smart-app-host",
    "smart-app",
    "form-renderer-host",
    "form-renderer-app",
  ],
  personaSourceUrl: "https://smile.sparked-fhir.com/aucore/fhir/DEFAULT",
  graceDays: 7,
};

/**
 * Reads the seed's values from the environment, falling back to the quickstart's.
 *
 * @param env - The environment to read.
 * @returns The options, with every field settled.
 * @example
 * ```ts
 * await runSeedCommand(db, seedOptionsFrom(process.env), new Date());
 * ```
 */
export function seedOptionsFrom(
  env: Readonly<Record<string, string | undefined>>,
): SeedOptions {
  const read = (name: string): string | undefined => {
    const value = env[name];
    return value === undefined || value.trim().length === 0 ? undefined : value;
  };
  const tags = read("MUSTER_SEED_CAPABILITY_TAGS");
  return {
    adminEmail: read("MUSTER_SEED_ADMIN_EMAIL") ?? QUICKSTART_SEED.adminEmail,
    adminDisplayName:
      read("MUSTER_SEED_ADMIN_NAME") ?? QUICKSTART_SEED.adminDisplayName,
    adminPassword:
      read("MUSTER_SEED_ADMIN_PASSWORD") ?? QUICKSTART_SEED.adminPassword,
    eventSlug: read("MUSTER_SEED_EVENT_SLUG") ?? QUICKSTART_SEED.eventSlug,
    eventName: read("MUSTER_SEED_EVENT_NAME") ?? QUICKSTART_SEED.eventName,
    startsOn: read("MUSTER_SEED_EVENT_STARTS_ON") ?? QUICKSTART_SEED.startsOn,
    endsOn: read("MUSTER_SEED_EVENT_ENDS_ON") ?? QUICKSTART_SEED.endsOn,
    capabilityTags:
      tags === undefined
        ? QUICKSTART_SEED.capabilityTags
        : tags
            .split(",")
            .map((tag) => tag.trim().toLowerCase())
            .filter((tag) => tag.length > 0),
    personaSourceUrl:
      read("MUSTER_SEED_PERSONA_SOURCE_URL") ??
      QUICKSTART_SEED.personaSourceUrl,
    graceDays: Number(
      read("MUSTER_SEED_GRACE_DAYS") ?? String(QUICKSTART_SEED.graceDays),
    ),
  };
}

/**
 * Creates the admin and the open event, reporting what it did.
 *
 * @param db - An open connection. The serving role is enough: this is all data, no DDL.
 * @param options - What to create.
 * @param now - The current time.
 * @param log - Where to report. Defaults to the console.
 * @throws {Error} When the event cannot be created or opened - a seed that reported success having
 *   created nothing is worse than one that fails.
 * @example
 * ```ts
 * await runSeedCommand(handle.db, seedOptionsFrom(process.env), new Date());
 * ```
 */
export async function runSeedCommand(
  db: Database,
  options: SeedOptions,
  now: Date,
  log: (message: string) => void = console.log,
): Promise<void> {
  const admin = await upsertAdminAccount(db, {
    email: foldEmail(options.adminEmail),
    displayName: options.adminDisplayName,
    passwordHash: await hashPassword(options.adminPassword),
    now,
  });
  log(
    admin.created
      ? `Created track admin ${admin.account.email}`
      : `${admin.account.email} already existed and is now a track admin (its password is unchanged)`,
  );

  const existing = await findEventBySlug(db, options.eventSlug);
  const before =
    existing ??
    (await insertEvent(db, {
      slug: options.eventSlug,
      name: options.eventName,
      startsOn: options.startsOn,
      endsOn: options.endsOn,
      capabilityTags: [...options.capabilityTags],
      personaSourceUrl: options.personaSourceUrl,
      graceDays: options.graceDays,
    }));
  log(
    existing === undefined
      ? `Created event ${before.slug}`
      : `Event ${before.slug} already existed (${before.status})`,
  );

  const opened = await openForEnrolment(db, before, now);
  log(
    `Event ${opened.slug} is ${opened.status}, with tags ${opened.capabilityTags.join(", ")}`,
  );
}

/**
 * Opens an event that is not open yet.
 *
 * The transition is `canChangeEventStatus`'s decision, asked here as it is asked in the route:
 * `draft -> open` is allowed and `closed -> open` is not, because closing lapses open pairings and
 * stops minting and nothing undoes those. A seed that quietly re-opened a closed event would
 * resurrect the previous gathering.
 *
 * @throws {Error} When the event cannot be opened, naming the status it is in.
 */
async function openForEnrolment(
  db: Database,
  event: EventRow,
  now: Date,
): Promise<EventRow> {
  if (event.status === "open") {
    return event;
  }
  if (!canChangeEventStatus(event.status, "open")) {
    throw new Error(
      `the event ${event.slug} is ${event.status} and could not be opened for enrolment; a closed event stays closed, and a new gathering is a new event`,
    );
  }
  const opened = await updateEvent(db, {
    slug: event.slug,
    patch: { status: "open" },
    now,
  });
  if (opened === undefined) {
    throw new Error(
      `the event ${event.slug} could not be opened for enrolment; it disappeared between statements`,
    );
  }
  return opened;
}
