/**
 * That a vendor can read the anchor's keys and the profile without an account.
 *
 * Scenario 5 is one sentence with two halves - the keys and the documentation are both
 * publicly readable, and the keys carry identifiers that allow rotation - and this suite is
 * both halves plus the thing that keeps them honest: the embedded contract must still be the
 * contract. `apps/server/src/http/docs/*.md` are copies, shipped inside the bundle because
 * the runtime image has no specification directory, and a copy that drifted from the
 * vendor-facing original would be documentation that lies about what Signet must implement.
 *
 * Author: John Grimes
 */

import { findActiveSigningKey, hasTestDatabase } from "@muster/db";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

import registrationProfile from "./docs/registrationProfile.md" with { type: "text" };
import ticketProfile from "./docs/ticketProfile.md" with { type: "text" };
import { PUBLIC_REQUESTS } from "../api/router.js";
import { apiRequest } from "../test/api.js";
import { createTestStack } from "../test/harness.js";

import type { TestStack } from "../test/harness.js";

/** Where the vendor-facing originals live, when the specification bundle is present. */
const CONTRACTS = ".local/specs/001-participant-directory/contracts";

describe("the embedded profile documentation", () => {
  /** Each embedded copy, against the vendor-facing original it was taken from. */
  const copies: readonly {
    readonly name: string;
    readonly embedded: string;
  }[] = [
    { name: "registration-profile.md", embedded: registrationProfile },
    { name: "ticket-profile.md", embedded: ticketProfile },
  ];

  for (const { name, embedded } of copies) {
    it(`is byte-identical to ${name}`, () => {
      const original = `${CONTRACTS}/${name}`;
      if (!existsSync(original)) {
        // The specifications are not in the published repository, so this assertion holds
        // only where they are. Reported rather than silently passed.
        console.warn(
          `skipping the drift check for ${name}: ${original} is not present`,
        );
        return;
      }

      expect(embedded).toBe(readFileSync(original, "utf8"));
    });
  }

  it("carries the claim table a vendor implements against", () => {
    // A smoke check on the copy itself, so a truncated file fails here rather than as an
    // empty page somebody notices at a connectathon.
    expect(registrationProfile).toContain("software_statement");
    expect(registrationProfile).toContain(
      "Validation rules a server MUST apply",
    );
    expect(ticketProfile).toContain("smart_scopes");
  });
});

describe.skipIf(!hasTestDatabase())("the anchor's public surface", () => {
  let stack: TestStack;

  beforeAll(async () => {
    stack = await createTestStack();
  });

  afterAll(async () => {
    await stack.close();
  });

  describe("the JWKS", () => {
    it("is readable without an account (FR-024, scenario 5)", async () => {
      const response = await apiRequest(stack, "GET", "/.well-known/jwks.json");

      expect(response.status).toBe(200);
      // RFC 7517 §8.5. Several JWKS clients accept only this or `application/json`.
      expect(response.headers.get("content-type")).toContain(
        "application/jwk-set+json",
      );
    });

    it("is cacheable and cross-origin readable", async () => {
      const response = await apiRequest(stack, "GET", "/.well-known/jwks.json");

      // A vendor's verifier fetches this on every unknown `kid`; a short cache keeps that
      // from being one request per registration.
      expect(response.headers.get("cache-control")).toContain("max-age");
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
    });

    it("publishes the active key of both purposes", async () => {
      const body = (await (
        await apiRequest(stack, "GET", "/.well-known/jwks.json")
      ).json()) as { keys: { kid: string; alg: string; use: string }[] };
      const [statements, tickets] = await Promise.all([
        findActiveSigningKey(stack.db, "statements"),
        findActiveSigningKey(stack.db, "tickets"),
      ]);
      const kids = body.keys.map((key) => key.kid);

      // Both purposes, from the first request: a vendor configuring Muster as a trust anchor
      // should not have to wait for User Story 8 for the second key to appear (FR-024).
      expect(kids).toContain(statements?.kid ?? "no active statements key");
      expect(kids).toContain(tickets?.kid ?? "no active tickets key");
      expect(body.keys.every((key) => key.alg === "ES256")).toBe(true);
      expect(body.keys.every((key) => key.use === "sig")).toBe(true);
      // No duplicates: a `kid` names one key, so two entries sharing one would make
      // verification ambiguous. The document may also carry superseded keys, which is
      // principle VI and is asserted in `keys.test.ts`.
      expect(new Set(kids).size).toBe(kids.length);
    });

    it("publishes no private key material", async () => {
      const text = await (
        await apiRequest(stack, "GET", "/.well-known/jwks.json")
      ).text();
      const body = JSON.parse(text) as { keys: Record<string, unknown>[] };

      for (const key of body.keys) {
        expect(key).not.toHaveProperty("d");
      }
      expect(text).not.toContain('"d"');
    });
  });

  describe("the docs pages", () => {
    it.each([
      [
        "/docs/registration-profile",
        "trusted dynamic client registration profile",
      ],
      ["/docs/ticket-profile", "permission ticket profile"],
    ])("renders %s without an account (FR-028)", async (path, heading) => {
      const response = await apiRequest(stack, "GET", path);

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/html");
      const html = await response.text();
      // Rendered, not served as markdown: a heading is an element rather than a hash.
      expect(html).toContain("<h1");
      expect(html.toLowerCase()).toContain(heading);
    });

    it("renders the claim table as a table", async () => {
      const html = await (
        await apiRequest(stack, "GET", "/docs/registration-profile")
      ).text();

      // The claim set is the thing a vendor reads off this page, and it is a table in the
      // contract. A renderer that dropped tables would leave the page useless.
      expect(html).toContain("<table");
      expect(html).toContain("software_statement");
      expect(html).toContain("muster_event");
    });

    it("names this deployment's own JWKS address, not an example (FR-028)", async () => {
      const html = await (
        await apiRequest(stack, "GET", "/docs/registration-profile")
      ).text();

      // Every public URL derives from MUSTER_PUBLIC_URL, and a vendor reading the profile
      // needs the address of *this* anchor rather than the contract's placeholder.
      expect(html).toContain("https://muster.test/.well-known/jwks.json");
      expect(html).not.toContain("{MUSTER_PUBLIC_URL}");
    });

    it("offers the current key identifiers beside the address", async () => {
      const jwks = (await (
        await apiRequest(stack, "GET", "/.well-known/jwks.json")
      ).json()) as { keys: { kid: string }[] };
      const html = await (
        await apiRequest(stack, "GET", "/docs/registration-profile")
      ).text();

      for (const key of jwks.keys) {
        expect(html).toContain(key.kid);
      }
    });

    it("answers 404 for a page it does not have", async () => {
      const response = await apiRequest(stack, "GET", "/docs/nonsense-profile");

      // The console owns `/docs` itself, so an unknown subpath must not silently become the
      // single-page application's shell and render an empty documentation page.
      expect(response.status).toBe(404);
    });
  });

  describe("the public declaration", () => {
    it.each([
      "GET /.well-known/jwks.json",
      "GET /docs/registration-profile",
      "GET /docs/ticket-profile",
    ])("declares %s as public, with a reason", (request) => {
      // The anchor's keys and the profile are the two things a vendor reads before they have
      // anything else, so they are anonymous by design rather than by omission.
      expect(PUBLIC_REQUESTS[request]).toBeString();
      expect((PUBLIC_REQUESTS[request] ?? "").length).toBeGreaterThan(0);
    });
  });
});
