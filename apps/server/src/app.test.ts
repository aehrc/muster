/**
 * What the application is made of, before any story adds a route.
 *
 * Three things are asserted, and each is a failure that would otherwise be found in
 * production. Liveness must not touch the database, or a database outage restarts
 * every pod. Readiness must touch it, or a pod that can serve nothing reports itself
 * ready. And an unmatched path must be a JSON refusal rather than anything else - HTML
 * from the console's fallback, or a stack trace from an unhandled throw.
 *
 * Author: John Grimes
 */

import { describe, expect, it, mock } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { createApp } from "./app.js";

import type { ServerContext } from "./context.js";

/**
 * A context whose database only answers the readiness ping.
 *
 * Every route that reads data is covered by an integration suite against a real
 * database; what is composed here is the shell around them.
 */
function contextWith(
  execute: () => Promise<unknown>,
  webRoot?: string,
): ServerContext {
  return {
    config: {
      port: 3000,
      publicUrl: "https://muster.example",
      databaseUrl: "postgres://unused",
      masterKey: "0123456789abcdef0123456789abcdef",
      logLevel: "error",
      webRoot,
      smtpUrl: undefined,
      mailFrom: "no-reply@muster.example",
      outboundAllowedHosts: [],
    },
    db: { execute } as unknown as ServerContext["db"],
    mail: { send: async () => await Promise.resolve() },
    clock: () => new Date(0),
  };
}

/** A directory shaped like a Vite build, for the console-serving tests. */
function buildWebRoot(): string {
  const root = mkdtempSync(nodePath.join(tmpdir(), "muster-web-"));
  writeFileSync(
    nodePath.join(root, "index.html"),
    "<!doctype html><title>Muster</title>",
  );
  mkdirSync(nodePath.join(root, "assets"));
  writeFileSync(
    nodePath.join(root, "assets", "index-abc123.js"),
    "console.log(1);",
  );
  return root;
}

describe("createApp probes", () => {
  it("answers liveness without touching the database", async () => {
    // A pod whose database is down is still alive, and restarting it would neither fix
    // the database nor help anybody.
    const execute = mock(async () => await Promise.resolve());
    const response = await createApp(contextWith(execute)).request("/healthz");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("answers readiness by querying the database", async () => {
    const execute = mock(async () => await Promise.resolve());
    const response = await createApp(contextWith(execute)).request("/readyz");

    expect(response.status).toBe(200);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("reports 503 when the database cannot be reached", async () => {
    const response = await createApp(
      contextWith(() => Promise.reject(new Error("ECONNREFUSED"))),
    ).request("/readyz");

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "database_unreachable",
    });
  });
});

describe("createApp error contract", () => {
  it("answers an unmatched path with the error envelope", async () => {
    const response = await createApp(contextWith(async () => {})).request(
      "/api/events/nope",
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
    await expect(response.json()).resolves.toEqual({ error: "not_found" });
  });

  it("answers a thrown error with the envelope and no internal detail", async () => {
    const app = createApp(contextWith(async () => {}));
    app.get("/boom", () => {
      throw new Error("connection string postgres://muster:secret@db/muster");
    });

    const response = await app.request("/boom");

    expect(response.status).toBe(500);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["error"]).toBe("internal_error");
    // The message could carry a connection string or a token. A caller gets the code;
    // the server's own log gets the cause.
    expect(JSON.stringify(body)).not.toContain("secret");
  });
});

describe("createApp serving the console", () => {
  it("serves the built console and its assets", async () => {
    const app = createApp(contextWith(async () => {}, buildWebRoot()));

    const page = await app.request("/", {
      headers: { accept: "text/html" },
    });
    expect(page.status).toBe(200);
    await expect(page.text()).resolves.toContain("Muster");

    const asset = await app.request("/assets/index-abc123.js");
    expect(asset.status).toBe(200);
    await expect(asset.text()).resolves.toContain("console.log");
  });

  // The console routes client-side, so a deep link has to arrive at the shell.
  it("answers a console route with the shell", async () => {
    const app = createApp(contextWith(async () => {}, buildWebRoot()));

    const response = await app.request("/events/sparked-2026-09", {
      headers: { accept: "text/html" },
    });

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toContain("Muster");
  });

  // The failure the reserved-path list exists to prevent.
  it("still answers an unmatched API path with JSON", async () => {
    const app = createApp(contextWith(async () => {}, buildWebRoot()));

    const response = await app.request("/api/events/nope", {
      headers: { accept: "text/html" },
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "not_found" });
  });

  it("does not serve a file outside the web root", async () => {
    const app = createApp(contextWith(async () => {}, buildWebRoot()));

    const response = await app.request("/../../../../../../etc/passwd", {
      headers: { accept: "application/json" },
    });

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.not.toContain("root:");
  });

  it("answers a data request for an unknown path with JSON rather than the shell", async () => {
    const app = createApp(contextWith(async () => {}, buildWebRoot()));

    const response = await app.request("/events/nope.json", {
      headers: { accept: "application/json" },
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "not_found" });
  });
});
