/*
 * Copyright © 2026 Commonwealth Scientific and Industrial Research Organisation
 * (CSIRO) ABN 41 687 119 230. Licensed under the Apache License, Version 2.0.
 */

import { describe, expect, test } from "bun:test";

import { guardedAddressReason, outboundFetch } from "./outboundFetch.ts";

import type { AddressResolver, OutboundResult } from "./outboundFetch.ts";

/**
 * Muster's whole job is fetching addresses that strangers typed in, so this is
 * the security boundary that matters most. Every test here either proves an
 * address range is refused, or proves no request was issued for it.
 */

/** Records what an injected fetch was asked to do. */
type FetchCall = { readonly url: string; readonly init: RequestInit };

/** An injected fetch, together with the calls it saw. */
type StubFetch = {
  readonly calls: FetchCall[];
  readonly implementation: (
    url: string,
    init: RequestInit,
  ) => Promise<Response>;
};

// Answers each call from a queue of responses, failing if the queue runs dry -
// an unexpected request is exactly what these tests are looking for.
const stubFetch = (responses: readonly Response[]): StubFetch => {
  const calls: FetchCall[] = [];
  const queue = [...responses];
  return {
    calls,
    implementation: (url, init) => {
      calls.push({ url, init });
      const response = queue.shift();
      if (response === undefined) {
        throw new Error(`unexpected outbound request to ${url}`);
      }
      return Promise.resolve(response);
    },
  };
};

// Resolves every host to the given addresses, recording the hosts asked about.
const stubResolver = (
  addresses: readonly string[],
  asked: string[] = [],
): AddressResolver => {
  return (host) => {
    asked.push(host);
    return Promise.resolve(addresses);
  };
};

// Reads the refusal from a result, failing the test if the request succeeded.
const refusalOf = (result: OutboundResult) => {
  if (result.ok) {
    throw new Error("expected the request to be refused");
  }
  return result.refusal;
};

describe("guardedAddressReason", () => {
  // Each entry is an address that must never be reached, and the word the
  // refusal has to contain so the user is told why.
  const guarded: readonly [string, RegExp][] = [
    ["127.0.0.1", /loopback/i],
    ["127.1.2.3", /loopback/i],
    ["10.0.0.1", /private/i],
    ["172.16.0.1", /private/i],
    ["172.31.255.255", /private/i],
    ["192.168.1.1", /private/i],
    ["169.254.1.1", /link-local/i],
    ["169.254.169.254", /metadata/i],
    ["100.64.0.1", /carrier-grade/i],
    ["100.100.100.200", /carrier-grade/i],
    ["0.0.0.0", /unspecified/i],
    ["192.0.0.1", /reserved/i],
    ["198.18.0.1", /benchmark/i],
    ["224.0.0.1", /multicast/i],
    ["240.0.0.1", /reserved/i],
    ["255.255.255.255", /reserved/i],
    ["::1", /loopback/i],
    ["::", /unspecified/i],
    ["fd00::1", /unique local/i],
    ["fc00::1", /unique local/i],
    ["fd00:ec2::254", /unique local/i],
    ["fe80::1", /link-local/i],
    ["ff02::1", /multicast/i],
    // An IPv4-mapped address must be unwrapped, not waved through as IPv6.
    ["::ffff:127.0.0.1", /loopback/i],
    ["::ffff:169.254.169.254", /metadata/i],
    ["::127.0.0.1", /loopback/i],
  ];

  for (const [address, expected] of guarded) {
    test(`refuses ${address}`, () => {
      expect(guardedAddressReason(address)).toMatch(expected);
    });
  }

  // Addresses immediately outside a guarded range must still be reachable,
  // otherwise the guard quietly breaks legitimate participants.
  const permitted = [
    "203.0.113.7",
    "11.0.0.1",
    "172.32.0.1",
    "172.15.255.255",
    "100.63.255.255",
    "100.128.0.1",
    "192.0.1.1",
    "198.20.0.1",
    "223.255.255.255",
    "2606:4700::1111",
  ];

  for (const address of permitted) {
    test(`permits ${address}`, () => {
      expect(guardedAddressReason(address)).toBeUndefined();
    });
  }

  // Deny by default: something that is not an address at all is a refusal, not
  // a pass-through.
  test("refuses anything that is not an IP address", () => {
    for (const value of [
      "",
      "not-an-address",
      "1.2.3",
      "1.2.3.4.5",
      "12345::",
    ]) {
      expect(guardedAddressReason(value)).toMatch(/not an IP address/i);
    }
  });
});

describe("outboundFetch", () => {
  test("fetches a public target, passing the method and headers through", async () => {
    const fetcher = stubFetch([
      Response.json({ client_id: "abc" }, { status: 201 }),
    ]);

    const result = await outboundFetch("https://server.example.org/register", {
      request: {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"software_statement":"..."}',
      },
      resolve: stubResolver(["203.0.113.7"]),
      fetchImplementation: fetcher.implementation,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.response.status).toBe(201);
    }
    expect(fetcher.calls).toHaveLength(1);
    expect(fetcher.calls[0].url).toBe("https://server.example.org/register");
    expect(fetcher.calls[0].init.method).toBe("POST");
    expect(fetcher.calls[0].init.redirect).toBe("manual");
  });

  // The point of the guard: no packet leaves for a guarded address.
  test("refuses a private target without issuing a request", async () => {
    const fetcher = stubFetch([]);

    const result = await outboundFetch("https://internal.example.org/fhir", {
      resolve: stubResolver(["10.1.2.3"]),
      fetchImplementation: fetcher.implementation,
    });

    expect(refusalOf(result).failureMode).toBe("guarded");
    expect(refusalOf(result).detail).toMatch(/private/i);
    expect(refusalOf(result).detail).toContain("10.1.2.3");
    expect(fetcher.calls).toHaveLength(0);
  });

  test("refuses a literal guarded address without resolving it", async () => {
    const asked: string[] = [];
    const fetcher = stubFetch([]);

    const result = await outboundFetch("http://127.0.0.1:8080/fhir", {
      resolve: stubResolver(["203.0.113.7"], asked),
      fetchImplementation: fetcher.implementation,
    });

    expect(refusalOf(result).failureMode).toBe("guarded");
    expect(asked).toEqual([]);
    expect(fetcher.calls).toHaveLength(0);
  });

  // A host that answers with both a public and a private address is a classic
  // way past a guard that only checks the first answer.
  test("refuses when any resolved address is guarded", async () => {
    const fetcher = stubFetch([]);

    const result = await outboundFetch("https://split.example.org/fhir", {
      resolve: stubResolver(["203.0.113.7", "169.254.169.254"]),
      fetchImplementation: fetcher.implementation,
    });

    expect(refusalOf(result).failureMode).toBe("guarded");
    expect(refusalOf(result).detail).toMatch(/metadata/i);
    expect(fetcher.calls).toHaveLength(0);
  });

  test("refuses a scheme that is not http or https", async () => {
    const fetcher = stubFetch([]);

    for (const url of [
      "file:///etc/passwd",
      "ftp://example.org/x",
      "not a url",
    ]) {
      const result = await outboundFetch(url, {
        resolve: stubResolver(["203.0.113.7"]),
        fetchImplementation: fetcher.implementation,
      });
      expect(refusalOf(result).failureMode).toBe("invalid");
    }
    expect(fetcher.calls).toHaveLength(0);
  });

  test("reports a host that does not resolve as unreachable", async () => {
    const fetcher = stubFetch([]);

    const result = await outboundFetch("https://absent.example.org/fhir", {
      resolve: () => Promise.reject(new Error("getaddrinfo ENOTFOUND")),
      fetchImplementation: fetcher.implementation,
    });

    expect(refusalOf(result).failureMode).toBe("refused");
    expect(fetcher.calls).toHaveLength(0);
  });

  test("reports a connection failure as refused", async () => {
    const result = await outboundFetch("https://server.example.org/fhir", {
      resolve: stubResolver(["203.0.113.7"]),
      fetchImplementation: () =>
        Promise.reject(new TypeError("Unable to connect")),
    });

    expect(refusalOf(result).failureMode).toBe("refused");
    expect(refusalOf(result).detail).toMatch(/unable to connect/i);
  });

  // The timeout is a real deadline on the whole exchange, and it is enforced
  // through the abort signal the caller can see.
  test("times out a request that never answers", async () => {
    const result = await outboundFetch("https://slow.example.org/fhir", {
      timeoutMs: 5,
      resolve: stubResolver(["203.0.113.7"]),
      fetchImplementation: (_url, init) => {
        const { promise, reject } = Promise.withResolvers<Response>();
        init.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "TimeoutError"));
        });
        return promise;
      },
    });

    expect(refusalOf(result).failureMode).toBe("timeout");
  });

  test("follows a redirect to a permitted address", async () => {
    const fetcher = stubFetch([
      new Response(null, { status: 302, headers: { location: "/moved" } }),
      Response.json({ ok: true }),
    ]);

    const result = await outboundFetch("https://server.example.org/fhir", {
      resolve: stubResolver(["203.0.113.7"]),
      fetchImplementation: fetcher.implementation,
    });

    expect(result.ok).toBe(true);
    expect(fetcher.calls).toHaveLength(2);
    // A relative Location is resolved against the URL it came from.
    expect(fetcher.calls[1].url).toBe("https://server.example.org/moved");
  });

  test("refuses a redirect into a guarded range and issues no further request", async () => {
    const fetcher = stubFetch([
      new Response(null, {
        status: 307,
        headers: { location: "http://169.254.169.254/latest/meta-data/" },
      }),
    ]);

    const result = await outboundFetch("https://server.example.org/fhir", {
      resolve: stubResolver(["203.0.113.7"]),
      fetchImplementation: fetcher.implementation,
    });

    expect(refusalOf(result).failureMode).toBe("guarded");
    expect(refusalOf(result).detail).toMatch(/metadata/i);
    expect(fetcher.calls).toHaveLength(1);
  });

  test("refuses a redirect with no Location header", async () => {
    const fetcher = stubFetch([new Response(null, { status: 302 })]);

    const result = await outboundFetch("https://server.example.org/fhir", {
      resolve: stubResolver(["203.0.113.7"]),
      fetchImplementation: fetcher.implementation,
    });

    expect(refusalOf(result).failureMode).toBe("invalid");
    expect(refusalOf(result).detail).toMatch(/location/i);
  });

  test("refuses a redirect chain longer than the limit", async () => {
    const fetcher = stubFetch([
      new Response(null, { status: 302, headers: { location: "/one" } }),
      new Response(null, { status: 302, headers: { location: "/two" } }),
      new Response(null, { status: 302, headers: { location: "/three" } }),
    ]);

    const result = await outboundFetch("https://server.example.org/fhir", {
      maxRedirects: 2,
      resolve: stubResolver(["203.0.113.7"]),
      fetchImplementation: fetcher.implementation,
    });

    expect(refusalOf(result).failureMode).toBe("invalid");
    expect(refusalOf(result).detail).toMatch(/redirect/i);
    expect(fetcher.calls).toHaveLength(3);
  });

  test("drops the method and body when a 303 redirect is followed", async () => {
    const fetcher = stubFetch([
      new Response(null, { status: 303, headers: { location: "/result" } }),
      Response.json({ ok: true }),
    ]);

    await outboundFetch("https://server.example.org/register", {
      request: { method: "POST", body: "{}" },
      resolve: stubResolver(["203.0.113.7"]),
      fetchImplementation: fetcher.implementation,
    });

    expect(fetcher.calls[1].init.method).toBe("GET");
    expect(fetcher.calls[1].init.body).toBeUndefined();
  });

  test("keeps the method when a 307 redirect is followed", async () => {
    const fetcher = stubFetch([
      new Response(null, { status: 307, headers: { location: "/result" } }),
      Response.json({ ok: true }),
    ]);

    await outboundFetch("https://server.example.org/register", {
      request: { method: "POST", body: "{}" },
      resolve: stubResolver(["203.0.113.7"]),
      fetchImplementation: fetcher.implementation,
    });

    expect(fetcher.calls[1].init.method).toBe("POST");
  });

  // The allowlist is how the compose stack and the test suites reach stubs on
  // addresses the guard exists to refuse. It is explicit, configured, and
  // nothing else gets that treatment.
  test("honours an allowlisted host the guard would otherwise refuse", async () => {
    const asked: string[] = [];
    const fetcher = stubFetch([Response.json({ ok: true })]);

    const result = await outboundFetch("http://localhost:9000/register", {
      allowedHosts: ["localhost:9000"],
      resolve: stubResolver(["127.0.0.1"], asked),
      fetchImplementation: fetcher.implementation,
    });

    expect(result.ok).toBe(true);
    // An allowlisted host is not resolved: there is nothing to decide.
    expect(asked).toEqual([]);
  });

  test("matches an allowlist entry without a port on any port", async () => {
    const fetcher = stubFetch([Response.json({ ok: true })]);

    const result = await outboundFetch("http://stub-register:9000/register", {
      allowedHosts: ["stub-register"],
      resolve: stubResolver(["10.0.0.5"]),
      fetchImplementation: fetcher.implementation,
    });

    expect(result.ok).toBe(true);
  });

  test("does not let an allowlist entry with a port match another port", async () => {
    const fetcher = stubFetch([]);

    const result = await outboundFetch("http://localhost:9001/register", {
      allowedHosts: ["localhost:9000"],
      resolve: stubResolver(["127.0.0.1"]),
      fetchImplementation: fetcher.implementation,
    });

    expect(refusalOf(result).failureMode).toBe("guarded");
    expect(fetcher.calls).toHaveLength(0);
  });

  test("re-applies the guard to the target of a redirect from an allowlisted host", async () => {
    const fetcher = stubFetch([
      new Response(null, {
        status: 302,
        headers: { location: "http://10.0.0.1/inside" },
      }),
    ]);

    const result = await outboundFetch("http://localhost:9000/register", {
      allowedHosts: ["localhost:9000"],
      resolve: stubResolver(["127.0.0.1"]),
      fetchImplementation: fetcher.implementation,
    });

    expect(refusalOf(result).failureMode).toBe("guarded");
    expect(fetcher.calls).toHaveLength(1);
  });
});
