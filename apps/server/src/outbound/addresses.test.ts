/**
 * The address classifier, which is the whole of the guard's judgement.
 *
 * Every case here is a way a participant could write an address that reaches
 * something Muster must not reach. The bypasses matter more than the happy path: a
 * classifier that reads `0177.0.0.1`, `2130706433` or `::ffff:127.0.0.1` as public
 * refuses nothing at all, and the entry it was asked to check would be fetched from
 * inside the cluster.
 *
 * Author: John Grimes
 */

import { describe, expect, it } from "bun:test";

import {
  classifyIpAddress,
  isFetchableAddress,
  parseIpv4,
  parseIpv6,
} from "./addresses.js";

describe("parseIpv4", () => {
  it("parses four plain decimal octets", () => {
    expect(parseIpv4("203.0.113.9")).toEqual(new Uint8Array([203, 0, 113, 9]));
  });

  // `inet_aton` accepts all of these as 127.0.0.1, and none of them look like
  // loopback to a naive string check. Refusing them here means the classifier sees
  // the same address the network stack will.
  it("refuses the forms that resolvers accept and filters miss", () => {
    expect(parseIpv4("0177.0.0.1")).toBeUndefined();
    expect(parseIpv4("2130706433")).toBeUndefined();
    expect(parseIpv4("127.1")).toBeUndefined();
    expect(parseIpv4("127.0.0.1.5")).toBeUndefined();
    expect(parseIpv4("127.0.0.256")).toBeUndefined();
    expect(parseIpv4("127.0.0.-1")).toBeUndefined();
    expect(parseIpv4("127.0.0.0x1")).toBeUndefined();
  });
});

describe("parseIpv6", () => {
  it("parses a full address", () => {
    expect(parseIpv6("2001:db8:0:0:0:0:0:1")?.length).toBe(16);
  });

  it("parses the elided form, with or without brackets", () => {
    expect(parseIpv6("::1")!.slice(14)).toEqual(new Uint8Array([0, 1]));
    expect(parseIpv6("[::1]")!.slice(14)).toEqual(new Uint8Array([0, 1]));
  });

  it("parses an embedded IPv4 tail", () => {
    // `::ffff:127.0.0.1` is the IPv4-mapped form and reaches an IPv4 destination.
    expect(parseIpv6("::ffff:127.0.0.1")!.slice(12)).toEqual(
      new Uint8Array([127, 0, 0, 1]),
    );
  });

  it("refuses malformed addresses", () => {
    expect(parseIpv6("")).toBeUndefined();
    expect(parseIpv6("::1::2")).toBeUndefined();
    expect(parseIpv6("1:2:3:4:5:6:7")).toBeUndefined();
    expect(parseIpv6("1:2:3:4:5:6:7:8:9")).toBeUndefined();
    expect(parseIpv6("::fffff:1")).toBeUndefined();
    expect(parseIpv6("::ffff:127.0.0.999")).toBeUndefined();
    // A zone identifier is not valid in a URL host and makes an address
    // non-comparable.
    expect(parseIpv6("fe80::1%eth0")).toBeUndefined();
  });
});

describe("classifyIpAddress", () => {
  it("classifies publicly routable addresses as public", () => {
    expect(classifyIpAddress("8.8.8.8")).toBe("public");
    expect(classifyIpAddress("2404:6800:4006:80c::200e")).toBe("public");
  });

  it("classifies the ranges the guard must refuse", () => {
    expect(classifyIpAddress("0.0.0.0")).toBe("unspecified");
    expect(classifyIpAddress("::")).toBe("unspecified");
    expect(classifyIpAddress("127.0.0.1")).toBe("loopback");
    expect(classifyIpAddress("::1")).toBe("loopback");
    expect(classifyIpAddress("10.1.2.3")).toBe("private");
    expect(classifyIpAddress("172.16.0.1")).toBe("private");
    expect(classifyIpAddress("172.31.255.255")).toBe("private");
    expect(classifyIpAddress("192.168.1.1")).toBe("private");
    expect(classifyIpAddress("fd00::1")).toBe("unique-local");
    expect(classifyIpAddress("100.64.0.1")).toBe("shared");
    expect(classifyIpAddress("fe80::1")).toBe("link-local");
    expect(classifyIpAddress("224.0.0.1")).toBe("multicast");
    expect(classifyIpAddress("ff02::1")).toBe("multicast");
    expect(classifyIpAddress("255.255.255.255")).toBe("reserved");
    expect(classifyIpAddress("240.0.0.1")).toBe("reserved");
    expect(classifyIpAddress("192.0.2.1")).toBe("documentation");
    expect(classifyIpAddress("2001:db8::1")).toBe("documentation");
    expect(classifyIpAddress("198.18.0.1")).toBe("benchmarking");
  });

  // The address a cloud provider answers with instance credentials on. It falls
  // under link-local, and this test exists so that stays true.
  it("classifies the cloud metadata address as link-local", () => {
    expect(classifyIpAddress("169.254.169.254")).toBe("link-local");
    expect(isFetchableAddress("169.254.169.254")).toBe(false);
  });

  // The oldest bypass of this kind of filter: an IPv6 literal that reaches an IPv4
  // destination must be judged as the address it carries.
  it("classifies an IPv4-mapped address as the address it carries", () => {
    expect(classifyIpAddress("::ffff:127.0.0.1")).toBe("loopback");
    expect(classifyIpAddress("::ffff:10.0.0.1")).toBe("private");
    expect(classifyIpAddress("[::ffff:169.254.169.254]")).toBe("link-local");
    expect(classifyIpAddress("::ffff:8.8.8.8")).toBe("public");
  });

  // 6to4 and Teredo tunnel to an arbitrary IPv4 destination, so an address in
  // either can reach a private network without looking like it.
  it("refuses the tunnelling ranges", () => {
    expect(classifyIpAddress("2002::1")).toBe("reserved");
    expect(classifyIpAddress("2001:0:1:2::3")).toBe("reserved");
  });

  it("reports a DNS name as unclassifiable rather than guessing", () => {
    // A name has to be resolved before it can be judged; saying anything else here
    // would be the guard answering a question it has not asked yet.
    expect(classifyIpAddress("muster.example")).toBeUndefined();
    expect(classifyIpAddress("")).toBeUndefined();
  });
});

describe("isFetchableAddress", () => {
  it("admits only public addresses", () => {
    expect(isFetchableAddress("8.8.8.8")).toBe(true);
    expect(isFetchableAddress("127.0.0.1")).toBe(false);
  });

  // A gate must never read "I could not tell what this is" as yes.
  it("refuses anything it cannot parse", () => {
    expect(isFetchableAddress("muster.example")).toBe(false);
    expect(isFetchableAddress("not an address")).toBe(false);
  });
});
