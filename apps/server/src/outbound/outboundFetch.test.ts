/**
 * The one guarded path to the network, and every way it must refuse.
 *
 * This is the most security-critical module in the server (constitution principle
 * III, FR-020). Muster exists to fetch addresses that participants typed, so a hole
 * here is a hole in a service that runs inside a cluster next to a metadata endpoint
 * that hands out credentials. The cases below are the shape of the hole in each
 * direction: a name that resolves somewhere private, one of several addresses being
 * private, a redirect into a guarded range, a host that never answers.
 *
 * The resolver and the transport are injected, so none of these tests touch DNS or
 * the network - which is also what lets the redirect and timeout paths be asserted
 * rather than described.
 *
 * Author: John Grimes
 */

import { describe, expect, it } from "bun:test";

import { checkOutboundUrl, outboundFetch } from "./outboundFetch.js";

import type { OutboundResult } from "./outboundFetch.js";

/** A resolver that answers with fixed addresses for any name. */
function resolvesTo(...addresses: readonly string[]) {
  return async () => await Promise.resolve(addresses);
}

/** A resolver that fails the test if the guard consults it. */
const neverResolves = async (): Promise<readonly string[]> => {
  await Promise.resolve();
  throw new Error("The guard resolved a host it should not have resolved");
};

/** A transport answering every request with one response. */
function answersWith(response: Response) {
  return async () => await Promise.resolve(response);
}

/** A transport that fails the test if the guard reaches it. */
const neverFetches = async (): Promise<Response> => {
  await Promise.resolve();
  throw new Error("The guard fetched a URL it should have refused");
};

/** The refusal reason, or a readable failure when the result was a success. */
function refusalOf(result: OutboundResult): string {
  return result.ok ? `unexpectedly ok (${result.value.status})` : result.reason;
}

describe("checkOutboundUrl", () => {
  it("accepts an https URL", () => {
    const check = checkOutboundUrl("https://fhir.example/base");

    expect(check.ok).toBe(true);
  });

  it("refuses something that is not a URL", () => {
    expect(checkOutboundUrl("fhir.example/base")).toMatchObject({
      ok: false,
      reason: "not-a-url",
    });
  });

  // `file:`, `gopher:` and the rest are refused by the same check.
  it("refuses plain HTTP and every other scheme by default", () => {
    expect(checkOutboundUrl("http://fhir.example")).toMatchObject({
      reason: "insecure-scheme",
    });
    expect(checkOutboundUrl("file:///etc/passwd")).toMatchObject({
      reason: "insecure-scheme",
    });
  });

  it("permits plain HTTP for an allowlisted host", () => {
    expect(
      checkOutboundUrl("http://stub-server:8080/register", [
        "stub-server:8080",
      ]),
    ).toMatchObject({ ok: true });
  });

  it("does not treat a different port on an allowlisted host as allowlisted", () => {
    // An allowlist entry naming a port means that port. Otherwise naming a stub
    // exempts every service on the same host.
    expect(
      checkOutboundUrl("http://stub-server:9999/register", [
        "stub-server:8080",
      ]),
    ).toMatchObject({ reason: "insecure-scheme" });
  });

  // `https://metadata@attacker.example/` and its inverse are the standard way to make
  // a URL's apparent host differ from its real one.
  it("refuses userinfo, allowlisted or not", () => {
    expect(checkOutboundUrl("https://user@fhir.example")).toMatchObject({
      reason: "userinfo",
    });
    expect(
      checkOutboundUrl("http://user:pw@stub-server:8080", ["stub-server:8080"]),
    ).toMatchObject({ reason: "userinfo" });
  });

  it("refuses an IP literal in a guarded range without resolving anything", () => {
    expect(checkOutboundUrl("https://127.0.0.1/base")).toMatchObject({
      reason: "blocked-address",
    });
    expect(
      checkOutboundUrl("https://169.254.169.254/latest/meta-data"),
    ).toMatchObject({ reason: "blocked-address" });
    expect(checkOutboundUrl("https://[::ffff:10.0.0.1]/base")).toMatchObject({
      reason: "blocked-address",
    });
  });

  it("accepts a publicly routable IP literal", () => {
    expect(checkOutboundUrl("https://8.8.8.8/base")).toMatchObject({
      ok: true,
    });
  });

  it("permits a guarded literal for an allowlisted host", () => {
    expect(
      checkOutboundUrl("http://127.0.0.1:8080/register", ["127.0.0.1:8080"]),
    ).toMatchObject({ ok: true });
  });
});

describe("outboundFetch address checks", () => {
  // The case that makes checking the literal alone useless: `localtest.me` resolves
  // to 127.0.0.1, and so does any name an attacker controls.
  it("refuses a name that resolves to loopback", async () => {
    const result = await outboundFetch("https://localtest.me/base", {
      resolve: resolvesTo("127.0.0.1"),
      fetchImpl: neverFetches,
    });

    expect(refusalOf(result)).toBe("blocked-address");
    expect(result.ok ? "" : result.description).toContain("127.0.0.1");
  });

  // Every address, not the first: with a name carrying both a public and a private
  // record, the choice of which to connect to would decide whether the guard held.
  it("refuses a name where any address is guarded", async () => {
    const result = await outboundFetch("https://fhir.example/base", {
      resolve: resolvesTo("93.184.216.34", "10.0.0.5"),
      fetchImpl: neverFetches,
    });

    expect(refusalOf(result)).toBe("blocked-address");
  });

  it("refuses a name that cannot be resolved", async () => {
    const result = await outboundFetch("https://nowhere.example/base", {
      resolve: async () => {
        await Promise.resolve();
        throw new Error("ENOTFOUND");
      },
      fetchImpl: neverFetches,
    });

    expect(refusalOf(result)).toBe("unresolvable");
  });

  it("refuses a name that resolves to no addresses at all", async () => {
    const result = await outboundFetch("https://nowhere.example/base", {
      resolve: resolvesTo(),
      fetchImpl: neverFetches,
    });

    expect(refusalOf(result)).toBe("unresolvable");
  });

  // The allowlist is what lets the compose stack and the tests reach a stub on a
  // private address. It exempts the named host and nothing else, and it is off unless
  // set - see the configuration loader.
  it("does not resolve or judge an allowlisted host", async () => {
    const result = await outboundFetch("http://stub-server:8080/register", {
      allowedHosts: ["stub-server:8080"],
      resolve: neverResolves,
      fetchImpl: answersWith(new Response("{}", { status: 201 })),
    });

    expect(result.ok).toBe(true);
  });
});

describe("outboundFetch requests and responses", () => {
  it("returns the status, headers and body of a successful response", async () => {
    const result = await outboundFetch("https://fhir.example/base", {
      resolve: resolvesTo("93.184.216.34"),
      fetchImpl: answersWith(
        new Response('{"resourceType":"CapabilityStatement"}', {
          status: 200,
          headers: { "content-type": "application/fhir+json" },
        }),
      ),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe(200);
      expect(result.value.headers["content-type"]).toBe(
        "application/fhir+json",
      );
      expect(result.value.body).toContain("CapabilityStatement");
      expect(result.value.url).toBe("https://fhir.example/base");
    }
  });

  // A refusal by the far end is evidence, not a guard failure. The conformance
  // harness's whole job is to assert that a server answered 400 to a tampered
  // statement, so a non-2xx status has to arrive as a response.
  it("reports an error status as a response rather than a refusal", async () => {
    const result = await outboundFetch("https://fhir.example/register", {
      method: "POST",
      body: '{"software_statement":"..."}',
      resolve: resolvesTo("93.184.216.34"),
      fetchImpl: answersWith(
        new Response('{"error":"invalid_software_statement"}', { status: 400 }),
      ),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe(400);
      expect(result.value.body).toContain("invalid_software_statement");
    }
  });

  it("sends the method, headers and body it was given", async () => {
    let seen: {
      method: string | undefined;
      body: unknown;
      accept: string | null;
    } = { method: undefined, body: undefined, accept: null };

    await outboundFetch("https://fhir.example/register", {
      method: "POST",
      body: '{"software_statement":"jws"}',
      headers: { "content-type": "application/json" },
      resolve: resolvesTo("93.184.216.34"),
      fetchImpl: async (_url, init) => {
        seen = {
          method: init.method,
          body: init.body,
          accept: new Headers(init.headers).get("content-type"),
        };
        return await Promise.resolve(new Response("{}", { status: 201 }));
      },
    });

    expect(seen.method).toBe("POST");
    expect(seen.body).toBe('{"software_statement":"jws"}');
    expect(seen.accept).toBe("application/json");
  });

  it("refuses a body larger than the limit rather than reading it all", async () => {
    const result = await outboundFetch("https://fhir.example/base", {
      maxBytes: 16,
      resolve: resolvesTo("93.184.216.34"),
      fetchImpl: answersWith(new Response("x".repeat(1024))),
    });

    expect(refusalOf(result)).toBe("too-large");
  });
});

describe("outboundFetch redirects", () => {
  /** A transport that answers each URL from a script of responses. */
  function answersInOrder(...responses: readonly Response[]) {
    let index = 0;
    return async (): Promise<Response> => {
      const response = responses[index] ?? new Response("", { status: 500 });
      index += 1;
      return await Promise.resolve(response);
    };
  }

  /** A redirect to `location`. */
  function redirectTo(location: string): Response {
    return new Response("", { status: 302, headers: { location } });
  }

  it("follows a redirect to a public address and reports where it ended", async () => {
    const result = await outboundFetch("https://fhir.example/base", {
      resolve: resolvesTo("93.184.216.34"),
      fetchImpl: answersInOrder(
        redirectTo("https://fhir.example/base/"),
        new Response("ok", { status: 200 }),
      ),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // A trailing-slash redirect is the common case for a FHIR base URL, so the
      // guard follows rather than refusing - but it reports the URL it ended at, so a
      // drift check compares against what was actually fetched.
      expect(result.value.url).toBe("https://fhir.example/base/");
    }
  });

  // The reason redirects cannot simply be followed: the second URL is one the guard
  // never saw when it admitted the first.
  it("refuses a redirect into a guarded range", async () => {
    const result = await outboundFetch("https://fhir.example/base", {
      resolve: resolvesTo("93.184.216.34"),
      fetchImpl: answersInOrder(redirectTo("http://169.254.169.254/latest/")),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.description).toContain("redirect");
      expect(result.description).toContain("169.254.169.254");
    }
  });

  it("refuses a redirect to a name that resolves somewhere guarded", async () => {
    let call = 0;
    const result = await outboundFetch("https://fhir.example/base", {
      resolve: async () => {
        call += 1;
        return await Promise.resolve(
          call === 1 ? ["93.184.216.34"] : ["192.168.0.1"],
        );
      },
      fetchImpl: answersInOrder(redirectTo("https://internal.example/")),
    });

    expect(refusalOf(result)).toBe("blocked-address");
  });

  it("refuses a redirect chain longer than the budget", async () => {
    const result = await outboundFetch("https://fhir.example/1", {
      maxRedirects: 2,
      resolve: resolvesTo("93.184.216.34"),
      fetchImpl: answersInOrder(
        redirectTo("https://fhir.example/2"),
        redirectTo("https://fhir.example/3"),
        redirectTo("https://fhir.example/4"),
      ),
    });

    expect(refusalOf(result)).toBe("too-many-redirects");
  });

  // A registration request is not idempotent and a registration endpoint has no
  // legitimate reason to redirect, so replaying the statement at a second address is
  // refused rather than attempted.
  it("does not follow a redirect for a request with a body", async () => {
    const result = await outboundFetch("https://fhir.example/register", {
      method: "POST",
      body: "{}",
      resolve: resolvesTo("93.184.216.34"),
      fetchImpl: answersInOrder(redirectTo("https://elsewhere.example/")),
    });

    expect(refusalOf(result)).toBe("redirect-not-followed");
  });

  it("treats a redirect status with no location as the response it is", async () => {
    const result = await outboundFetch("https://fhir.example/base", {
      resolve: resolvesTo("93.184.216.34"),
      fetchImpl: answersWith(new Response("", { status: 302 })),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe(302);
    }
  });
});

describe("outboundFetch failures", () => {
  // Distinct from a connection refusal, because the event view says which it was: a
  // slow server and a dead one are different problems for the owner to fix.
  it("reports a timeout as a timeout", async () => {
    const result = await outboundFetch("https://slow.example/base", {
      timeoutMs: 5,
      resolve: resolvesTo("93.184.216.34"),
      // Waits for the abort the guard arms, which is the real path rather than a
      // fabricated error.
      fetchImpl: async (_url, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "TimeoutError"));
          });
        }),
    });

    expect(refusalOf(result)).toBe("timeout");
  });

  it("reports a connection failure as refused", async () => {
    const result = await outboundFetch("https://down.example/base", {
      resolve: resolvesTo("93.184.216.34"),
      fetchImpl: async () => {
        await Promise.resolve();
        throw new TypeError("fetch failed");
      },
    });

    expect(refusalOf(result)).toBe("refused");
  });
});
