/**
 * The `seed` command, against a real database.
 *
 * Two things matter about a seed and neither is "it inserts rows". It has to be runnable twice - the
 * end-to-end suite runs it before every pass, against a stack that is already up - and it must not
 * reset a password on the second run, because that would silently change a credential an operator
 * had already replaced.
 *
 * Author: John Grimes
 */

import {
  findAccountByEmail,
  findEventBySlug,
  hasTestDatabase,
  uniqueSuffix,
} from "@muster/db";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import { verifyPassword } from "./auth/passwords.js";
import { QUICKSTART_SEED, runSeedCommand, seedOptionsFrom } from "./seed.js";
import { createTestStack } from "./test/harness.js";

import type { SeedOptions } from "./seed.js";
import type { TestStack } from "./test/harness.js";

describe("seedOptionsFrom", () => {
  it("falls back to the values the quickstart names", () => {
    // The quickstart says `bun run stack:seed` produces an open event "sparked-2026-09" with
    // tags, so an operator who configures nothing must get exactly that.
    expect(seedOptionsFrom({})).toEqual(QUICKSTART_SEED);
  });

  it("takes every value from the environment when it is given one", () => {
    const options = seedOptionsFrom({
      MUSTER_SEED_ADMIN_EMAIL: "priya@example.org",
      MUSTER_SEED_ADMIN_NAME: "Priya Nair",
      MUSTER_SEED_ADMIN_PASSWORD: "a much longer password",
      MUSTER_SEED_EVENT_SLUG: "sparked-2025-12",
      MUSTER_SEED_EVENT_NAME: "December",
      MUSTER_SEED_EVENT_STARTS_ON: "2025-12-01",
      MUSTER_SEED_EVENT_ENDS_ON: "2025-12-05",
      MUSTER_SEED_CAPABILITY_TAGS: " Smart-App-Host , smart-app ,, ",
      MUSTER_SEED_PERSONA_SOURCE_URL: "https://source.example/fhir",
      MUSTER_SEED_GRACE_DAYS: "14",
    });

    expect(options.adminEmail).toBe("priya@example.org");
    expect(options.eventSlug).toBe("sparked-2025-12");
    // Folded and cleaned: two spellings of one tag would split every filter that uses it.
    expect(options.capabilityTags).toEqual(["smart-app-host", "smart-app"]);
    expect(options.graceDays).toBe(14);
  });

  it("treats a variable exported but cleared as absent", () => {
    // An exported-but-empty variable arrives as an empty string, and reading that as a slug
    // would produce an event nobody can address.
    expect(seedOptionsFrom({ MUSTER_SEED_EVENT_SLUG: "  " }).eventSlug).toBe(
      QUICKSTART_SEED.eventSlug,
    );
  });
});

describe.skipIf(!hasTestDatabase())("runSeedCommand", () => {
  let stack: TestStack;

  beforeAll(async () => {
    stack = await createTestStack();
  });

  afterAll(async () => {
    await stack.close();
  });

  /** Seed options unique to one test, so two of them do not meet. */
  function options(overrides: Partial<SeedOptions> = {}): SeedOptions {
    const suffix = uniqueSuffix();
    return {
      ...QUICKSTART_SEED,
      adminEmail: `seed-admin-${suffix}@muster.test`,
      eventSlug: `seed-event-${suffix}`,
      ...overrides,
    };
  }

  const NOW = new Date("2026-09-01T10:00:00.000Z");

  it("creates a verified, approved admin and an open event", async () => {
    const settings = options();
    const log: string[] = [];

    await runSeedCommand(stack.db, settings, NOW, (message) => {
      log.push(message);
    });

    const admin = await findAccountByEmail(stack.db, settings.adminEmail);
    const event = await findEventBySlug(stack.db, settings.eventSlug);
    expect(admin?.isAdmin).toBe(true);
    expect(admin?.status).toBe("approved");
    // Verified, because an unverified account cannot do anything - including approve the first
    // member who signs up.
    expect(admin?.emailVerifiedAt).toEqual(NOW);
    expect(event?.status).toBe("open");
    expect(event?.capabilityTags).toEqual([...settings.capabilityTags]);
    // An operator reads the command's output to find out what it did.
    expect(log.join("\n")).toContain(settings.eventSlug);
  });

  it("hashes the admin's password so it can be signed in with", async () => {
    const settings = options();
    await runSeedCommand(stack.db, settings, NOW, () => {});

    const admin = await findAccountByEmail(stack.db, settings.adminEmail);

    expect(
      await verifyPassword(settings.adminPassword, admin?.passwordHash ?? ""),
    ).toBe(true);
    // argon2id and nothing else, per the constitution.
    expect(admin?.passwordHash).toContain("$argon2id$");
  });

  it("is a no-op the second time, and does not reset the password", async () => {
    const settings = options();
    await runSeedCommand(stack.db, settings, NOW, () => {});
    const first = await findAccountByEmail(stack.db, settings.adminEmail);

    await runSeedCommand(
      stack.db,
      { ...settings, adminPassword: "a completely different password" },
      new Date("2026-09-02T10:00:00.000Z"),
      () => {},
    );
    const second = await findAccountByEmail(stack.db, settings.adminEmail);

    // The end-to-end suite runs the seed before every pass. A second run that reset a
    // credential would silently undo an operator's own change.
    expect(second?.passwordHash).toBe(first?.passwordHash);
    expect(second?.emailVerifiedAt).toEqual(NOW);
  });

  it("makes an existing ordinary account an admin without touching its password", async () => {
    const member = await stack.makeMember({ displayName: "Already Here" });
    const settings = options({ adminEmail: member.email });

    await runSeedCommand(stack.db, settings, NOW, () => {});

    const promoted = await findAccountByEmail(stack.db, member.email);
    expect(promoted?.isAdmin).toBe(true);
    expect(promoted?.passwordHash).toBe(member.passwordHash);
  });

  it("leaves a closed event closed rather than re-opening it", async () => {
    const settings = options();
    await runSeedCommand(stack.db, settings, NOW, () => {});
    await stack.app.request(`/api/admin/events/${settings.eventSlug}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        cookie: stack.adminCookie,
      },
      body: JSON.stringify({ status: "closed" }),
    });

    // Re-opening a closed event is refused by the state machine, so the seed has to fail
    // rather than report an open event it did not open.
    await expect(
      runSeedCommand(stack.db, settings, NOW, () => {}),
    ).rejects.toThrow(/could not be opened/);
    expect((await findEventBySlug(stack.db, settings.eventSlug))?.status).toBe(
      "closed",
    );
  });
});
