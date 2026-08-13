/**
 * Fixtures for the suites that need real rows.
 *
 * Every fixture is named uniquely, and nothing here empties a table. The test database is
 * shared by every suite in a run and by a second `bun test` against the same database, so
 * a suite that truncated would break both - and a suite that reused a fixed address would
 * collide with whichever other suite got there first. The suffix carries the process
 * identifier, so two runs at once do not meet either.
 *
 * The fixtures go through the repositories rather than writing rows, so that a change
 * breaking account creation breaks the fixtures too rather than being discovered later by
 * a suite that cannot explain itself.
 *
 * Author: John Grimes
 */

import { foldEmail } from "@muster/core";
import { eq } from "drizzle-orm";

import {
  insertAccount,
  insertEvent,
  insertOrganisationWithFirstMember,
  insertSystem,
  setAccountStatus,
  updateEvent,
  upsertEnrolment,
} from "../repositories/directory.js";
import { account } from "../schema/directory.js";

import type { Executor } from "../executor.js";
import type {
  AccountRow,
  EnrolmentRow,
  EventRow,
  OrganisationRow,
  SystemRow,
} from "../schema/directory.js";
import type {
  ClientProfile,
  EventInput,
  ServerProfile,
} from "@muster/contracts";
import type { AccountStatus, EventStatus } from "@muster/core";

/** How many fixtures this process has made. */
let sequence = 0;

/**
 * A suffix no other fixture in any concurrent run will use.
 *
 * @returns A short, unique string.
 * @example
 * ```ts
 * const slug = `event-${uniqueSuffix()}`;
 * ```
 */
export function uniqueSuffix(): string {
  sequence += 1;
  return `${String(process.pid)}-${String(sequence)}`;
}

/** The password every fixture account holds. Not a secret; it names a throwaway row. */
export const TEST_PASSWORD_HASH = "argon2id$fixture-not-a-real-hash";

/** What a fixture account should look like. */
export interface AccountFixture {
  /** Defaults to a unique address. */
  readonly email?: string;
  readonly displayName?: string;
  /** Defaults to `approved`, which is what most suites need. */
  readonly status?: AccountStatus;
  /** Defaults to verified, because an unverified account can do nothing. */
  readonly verified?: boolean;
  readonly isAdmin?: boolean;
  /** Defaults to a placeholder no password matches. Set it to sign in as the fixture. */
  readonly passwordHash?: string;
  readonly now?: Date;
}

/**
 * Creates an account.
 *
 * @param db - The executor.
 * @param fixture - What to override. Everything has a working default.
 * @returns The account.
 * @throws {Error} When the address is already held, which for a unique default cannot
 *   happen and for a caller-supplied one is worth failing loudly over.
 */
export async function makeAccount(
  db: Executor,
  fixture: AccountFixture = {},
): Promise<AccountRow> {
  const now = fixture.now ?? new Date();
  const created = await insertAccount(db, {
    email: foldEmail(fixture.email ?? `member-${uniqueSuffix()}@muster.test`),
    displayName: fixture.displayName ?? "Fixture Member",
    passwordHash: fixture.passwordHash ?? TEST_PASSWORD_HASH,
  });
  if (!created.ok) {
    throw new Error("fixture account address is already held");
  }

  const status = fixture.status ?? "approved";
  const verified = fixture.verified ?? true;
  // Written directly rather than through the repositories: verification and approval each
  // have their own route with its own notification, and a fixture that went through them
  // would be asserting those routes rather than arranging a state.
  const rows = await db
    .update(account)
    .set({
      ...(verified ? { emailVerifiedAt: now } : {}),
      status,
      isAdmin: fixture.isAdmin ?? false,
      updatedAt: now,
    })
    .where(eq(account.id, created.account.id))
    .returning();
  const updated = rows[0];
  if (updated === undefined) {
    throw new Error("fixture account disappeared between statements");
  }
  return updated;
}

/**
 * Creates an organisation with one member.
 *
 * @param db - The executor.
 * @param accountId - Its first member.
 * @param name - Defaults to a unique name.
 */
export async function makeOrganisation(
  db: Executor,
  accountId: string,
  name?: string,
): Promise<OrganisationRow> {
  return await insertOrganisationWithFirstMember(db, {
    name: name ?? `Organisation ${uniqueSuffix()}`,
    accountId,
  });
}

/** A server profile a fixture system can carry. */
export function serverProfileFixture(
  overrides: Partial<ServerProfile> = {},
): ServerProfile {
  return {
    fhirBaseUrl: "https://fhir.muster.test/r4",
    authorizationMode: "smart",
    registrationMode: "manual",
    registrationEndpoint: null,
    notes: "",
    ...overrides,
  };
}

/** A client profile a fixture system can carry. */
export function clientProfileFixture(
  overrides: Partial<ClientProfile> = {},
): ClientProfile {
  return {
    launchUrl: "https://app.muster.test/launch",
    redirectUris: ["https://app.muster.test/callback"],
    scopes: ["launch", "openid", "fhirUser"],
    confidentiality: "public",
    launchContext: "",
    needsIntrospection: false,
    ...overrides,
  };
}

/**
 * Creates a system owned by an organisation.
 *
 * Defaults to a server, because the server side is what the event view and the checks are
 * mostly about.
 */
export async function makeSystem(
  db: Executor,
  organisationId: string,
  overrides: {
    readonly name?: string;
    readonly serverProfile?: ServerProfile | null;
    readonly clientProfile?: ClientProfile | null;
  } = {},
): Promise<SystemRow> {
  return await insertSystem(db, {
    organisationId,
    system: {
      name: overrides.name ?? `System ${uniqueSuffix()}`,
      description: "",
      serverProfile:
        overrides.serverProfile === undefined
          ? serverProfileFixture()
          : overrides.serverProfile,
      clientProfile: overrides.clientProfile ?? null,
    },
  });
}

/** Creates an event. Defaults to a draft, so a suite says when it is open. */
export async function makeEvent(
  db: Executor,
  overrides: Partial<EventInput> & { readonly status?: EventStatus } = {},
): Promise<EventRow> {
  const created = await insertEvent(db, {
    slug: overrides.slug ?? `event-${uniqueSuffix()}`,
    name: overrides.name ?? "Fixture Connectathon",
    startsOn: overrides.startsOn ?? "2026-09-15",
    endsOn: overrides.endsOn ?? "2026-09-19",
    capabilityTags: overrides.capabilityTags ?? ["smart-app-host", "smart-app"],
    personaSourceUrl: overrides.personaSourceUrl ?? null,
    graceDays: overrides.graceDays ?? 7,
  });
  if (overrides.status === undefined || overrides.status === "draft") {
    return created;
  }
  // Written through the repository rather than by hand, so a suite that arranges a closed
  // event gets the same row an admin's PATCH would leave behind.
  const moved = await updateEvent(db, {
    slug: created.slug,
    patch: { status: overrides.status },
    now: new Date(),
  });
  if (moved === undefined) {
    throw new Error("fixture event disappeared between statements");
  }
  return moved;
}

/** What a fixture enrolment records. */
export interface EnrolmentFixture {
  /** The event, which must be open. */
  readonly event: EventRow;
  readonly systemId: string;
  /** Who is confirming the details are current. */
  readonly accountId: string;
  readonly tags?: readonly string[];
  readonly now?: Date;
}

/**
 * Enrols a system in an event.
 *
 * The event must be open, because `upsertEnrolment` refuses anything else (FR-011) - which is
 * exactly the rule a fixture must not be able to sidestep.
 *
 * @param db - The executor.
 * @param input - The open event, the system, who is confirming and any tags.
 * @returns The enrolment.
 * @throws {Error} When the enrolment was refused, naming the reason.
 */
export async function makeEnrolment(
  db: Executor,
  input: EnrolmentFixture,
): Promise<EnrolmentRow> {
  const written = await upsertEnrolment(db, {
    event: input.event,
    systemId: input.systemId,
    tags: input.tags ?? [],
    confirmedBy: input.accountId,
    confirmedAt: input.now ?? new Date(),
  });
  if (!written.ok) {
    throw new Error(`fixture enrolment was refused: ${written.reason}`);
  }
  return written.enrolment;
}

/** Approves an account, as an admin would. */
export async function approve(
  db: Executor,
  accountId: string,
  adminId: string,
  now = new Date(),
): Promise<AccountRow | undefined> {
  return await setAccountStatus(db, {
    accountId,
    status: "approved",
    decidedBy: adminId,
    now,
  });
}
