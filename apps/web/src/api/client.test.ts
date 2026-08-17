import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { createApiClient } from "./client.ts";

import type { ApiResult } from "./client.ts";

/**
 * The console reads every failure out of the `{ error, detail? }` envelope, so
 * these tests cover what arrives when the answer is not the envelope either:
 * a proxy's HTML error page, a dropped connection, or a body that does not
 * match the contract. None of those may reach a screen as a crash.
 */

const eventSchema = z.object({ slug: z.string(), name: z.string() });

// Reads the failure from a result, failing the test if the call succeeded.
const failureOf = <Output>(result: ApiResult<Output>) => {
  if (result.ok) {
    throw new Error("expected the call to fail");
  }
  return result.failure;
};

describe("createApiClient", () => {
  test("returns the parsed body of a successful call", async () => {
    const client = createApiClient({
      fetchImplementation: () =>
        Promise.resolve(
          Response.json({ slug: "sparked-2026-09", name: "Sparked" }),
        ),
    });

    const result = await client.get("/api/events/sparked-2026-09", eventSchema);

    expect(result).toEqual({
      ok: true,
      data: { slug: "sparked-2026-09", name: "Sparked" },
    });
  });

  test("asks for JSON and honours the configured base URL", async () => {
    const seen: { url?: string; init?: RequestInit | undefined } = {};
    const client = createApiClient({
      baseUrl: "https://muster.example.org",
      fetchImplementation: (url, init) => {
        seen.url = url;
        seen.init = init;
        return Promise.resolve(Response.json({ slug: "a", name: "b" }));
      },
    });

    await client.get("/api/events/a", eventSchema);

    expect(seen.url).toBe("https://muster.example.org/api/events/a");
    expect(new Headers(seen.init?.headers).get("accept")).toBe(
      "application/json",
    );
  });

  test("sends a JSON body and reads the resource back", async () => {
    const seen: { init?: RequestInit | undefined } = {};
    const client = createApiClient({
      fetchImplementation: (_url, init) => {
        seen.init = init;
        return Promise.resolve(
          Response.json({ slug: "a", name: "b" }, { status: 201 }),
        );
      },
    });

    const result = await client.post(
      "/api/admin/events",
      { name: "b" },
      eventSchema,
    );

    expect(result.ok).toBe(true);
    expect(seen.init?.method).toBe("POST");
    expect(seen.init?.body).toBe('{"name":"b"}');
    expect(new Headers(seen.init?.headers).get("content-type")).toBe(
      "application/json",
    );
  });

  // The envelope is the contract, so its contents reach the caller intact.
  test("reads a refusal out of the error envelope", async () => {
    const client = createApiClient({
      fetchImplementation: () =>
        Promise.resolve(
          Response.json(
            { error: "unprocessable", detail: "10.0.0.1 is a private address" },
            { status: 422 },
          ),
        ),
    });

    const result = await client.get("/api/events/a", eventSchema);

    expect(failureOf(result)).toEqual({
      status: 422,
      error: "unprocessable",
      detail: "10.0.0.1 is a private address",
    });
  });

  test("reads a refusal that carries no detail", async () => {
    const client = createApiClient({
      fetchImplementation: () =>
        Promise.resolve(Response.json({ error: "forbidden" }, { status: 403 })),
    });

    expect(failureOf(await client.get("/api/events/a", eventSchema))).toEqual({
      status: 403,
      error: "forbidden",
    });
  });

  // A gateway or a proxy answers with HTML, not the envelope. The screen still
  // has to say something true about what happened.
  test("describes a failure whose body is not the envelope", async () => {
    const client = createApiClient({
      fetchImplementation: () =>
        Promise.resolve(
          new Response("<html>502 Bad Gateway</html>", {
            status: 502,
            headers: { "content-type": "text/html" },
          }),
        ),
    });

    const failure = failureOf(await client.get("/api/events/a", eventSchema));

    expect(failure.status).toBe(502);
    expect(failure.error).toBe("unexpected_response");
    expect(failure.detail).toContain("502");
  });

  test("describes a failure whose JSON is not the envelope", async () => {
    const client = createApiClient({
      fetchImplementation: () =>
        Promise.resolve(Response.json({ message: "nope" }, { status: 500 })),
    });

    const failure = failureOf(await client.get("/api/events/a", eventSchema));

    expect(failure.error).toBe("unexpected_response");
    expect(failure.status).toBe(500);
  });

  test("describes a connection that never answered", async () => {
    const client = createApiClient({
      fetchImplementation: () => Promise.reject(new TypeError("Load failed")),
    });

    const failure = failureOf(await client.get("/api/events/a", eventSchema));

    expect(failure).toEqual({
      status: 0,
      error: "network_error",
      detail: "Load failed",
    });
  });

  // A success that does not match the contract is a failure, not something to
  // hand to a component and hope.
  test("refuses a successful body that does not match the contract", async () => {
    const client = createApiClient({
      fetchImplementation: () => Promise.resolve(Response.json({ slug: "a" })),
    });

    const failure = failureOf(await client.get("/api/events/a", eventSchema));

    expect(failure.status).toBe(200);
    expect(failure.error).toBe("unexpected_response");
    expect(failure.detail).toMatch(/contract/i);
  });
});
