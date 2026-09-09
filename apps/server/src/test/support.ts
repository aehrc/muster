/*
 * Copyright © 2026 Commonwealth Scientific and Industrial Research Organisation
 * (CSIRO) ABN 41 687 119 230. Licensed under the Apache License, Version 2.0.
 */

import { createMigratedSchema } from "@muster/db/test/harness";

import { createApp } from "../app.ts";
import { loadConfig } from "../config.ts";
import { createMailTransport } from "../mail/transport.ts";

import type { AppEnvironment } from "../app.ts";
import type { MusterConfig } from "../config.ts";
import type { OutboundOverrides } from "../outbound/outboundFetch.ts";
import type { MigratedSchema } from "@muster/db/test/harness";
import type { Hono } from "hono";
import type { z } from "zod";

/**
 * What the route suites need in order to drive the real application.
 *
 * The suites run against a real PostgreSQL in a scratch schema and a console
 * mail transport that keeps what it was handed, so nothing is faked between the
 * request and the row: an assertion about a verification link is an assertion
 * about the message a participant would receive.
 *
 * @author John Grimes
 */

/** A running application with its database and its mail. */
export type TestServer = {
  /** the application, driven with `app.request(...)` */
  readonly app: Hono<AppEnvironment>;
  /** every message the console transport has rendered */
  readonly sentMail: string[];
  /** the scratch schema and its connection */
  readonly database: MigratedSchema;
  /** the configuration the application was built with */
  readonly config: MusterConfig;
  /** drops the schema and closes the connections */
  readonly close: () => Promise<void>;
  /**
   * Makes every subsequent send fail with the given message, as an SMTP server
   * refusing the message does; `null` restores delivery.
   */
  readonly failMail: (detail: string | null) => void;
};

/** A signed-in account, with the cookie to act as it. */
export type SignedIn = {
  /** the account's identifier */
  readonly id: string;
  /** the account's address */
  readonly email: string;
  /** the cookie header value that carries the session */
  readonly cookie: string;
};

/** The password every test account is created with. */
export const testPassword = "correct horse battery staple";

/**
 * A calendar day relative to today, as `YYYY-MM-DD`.
 *
 * The vouching routes read the real clock, so a suite that seeds an event with a
 * fixed date starts being refused the day its grace period runs out. Dating the
 * event from today keeps the window open whenever the suite runs.
 *
 * @param offsetDays - days from today; negative for the past
 * @returns the day in UTC
 */
export const dayFromToday = (offsetDays: number): string =>
  new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

/**
 * Builds the configuration the suites run against.
 *
 * @param databaseUrl - the scratch schema's connection URL
 * @param environment - variables to add or override, for a suite whose subject
 *   is configuration-dependent
 * @returns the configuration
 */
const testConfig = (
  databaseUrl: string,
  environment: Readonly<Record<string, string>> = {},
): MusterConfig =>
  loadConfig({
    MUSTER_PUBLIC_URL: "https://muster.example.org",
    MUSTER_MASTER_KEY: "0123456789abcdef0123456789abcdef",
    MUSTER_DATABASE_URL: databaseUrl,
    MUSTER_MIGRATION_DATABASE_URL: databaseUrl,
    MUSTER_MAIL_FROM: "muster@example.org",
    ...environment,
  });

/**
 * Starts an application over a scratch schema.
 *
 * Each call builds a new application, which is what keeps the in-process rate
 * limiter in one test from refusing requests in another.
 *
 * @param prefix - a lower-case prefix identifying the suite
 * @param outbound - replacements for the guarded fetch's collaborators, for a
 *   suite that drives a route which reaches a participant's server
 * @param environment - variables to add to the configuration the application is
 *   built with, for a suite whose subject is configuration-dependent
 * @returns the application, its mail, its database and the teardown
 * @throws {Error} when `MUSTER_TEST_DATABASE_URL` is not set
 * @example
 * ```ts
 * const server = await startTestServer("auth");
 * const response = await post(server, "/api/auth/sign-up", { ... });
 * await server.close();
 * ```
 */
export const startTestServer = async (
  prefix: string,
  outbound: OutboundOverrides = {},
  environment: Readonly<Record<string, string>> = {},
): Promise<TestServer> => {
  const database = await createMigratedSchema(prefix);
  const config = testConfig(
    process.env["MUSTER_TEST_DATABASE_URL"] ?? "postgresql://unset/unset",
    environment,
  );
  const sentMail: string[] = [];
  let mailFailure: string | null = null;
  const app = createApp({
    config,
    outbound,
    sql: database.sql,
    mail: createMailTransport({
      from: config.mailFrom,
      delivery: { kind: "console" },
      log: (line) => {
        if (mailFailure !== null) {
          throw new Error(mailFailure);
        }
        sentMail.push(line);
      },
    }),
  });
  return {
    app,
    sentMail,
    database,
    config,
    close: () => database.close(),
    failMail: (detail) => {
      mailFailure = detail;
    },
  };
};

/** What a request may carry beyond its method and path. */
type RequestOptions = {
  /** the body to send as JSON */
  readonly body?: unknown;
  /** the cookie header value to send it with */
  readonly cookie?: string;
  /** the client address to present, for the rate-limited routes */
  readonly address?: string;
};

/**
 * Sends a JSON request.
 *
 * @param server - the running application
 * @param method - the HTTP method
 * @param path - the path, from the root
 * @param options - the body, the cookie and the client address to send with
 * @returns the response
 */
export const request = async (
  server: TestServer,
  method: string,
  path: string,
  options: RequestOptions = {},
): Promise<Response> =>
  server.app.request(path, {
    method,
    ...(options.body === undefined
      ? {}
      : { body: JSON.stringify(options.body) }),
    headers: {
      ...(options.body === undefined
        ? {}
        : { "content-type": "application/json" }),
      ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
      ...(options.address === undefined
        ? {}
        : { "x-forwarded-for": options.address }),
    },
  });

/**
 * Builds an address unique to one test participant.
 *
 * The credential routes are rate limited by client address, and separate
 * participants come from separate addresses, so a suite that signs up a dozen
 * accounts presents a dozen addresses rather than exhausting one allowance.
 *
 * @returns a documentation-range address
 */
export const uniqueAddress = (): string =>
  `198.51.100.${String(Math.floor(Math.random() * 254) + 1)}:${String(Math.floor(Math.random() * 60_000) + 1024)}`;

/**
 * Reads a response body against the contract schema for it.
 *
 * Parsing rather than casting is the point: a suite that reads a field the
 * contract does not define fails here, so server and console cannot drift apart
 * without a test saying so.
 *
 * @param response - the response to read
 * @param schema - the shape the body must satisfy
 * @returns the parsed body
 * @throws {Error} when the body does not satisfy the schema
 * @example
 * ```ts
 * const { contacts } = await readJson(response, contactsResponseSchema);
 * ```
 */
export const readJson = async <Schema extends z.ZodType>(
  response: Response,
  schema: Schema,
): Promise<z.output<Schema>> => {
  const body: unknown = await response.json();
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new Error(
      `Response did not match its contract: ${JSON.stringify(body)}`,
      { cause: parsed.error },
    );
  }
  return parsed.data;
};

/**
 * Reads the session cookie out of a response.
 *
 * @param response - the response to a sign-in
 * @returns the cookie header value to send on later requests
 * @throws {Error} when the response set no cookie
 */
export const sessionCookie = (response: Response): string => {
  const header = response.headers.get("set-cookie");
  if (header === null) {
    throw new Error("The response set no cookie");
  }
  return header.split(";")[0] ?? "";
};

/**
 * Reads the newest verification token out of the mail log.
 *
 * @param server - the running application
 * @returns the token from the most recent verification link
 * @throws {Error} when no message carries one
 */
export const verificationToken = (server: TestServer): string => {
  for (const message of [...server.sentMail].reverse()) {
    const found = /\/verify\?token=([\w-]+)/.exec(message);
    if (found?.[1] !== undefined) {
      return found[1];
    }
  }
  throw new Error("No message carried a verification link");
};

/**
 * Signs an account up, verifies it, and signs it in.
 *
 * Approval is a separate step, because half of what these suites test is what
 * an unapproved account cannot do. Each participant presents its own client
 * address, since the credential routes are rate limited by address.
 *
 * @param server - the running application
 * @param email - the address to sign up with
 * @returns the account and the cookie that carries its session
 * @throws {Error} when any step is refused
 */
export const signUpAndSignIn = async (
  server: TestServer,
  email: string,
): Promise<SignedIn> => {
  const address = uniqueAddress();
  const signedUp = await request(server, "POST", "/api/auth/sign-up", {
    body: { email, displayName: email, password: testPassword },
    address,
  });
  if (signedUp.status !== 201) {
    throw new Error(`Sign-up failed: ${await signedUp.text()}`);
  }
  const verified = await request(server, "POST", "/api/auth/verify", {
    body: { token: verificationToken(server) },
    address,
  });
  if (verified.status !== 200) {
    throw new Error(`Verification failed: ${await verified.text()}`);
  }
  const signedIn = await request(server, "POST", "/api/auth/sign-in", {
    body: { email, password: testPassword },
    address,
  });
  if (signedIn.status !== 200) {
    throw new Error(`Sign-in failed: ${await signedIn.text()}`);
  }
  const body: unknown = await signedIn.json();
  const id =
    typeof body === "object" &&
    body !== null &&
    "account" in body &&
    typeof body.account === "object" &&
    body.account !== null &&
    "id" in body.account
      ? String(body.account.id)
      : "";
  return { id, email, cookie: sessionCookie(signedIn) };
};
