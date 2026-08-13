/**
 * The integration harness: a real Postgres, the real application, no socket.
 *
 * The unit suites cover every pure judgement the directory makes. What they cannot cover is
 * the wiring - that the guard is attached to the route, that the projection is the one the
 * handler returned, that the cookie the browser gets back resolves to the account that signed
 * in. Those are properties of the composition, so they are asserted against the composition:
 * the application is driven through `app.request()`, which exercises routing, middleware and
 * body parsing exactly as a socket would.
 *
 * Skipped unless `MUSTER_TEST_DATABASE_URL` names a database that may be migrated. CI provides
 * one, so a skip there is a failure of the workflow rather than an accepted state.
 *
 * Fixtures are named uniquely rather than created and truncated. The tables are shared with
 * every other suite in the run and with a second `bun test` against the same database, and a
 * suite that emptied them would break both.
 *
 * The mail transport records instead of sending, and every suite that asserts a notification
 * reads it. That is not only convenience: FR-003 is a promise about messages, and a harness
 * that discarded them would let the promise be broken silently.
 *
 * Author: John Grimes
 */

import { createDatabase, makeAccount, uniqueSuffix } from "@muster/db";
import {
  prepareTestDatabase,
  servingRoleUrl,
  testDatabaseUrl,
} from "@muster/db";

import { createApp } from "../app.js";
import { hashPassword } from "../auth/passwords.js";
import {
  createRateLimitStore,
  createUnlimitedStore,
} from "../http/rateLimit.js";
import { ensureSigningKeys } from "../keys/keys.js";

import type { MusterConfig } from "../config.js";
import type {
  MusterEnvironment,
  OutboundInjection,
  ServerContext,
} from "../context.js";
import type { MailMessage } from "../mail/transport.js";
import type { AccountRow, Database } from "@muster/db";
import type { Hono } from "hono";

/** The deployment's public URL in every suite. `https`, so cookies must be `Secure`. */
export const TEST_PUBLIC_URL = "https://muster.test";

/** The password every fixture account signs in with. It names a throwaway row. */
export const TEST_PASSWORD = "correct horse battery staple";

/** How the stack should behave where a suite has a choice. */
export interface TestStackOptions {
  /**
   * Whether the credential routes are limited.
   *
   * Unlimited by default: the suites drive far more sign-ins per frozen minute than a person
   * could. A suite whose subject is the limiter asks for the real thing.
   */
  readonly rateLimits?: "enforced" | "unlimited";
  /** Whether the mail transport refuses everything, for the notification-failure cases. */
  readonly mail?: "recording" | "failing";
  /**
   * The transport and resolver the outbound guard uses.
   *
   * A suite whose subject is what a route does with a participant server's answer supplies
   * one, so the route is exercised without a network and without a second path to one.
   */
  readonly outbound?: OutboundInjection;
  /**
   * Hosts the guard may reach on a private address or over plain HTTP.
   *
   * Empty by default, as a deployment's is: a suite that needs an exemption asks for it.
   */
  readonly outboundAllowedHosts?: readonly string[];
}

/** Everything a suite drives. */
export interface TestStack {
  readonly app: Hono<MusterEnvironment>;
  readonly db: Database;
  /** Every message the application asked to send, in order. */
  readonly sent: readonly MailMessage[];
  /** A track admin, verified and approved. */
  readonly admin: AccountRow;
  /** Its session cookie, ready to present. */
  readonly adminCookie: string;
  /**
   * Signs an account in and returns the cookie a browser would send back.
   *
   * Goes through `POST /api/auth/sign-in` rather than inserting a session row, so a suite
   * built on it exercises the real sign-in path.
   */
  readonly signIn: (email: string, password?: string) => Promise<string>;
  /** Creates a verified, approved member who can sign in. */
  readonly makeMember: (overrides?: {
    readonly displayName?: string;
    readonly isAdmin?: boolean;
  }) => Promise<AccountRow>;
  /** Pins the clock every rule and every route reads. */
  readonly setNow: (at: Date) => void;
  readonly close: () => Promise<void>;
}

/** The configuration every suite runs against. */
function testConfig(
  databaseUrl: string,
  allowedHosts: readonly string[],
): MusterConfig {
  return {
    port: 3000,
    publicUrl: TEST_PUBLIC_URL,
    databaseUrl,
    masterKey: "0123456789abcdef0123456789abcdef",
    logLevel: "error",
    webRoot: undefined,
    smtpUrl: undefined,
    mailFrom: "no-reply@muster.test",
    outboundAllowedHosts: allowedHosts,
    checkIntervalMs: 900_000,
  };
}

/**
 * Stands up the application against a throwaway database.
 *
 * @param options - What to vary. Everything has a working default.
 * @returns The stack, and the means to close it.
 * @throws {Error} When no test database is configured. A suite must check
 *   `hasTestDatabase` and skip rather than call this.
 * @example
 * ```ts
 * describe.skipIf(!hasTestDatabase())("the auth routes", () => {
 *   let stack: TestStack;
 *   beforeAll(async () => { stack = await createTestStack(); });
 *   afterAll(async () => { await stack.close(); });
 * });
 * ```
 */
export async function createTestStack(
  options: TestStackOptions = {},
): Promise<TestStack> {
  const ownerUrl = testDatabaseUrl();
  if (ownerUrl === undefined) {
    throw new Error(
      "createTestStack needs MUSTER_TEST_DATABASE_URL; the suite should have skipped",
    );
  }
  await prepareTestDatabase(ownerUrl);
  const handle = createDatabase({
    url: servingRoleUrl(ownerUrl),
    maxConnections: 4,
    applicationName: "muster-test",
  });

  const sent: MailMessage[] = [];
  let now = new Date("2026-09-01T10:00:00.000Z");

  const context: ServerContext = {
    config: testConfig(
      servingRoleUrl(ownerUrl),
      options.outboundAllowedHosts ?? [],
    ),
    db: handle.db,
    mail: {
      send: async (message) => {
        if (options.mail === "failing") {
          throw new Error("the relay refused it");
        }
        sent.push(message);
        await Promise.resolve();
      },
    },
    rateLimits:
      options.rateLimits === "enforced"
        ? createRateLimitStore()
        : createUnlimitedStore(),
    clock: () => now,
    ...(options.outbound === undefined ? {} : { outbound: options.outbound }),
  };

  // The same thing the process entry point does before it serves: the anchor's keys are its
  // identity, and a JWKS that answered with nothing would be a public surface that lies.
  await ensureSigningKeys(handle.db, context.config.masterKey, now);

  const app = createApp(context);
  const passwordHash = await hashPassword(TEST_PASSWORD);

  /** Signs in through the real route and keeps only what a browser sends back. */
  const signIn = async (
    email: string,
    password: string = TEST_PASSWORD,
  ): Promise<string> => {
    const response = await app.request("/api/auth/sign-in", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (response.status !== 200) {
      throw new Error(
        `fixture sign-in failed with ${String(response.status)}: ${await response.text()}`,
      );
    }
    // Only the name=value pair: the attributes are the browser's business, and asserting on
    // them is `auth/routes.test.ts`'s job.
    return (response.headers.get("set-cookie") ?? "").split(";", 1)[0] ?? "";
  };

  const makeMember = async (
    overrides: {
      readonly displayName?: string;
      readonly isAdmin?: boolean;
    } = {},
  ): Promise<AccountRow> =>
    await makeAccount(handle.db, {
      email: `member-${uniqueSuffix()}@muster.test`,
      displayName: overrides.displayName ?? "Fixture Member",
      isAdmin: overrides.isAdmin ?? false,
      passwordHash,
      now,
    });

  const admin = await makeMember({ displayName: "Priya Nair", isAdmin: true });

  return {
    app,
    db: handle.db,
    sent,
    admin,
    adminCookie: await signIn(admin.email),
    signIn,
    makeMember,
    setNow: (at) => {
      now = at;
    },
    close: async () => {
      await handle.close();
    },
  };
}
