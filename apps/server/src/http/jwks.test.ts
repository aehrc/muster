import { jwksSchema } from "@muster/contracts";
import { describeDatabase } from "@muster/db/test/harness";
import { afterAll, beforeAll, expect, test } from "bun:test";

import { readJson, request, startTestServer } from "../test/support.ts";

import type { TestServer } from "../test/support.ts";

/**
 * The trust anchor's public face: the key set, and the profile documentation.
 *
 * Acceptance scenario 5 is the whole of this suite. A vendor implementing the
 * registration profile has no account with Muster and no reason to get one, so
 * both the keys they verify against and the document they implement from have to
 * be readable by anybody. The keys carry identifiers, which is what lets Muster
 * rotate without invalidating statements already in flight.
 *
 * The documentation is server-rendered rather than left to the console, because a
 * profile that can only be read by running JavaScript is a profile that cannot be
 * read from a terminal, quoted in an email, or fetched by a script.
 */

describeDatabase("the trust anchor's public routes", () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startTestServer("jwks");
  });

  afterAll(async () => {
    await server.close();
  });

  // The keys ---------------------------------------------------------------

  // FR-024: a stable public address, readable without an account.
  test("publishes the key set to anyone who asks", async () => {
    const response = await request(server, "GET", "/.well-known/jwks.json");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    const jwks = await readJson(response, jwksSchema);
    expect(jwks.keys.length).toBeGreaterThan(0);
  });

  // Both purposes are published from one address, and each key says which it is,
  // so an implementer does not have to guess which key signs what.
  test("publishes a key for each purpose, carrying its identifier", async () => {
    const jwks = await readJson(
      await request(server, "GET", "/.well-known/jwks.json"),
      jwksSchema,
    );

    expect(jwks.keys.map((key) => key.muster_purpose).sort()).toEqual([
      "statements",
      "tickets",
    ]);
    for (const key of jwks.keys) {
      expect(key.alg).toBe("ES256");
      expect(key.use).toBe("sig");
      expect(key.kid.length).toBeGreaterThan(0);
      // The published half is the public half: no private scalar, ever.
      expect(key).not.toHaveProperty("d");
    }
  });

  // The keys are generated on demand, so a deployment publishes a usable key set
  // from its first request rather than after somebody remembers to mint one.
  test("answers with the same keys on a second read", async () => {
    const first = await readJson(
      await request(server, "GET", "/.well-known/jwks.json"),
      jwksSchema,
    );
    const second = await readJson(
      await request(server, "GET", "/.well-known/jwks.json"),
      jwksSchema,
    );

    expect(second.keys.map((key) => key.kid)).toEqual(
      first.keys.map((key) => key.kid),
    );
  });

  // The profile requires that verification against a stale cache must not succeed
  // once a key has been withdrawn, so the answer is cacheable only briefly and
  // cross-origin readable, since the servers reading it are browsers as often as
  // not.
  test("permits only a short cache and any origin", async () => {
    const response = await request(server, "GET", "/.well-known/jwks.json");

    expect(response.headers.get("cache-control")).toContain("max-age=60");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  });

  // The documentation ------------------------------------------------------

  // FR-028: the statement's contents, the rules a server must apply, the key
  // location, the expiry semantics, and a worked example.
  test("renders the registration profile without an account", async () => {
    const response = await request(server, "GET", "/docs/registration-profile");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const page = await response.text();

    // Every claim the profile's table states, by name.
    for (const claim of [
      "iss",
      "sub",
      "software_id",
      "jti",
      "iat",
      "exp",
      "muster_event",
      "client_name",
      "redirect_uris",
      "grant_types",
      "token_endpoint_auth_method",
      "scope",
      "smart_launch_url",
    ]) {
      expect(page).toContain(claim);
    }

    // The validation rules and the error vocabulary a server must produce.
    expect(page).toContain("invalid_software_statement");
    expect(page).toContain("invalid_client_metadata");
    expect(page).toContain("invalid_request");
    expect(page).toContain("software_statement");

    // The key location and the issuer, both derived from MUSTER_PUBLIC_URL.
    expect(page).toContain(`${server.config.publicUrl}/.well-known/jwks.json`);
    expect(page).toContain(server.config.publicUrl);

    // The expiry semantics.
    expect(page).toContain("grace");
  });

  // The ticket profile is the other half of what an implementer needs, and the
  // playground mints against it (US8), so it is published from the same place.
  test("renders the ticket profile without an account", async () => {
    const response = await request(server, "GET", "/docs/ticket-profile");

    expect(response.status).toBe(200);
    const page = await response.text();

    expect(page).toContain("ticket_type");
    expect(page).toContain("patient-self-access");
    expect(page).toContain("smart_scopes");
    expect(page).toContain("muster_event");
    expect(page).toContain("http://ns.electronichealth.net.au/id/hi/ihi/1.0");
    expect(page).toContain("urn:ietf:params:oauth:grant-type:token-exchange");
    expect(page).toContain("smart_permission_ticket_types_supported");
  });

  // One index, so an implementer handed `/docs` finds both profiles.
  test("lists the profiles it publishes", async () => {
    const response = await request(server, "GET", "/docs");

    expect(response.status).toBe(200);
    const page = await response.text();
    expect(page).toContain("/docs/registration-profile");
    expect(page).toContain("/docs/ticket-profile");
  });

  // The same process serves the console, so a reader who arrives at a profile
  // from a search engine or a vendor's email has a way into the rest of Muster.
  test.each(["/docs", "/docs/registration-profile"])(
    "links %p back to the console",
    async (path) => {
      const response = await request(server, "GET", path);

      expect(response.status).toBe(200);
      expect(await response.text()).toContain('<a href="/">Muster</a>');
    },
  );

  // A document Muster does not publish is a 404 in the error envelope, like
  // every other refusal on the wire.
  test("answers an unknown document as not found", async () => {
    const response = await request(server, "GET", "/docs/no-such-profile");

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: "not_found" });
  });
});
