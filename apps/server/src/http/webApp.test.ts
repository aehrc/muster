import { errorEnvelopeSchema } from "@muster/contracts";
import { SQL } from "bun";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createApp } from "../app.ts";
import { loadConfig } from "../config.ts";
import { createMailTransport } from "../mail/transport.ts";

import type { AppEnvironment } from "../app.ts";
import type { MusterConfig } from "../config.ts";
import type { Hono } from "hono";

/**
 * Serving the console.
 *
 * The deployment is one container: the API and the built single-page console
 * come out of the same process, so a Helm release with one image and one service
 * is the whole product rather than an API with no screens. That makes the
 * fallback rule load-bearing - a console route like `/pairings/abc` exists only
 * in the browser, so the server has to answer it with the document rather than a
 * 404 - and it makes the exceptions load-bearing too: an unknown path under
 * `/api` is a JSON 404, because a caller reading JSON must not be handed HTML.
 *
 * The suites below build the application over a scratch directory rather than the
 * real build output, so they run whether or not the console has been built.
 *
 * @author John Grimes
 */

/** Where the fake build output lives for the duration of the suite. */
let directory: string;

/** The application, built over that directory. */
let app: Hono<AppEnvironment>;

/** The application built with no console to serve. */
let apiOnly: Hono<AppEnvironment>;

/** The document the console is served as. */
const document = "<!doctype html><title>Muster</title><div id=root></div>";

/**
 * Builds the application over a directory of built console assets.
 *
 * @param webDirectory - the directory to serve the console from
 * @returns the application
 */
const buildApp = (webDirectory: string): Hono<AppEnvironment> => {
  const config: MusterConfig = loadConfig({
    MUSTER_PUBLIC_URL: "https://muster.example.org",
    MUSTER_MASTER_KEY: "0123456789abcdef0123456789abcdef",
    MUSTER_DATABASE_URL: "postgresql://muster_server@db:5432/muster",
    MUSTER_MIGRATION_DATABASE_URL: "postgresql://muster_owner@db:5432/muster",
    MUSTER_WEB_DIRECTORY: webDirectory,
  });
  // The driver connects lazily and nothing here reaches the database.
  return createApp({
    config,
    sql: new SQL(config.databaseUrl),
    mail: createMailTransport({
      from: config.mailFrom,
      delivery: { kind: "console" },
      log: () => undefined,
    }),
  });
};

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "muster-web-"));
  await writeFile(join(directory, "index.html"), document, "utf8");
  await Bun.write(join(directory, "assets", "app-abc123.js"), "export {};");
  await writeFile(
    join(directory, "..", "outside-the-console.txt"),
    "not the console's",
    "utf8",
  );
  app = buildApp(directory);
  apiOnly = buildApp(join(directory, "absent"));
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
  await rm(join(directory, "..", "outside-the-console.txt"), { force: true });
});

describe("the console", () => {
  test("serves the document at the root", async () => {
    const response = await app.request("/");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toBe(document);
  });

  // Vite gives every asset a content-hashed name, so it can be cached hard.
  test("serves a built asset with an immutable cache header", async () => {
    const response = await app.request("/assets/app-abc123.js");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("javascript");
    expect(response.headers.get("cache-control")).toContain("immutable");
  });

  // The document must not be cached hard, or a deployment would not take effect.
  test("serves the document without caching it", async () => {
    const response = await app.request("/");

    expect(response.headers.get("cache-control")).toContain("no-cache");
  });

  // A console route exists only in the browser's router.
  test.each(["/pairings/abc", "/events/sparked-2026-09", "/sign-in"])(
    "answers the console route %p with the document",
    async (path) => {
      const response = await app.request(path);

      expect(response.status).toBe(200);
      expect(await response.text()).toBe(document);
    },
  );

  // A caller reading JSON must never be handed HTML.
  test("answers an unknown API path with the JSON envelope", async () => {
    const response = await app.request("/api/nope");

    expect(response.status).toBe(404);
    const body = errorEnvelopeSchema.parse(await response.json());
    expect(body.error).toBe("not_found");
  });

  test("answers an unknown well-known path with the JSON envelope", async () => {
    const response = await app.request("/.well-known/nope.json");

    expect(response.status).toBe(404);
    expect(errorEnvelopeSchema.parse(await response.json()).error).toBe(
      "not_found",
    );
  });

  test("leaves the health check alone", async () => {
    const response = await app.request("/healthz");

    expect(await response.json()).toEqual({ status: "ok" });
  });

  // Nothing outside the served directory is reachable, however the path is
  // written: the console directory is the whole of what is published.
  test.each([
    "/../outside-the-console.txt",
    "/..%2foutside-the-console.txt",
    "/assets/../../outside-the-console.txt",
  ])("refuses to serve %p from outside the directory", async (path) => {
    const response = await app.request(path);

    expect(await response.text()).not.toContain("not the console's");
  });

  // A deployment that serves the API alone is a legitimate configuration, and it
  // answers as an API rather than pretending to have a console.
  test("answers with the JSON envelope when no console is present", async () => {
    const response = await apiOnly.request("/pairings/abc");

    expect(response.status).toBe(404);
    expect(errorEnvelopeSchema.parse(await response.json()).error).toBe(
      "not_found",
    );
  });
});
