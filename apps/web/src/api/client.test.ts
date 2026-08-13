/**
 * The one fetch in the browser.
 *
 * What is asserted is what every caller then gets to assume: the session cookie is
 * always sent, a refusal always arrives as an `ApiError` carrying the server's own
 * words, and no caller has to inspect `response.ok`.
 *
 * Author: John Grimes
 */

import { afterEach, describe, expect, it } from "bun:test";

import { get, patch, post, remove } from "./client.js";
import { ApiError } from "./errors.js";

/** What the stubbed transport was asked to do. */
interface Call {
  readonly url: string;
  readonly init: RequestInit;
}

const realFetch = globalThis.fetch;
const calls: Call[] = [];

/** Answers every request with one response, recording what was asked. */
function stubFetch(response: Response): void {
  calls.length = 0;
  globalThis.fetch = ((url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    return Promise.resolve(response);
  }) as unknown as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("get", () => {
  it("returns the parsed body", async () => {
    stubFetch(Response.json({ slug: "sparked-2026-09" }, { status: 200 }));

    await expect(
      get<{ slug: string }>("/api/events/sparked-2026-09"),
    ).resolves.toEqual({ slug: "sparked-2026-09" });
  });

  it("sends the session cookie and asks for JSON", async () => {
    stubFetch(new Response("[]", { status: 200 }));

    await get("/api/events");

    // Same-origin rather than `include`: the API is served by the same process as this
    // bundle, and a cross-origin credentialed request is not something the console
    // should be able to make by accident.
    expect(calls[0]?.init.credentials).toBe("same-origin");
    expect(new Headers(calls[0]?.init.headers).get("accept")).toBe(
      "application/json",
    );
  });

  it("throws the server's refusal", async () => {
    stubFetch(
      Response.json(
        { error: "not_found", detail: "No such event" },
        { status: 404 },
      ),
    );

    const failure = get("/api/events/nope");

    await expect(failure).rejects.toBeInstanceOf(ApiError);
    await expect(failure).rejects.toThrow("No such event");
  });
});

describe("post", () => {
  it("sends a JSON body", async () => {
    stubFetch(new Response("{}", { status: 201 }));

    await post("/api/organisations", { name: "CSIRO" });

    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.body).toBe('{"name":"CSIRO"}');
    expect(new Headers(calls[0]?.init.headers).get("content-type")).toBe(
      "application/json",
    );
  });

  it("sends no content type when there is no body", async () => {
    // An action with no body - approving an account - should not declare one.
    stubFetch(new Response("{}", { status: 200 }));

    await post("/api/admin/accounts/1/approve");

    expect(new Headers(calls[0]?.init.headers).get("content-type")).toBeNull();
  });
});

describe("patch and remove", () => {
  it("uses the method the caller asked for", async () => {
    stubFetch(new Response("{}", { status: 200 }));
    await patch("/api/systems/1", { name: "Smart Forms" });
    expect(calls[0]?.init.method).toBe("PATCH");

    stubFetch(new Response(null, { status: 204 }));
    await remove("/api/organisations/1/members/2");
    expect(calls[0]?.init.method).toBe("DELETE");
  });

  it("tolerates a response with no content", async () => {
    stubFetch(new Response(null, { status: 204 }));

    await expect(
      remove("/api/organisations/1/members/2"),
    ).resolves.toBeUndefined();
  });
});
