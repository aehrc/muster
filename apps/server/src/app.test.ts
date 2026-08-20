/*
 * Copyright © 2026 Commonwealth Scientific and Industrial Research Organisation
 * (CSIRO) ABN 41 687 119 230. Licensed under the Apache License, Version 2.0.
 */

import { errorEnvelopeSchema } from "@muster/contracts";
import { SQL } from "bun";
import { describe, expect, test } from "bun:test";
import { HTTPException } from "hono/http-exception";

import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { createMailTransport } from "./mail/transport.ts";

/**
 * Every error Muster puts on the wire is `{ error, detail? }`, so the console
 * can render a failure without guessing at the shape, and a caller can tell one
 * refusal from another.
 */

const config = loadConfig({
  MUSTER_PUBLIC_URL: "https://muster.example.org",
  MUSTER_MASTER_KEY: "0123456789abcdef0123456789abcdef",
  MUSTER_DATABASE_URL: "postgresql://muster_server@db:5432/muster",
  MUSTER_MIGRATION_DATABASE_URL: "postgresql://muster_owner@db:5432/muster",
});

// A transport that keeps what it was given, so no test sends mail anywhere.
const sentMail: string[] = [];

// None of these tests reach the database, and the driver connects lazily, so
// this connection is never opened.
const sql = new SQL(config.databaseUrl);

// Builds the application with test dependencies.
const testApp = () =>
  createApp({
    config,
    sql,
    mail: createMailTransport({
      from: config.mailFrom,
      delivery: { kind: "console" },
      log: (line) => sentMail.push(line),
    }),
  });

describe("health", () => {
  // The Docker smoke test and the compose healthcheck both poll this path, so
  // it stays where it is and keeps answering without configuration.
  test("answers on /healthz", async () => {
    const response = await testApp().request("/healthz");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({ status: "ok" });
  });
});

describe("dependencies", () => {
  // Later phases read the configuration and the transports from the request
  // context rather than being handed them, so the wiring is worth pinning.
  test("puts the configuration and the mail transport on the context", async () => {
    const app = testApp();
    app.get("/inspect", async (context) => {
      await context.get("mail").send({
        to: ["member@example.org"],
        subject: "Reachable",
        text: "From a handler.",
      });
      return context.json({ publicUrl: context.get("config").publicUrl });
    });

    const response = await app.request("/inspect");

    expect(await response.json()).toEqual({
      publicUrl: "https://muster.example.org",
    });
    expect(sentMail.at(-1)).toContain("Subject: Reachable");
  });
});

describe("the error envelope", () => {
  test("answers an unknown path with a 404 envelope", async () => {
    const response = await testApp().request("/api/nope");

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body: unknown = await response.json();
    expect(errorEnvelopeSchema.parse(body)).toEqual({
      error: "not_found",
      detail: "No route matches GET /api/nope",
    });
  });

  test("names the method that found no route", async () => {
    const response = await testApp().request("/api/nope", { method: "POST" });

    expect(response.status).toBe(404);
    const body = errorEnvelopeSchema.parse(await response.json());
    expect(body.detail).toBe("No route matches POST /api/nope");
  });

  test("reports a deliberate refusal with its status and reason", async () => {
    const app = testApp();
    app.get("/refuse", () => {
      throw new HTTPException(403, { message: "This account is revoked" });
    });

    const response = await app.request("/refuse");

    expect(response.status).toBe(403);
    expect(errorEnvelopeSchema.parse(await response.json())).toEqual({
      error: "forbidden",
      detail: "This account is revoked",
    });
  });

  test("maps each refusal status to its own error code", async () => {
    const app = testApp();
    app.get("/bad-request", () => {
      throw new HTTPException(400, { message: "why" });
    });
    app.get("/unauthorised", () => {
      throw new HTTPException(401, { message: "why" });
    });
    app.get("/conflict", () => {
      throw new HTTPException(409, { message: "why" });
    });
    app.get("/unprocessable", () => {
      throw new HTTPException(422, { message: "why" });
    });
    app.get("/too-many", () => {
      throw new HTTPException(429, { message: "why" });
    });

    const codes = await Promise.all(
      [
        "/bad-request",
        "/unauthorised",
        "/conflict",
        "/unprocessable",
        "/too-many",
      ].map(async (path) => {
        const response = await app.request(path);
        return errorEnvelopeSchema.parse(await response.json()).error;
      }),
    );

    expect(codes).toEqual([
      "invalid_request",
      "unauthorised",
      "conflict",
      "unprocessable",
      "rate_limited",
    ]);
  });

  // An unexpected failure is reported, but its message is not: the message can
  // carry a connection string, a token or a query, and no credential is ever
  // written to a response.
  test("reports an unexpected failure without leaking its cause", async () => {
    const app = testApp();
    app.get("/boom", () => {
      throw new Error(
        "connect failed: postgresql://muster:hunter2@db:5432/muster",
      );
    });

    const response = await app.request("/boom");

    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toContain("hunter2");
    expect(errorEnvelopeSchema.parse(JSON.parse(text))).toEqual({
      error: "internal_error",
    });
  });

  test("answers a refusal without a message using the status code alone", async () => {
    const app = testApp();
    app.get("/silent", () => {
      throw new HTTPException(403);
    });

    const response = await app.request("/silent");

    expect(response.status).toBe(403);
    expect(errorEnvelopeSchema.parse(await response.json())).toEqual({
      error: "forbidden",
    });
  });
});
