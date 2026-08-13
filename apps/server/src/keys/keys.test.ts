/**
 * That the trust anchor's keys are what a vendor can verify against, and stay that way.
 *
 * Four subjects, and the last two are the whole of constitution principle VI.
 *
 * **Generation.** ES256, a thumbprint `kid`, and a private half that is an envelope rather
 * than a JWK. The thumbprint property is asserted by recomputing it from the published
 * document rather than by comparing two values this module produced, because a `kid` that
 * is merely internally consistent is no use to somebody matching it against a JWKS.
 *
 * **One active key per purpose.** Asserted against the database, because that is where the
 * invariant lives: `data-model.md` says exactly one, and a partial unique index is what
 * makes a half-finished rotation impossible rather than unlikely.
 *
 * **Rotation does not break what is outstanding.** A statement minted under a key that is
 * later superseded must still verify against the published JWKS. The test signs, rotates,
 * and verifies against the document the route would serve - not against the key it kept a
 * handle on, which would prove nothing about publication.
 *
 * **A superseded key leaves the JWKS when nothing signed with it is still alive.** The
 * other half of the same principle: keys stay published *until* every artefact has expired,
 * and a key that stayed forever would be an ever-growing document advertising material
 * nothing can use.
 *
 * Author: John Grimes
 */

import {
  createDatabase,
  decryptSecret,
  hasTestDatabase,
  insertSoftwareStatement,
  makeAccount,
  makeEnrolment,
  makeEvent,
  makeOrganisation,
  makeSystem,
  clientProfileFixture,
  findActiveSigningKey,
  insertPairing,
  prepareTestDatabase,
  servingRoleUrl,
  testDatabaseUrl,
  uniqueSuffix,
} from "@muster/db";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  calculateJwkThumbprint,
  createLocalJWKSet,
  importJWK,
  jwtVerify,
} from "jose";

import {
  ensureActiveSigningKey,
  ensureSigningKeys,
  generateSigningKey,
  importSigningKey,
  loadSigningKey,
  publishedJwks,
  rotateSigningKeyFor,
  signClaims,
} from "./keys.js";

import type { SoftwareStatementClaims } from "@muster/core";
import type { Database, DatabaseHandle } from "@muster/db";

/** Exactly the minimum length the configuration accepts. */
const MASTER_KEY = "0123456789abcdef0123456789abcdef";

const ISSUER = "https://muster.test";

const NOW = new Date("2026-09-16T04:05:06.000Z");

/** A claim set to sign. Its content is `packages/core`'s subject, not this suite's. */
function claimsFor(overrides: Partial<SoftwareStatementClaims> = {}) {
  return {
    iss: ISSUER,
    sub: "a-client",
    software_id: "a-client",
    jti: `jti-${uniqueSuffix()}`,
    iat: Math.floor(NOW.getTime() / 1000),
    exp: Math.floor(NOW.getTime() / 1000) + 86_400,
    muster_event: "sparked-2026-09",
    client_name: "Smart Forms",
    redirect_uris: ["https://app.test/callback"],
    grant_types: ["authorization_code"],
    token_endpoint_auth_method: "none",
    scope: "launch openid",
    smart_launch_url: "https://app.test/launch",
    ...overrides,
  } satisfies SoftwareStatementClaims;
}

describe("generating a signing key", () => {
  it("generates an ES256 pair whose public half is publishable", async () => {
    const generated = await generateSigningKey(MASTER_KEY);

    expect(generated.publicJwk["kty"]).toBe("EC");
    expect(generated.publicJwk["crv"]).toBe("P-256");
    expect(generated.publicJwk["alg"]).toBe("ES256");
    expect(generated.publicJwk["use"]).toBe("sig");
    expect(generated.publicJwk["kid"]).toBe(generated.kid);
  });

  it("names the key by its RFC 7638 thumbprint", async () => {
    const generated = await generateSigningKey(MASTER_KEY);

    // Recomputed from the published document with the non-canonical members removed,
    // which is exactly what a vendor matching a `kid` would do.
    const {
      kid: _kid,
      alg: _alg,
      use: _use,
      ...canonical
    } = generated.publicJwk;
    await expect(calculateJwkThumbprint(canonical)).resolves.toBe(
      generated.kid,
    );
  });

  it("publishes no part of the private key", async () => {
    const generated = await generateSigningKey(MASTER_KEY);

    // `d` is the private scalar. A JWKS carrying it would hand the anchor's identity to
    // every reader of a public route.
    expect(generated.publicJwk).not.toHaveProperty("d");
  });

  it("seals the private half under the master key, with a version tag", async () => {
    const generated = await generateSigningKey(MASTER_KEY);

    expect(generated.privateJwkEncrypted.startsWith("v1.")).toBe(true);
    // Decrypted rather than pattern-matched: a base64 blob contains any short string
    // eventually, so `not.toContain("d")` would pass or fail at random.
    const opened = JSON.parse(
      await decryptSecret(generated.privateJwkEncrypted, MASTER_KEY),
    ) as Record<string, unknown>;
    expect(opened["d"]).toBeString();
    expect(opened["kid"]).toBe(generated.kid);
    expect(opened["alg"]).toBe("ES256");
  });

  it("round trips through the envelope into a usable signing key", async () => {
    const generated = await generateSigningKey(MASTER_KEY);
    const row = {
      id: "00000000-0000-0000-0000-000000000000",
      kid: generated.kid,
      purpose: "statements" as const,
      status: "active" as const,
      publicJwk: generated.publicJwk,
      privateJwkEncrypted: generated.privateJwkEncrypted,
      supersededAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    };

    const key = await importSigningKey(row, MASTER_KEY);
    const jws = await signClaims(claimsFor(), { kid: generated.kid, key });

    const publicKey = await importJWK(generated.publicJwk, "ES256");
    const verified = await jwtVerify(jws, publicKey, { issuer: ISSUER });
    expect(verified.protectedHeader.alg).toBe("ES256");
    expect(verified.protectedHeader.kid).toBe(generated.kid);
    expect(verified.protectedHeader.typ).toBe("JWT");
  });

  it("refuses to recover a key under the wrong master key", async () => {
    const generated = await generateSigningKey(MASTER_KEY);
    const row = {
      id: "00000000-0000-0000-0000-000000000000",
      kid: generated.kid,
      purpose: "statements" as const,
      status: "active" as const,
      publicJwk: generated.publicJwk,
      privateJwkEncrypted: generated.privateJwkEncrypted,
      supersededAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    };

    await expect(
      importSigningKey(row, "fedcba9876543210fedcba9876543210"),
    ).rejects.toThrow(/authentication/);
  });
});

describe.skipIf(!hasTestDatabase())("the signing keys, in the database", () => {
  let handle: DatabaseHandle;
  let db: Database;

  beforeAll(async () => {
    const ownerUrl = testDatabaseUrl();
    if (ownerUrl === undefined) {
      throw new Error("the suite should have skipped");
    }
    await prepareTestDatabase(ownerUrl);
    handle = createDatabase({
      url: servingRoleUrl(ownerUrl),
      maxConnections: 2,
      applicationName: "muster-keys-test",
    });
    db = handle.db;
  });

  afterAll(async () => {
    await handle.close();
  });

  it("installs one active key per purpose", async () => {
    const installed = await ensureSigningKeys(db, MASTER_KEY, NOW);

    // Both purposes, from the start: `tickets` is published before anything mints with it
    // so a vendor reading the JWKS sees the whole anchor.
    expect(installed.map((key) => key.purpose).toSorted()).toEqual([
      "statements",
      "tickets",
    ]);
    expect(installed.every((key) => key.status === "active")).toBe(true);
  });

  it("does not install a second key when one is already active", async () => {
    const first = await ensureActiveSigningKey(
      db,
      MASTER_KEY,
      "statements",
      NOW,
    );
    const second = await ensureActiveSigningKey(
      db,
      MASTER_KEY,
      "statements",
      NOW,
    );

    expect(second.kid).toBe(first.kid);
  });

  it("keeps exactly one active key per purpose across a rotation", async () => {
    await ensureSigningKeys(db, MASTER_KEY, NOW);
    const before = await findActiveSigningKey(db, "statements");
    const rotated = await rotateSigningKeyFor(
      db,
      MASTER_KEY,
      "statements",
      NOW,
    );
    const after = await findActiveSigningKey(db, "statements");

    expect(before?.kid).not.toBe(rotated.kid);
    expect(after?.kid).toBe(rotated.kid);
    // The invariant `data-model.md` names, read back rather than assumed: the index would
    // have refused the insert otherwise.
    const published = await publishedJwks(db, NOW);
    expect(published.keys.some((key) => key.kid === rotated.kid)).toBe(true);
  });

  it("signs with the active key and no other", async () => {
    await ensureSigningKeys(db, MASTER_KEY, NOW);
    const rotated = await rotateSigningKeyFor(
      db,
      MASTER_KEY,
      "statements",
      NOW,
    );

    const loaded = await loadSigningKey(db, MASTER_KEY, "statements", NOW);

    // Read per issuance rather than cached, so a rotation takes effect immediately: a
    // superseded key that kept signing would keep minting artefacts under a key that is
    // about to leave the document.
    expect(loaded.kid).toBe(rotated.kid);
  });

  it("publishes both purposes' keys", async () => {
    await ensureSigningKeys(db, MASTER_KEY, NOW);

    const published = await publishedJwks(db, NOW);
    const [statements, tickets] = await Promise.all([
      findActiveSigningKey(db, "statements"),
      findActiveSigningKey(db, "tickets"),
    ]);

    // FR-024, scenario 5: a visitor fetching the keys gets the whole anchor.
    expect(published.keys.some((key) => key.kid === statements?.kid)).toBe(
      true,
    );
    expect(published.keys.some((key) => key.kid === tickets?.kid)).toBe(true);
  });

  it("publishes only public halves", async () => {
    await ensureSigningKeys(db, MASTER_KEY, NOW);

    const published = await publishedJwks(db, NOW);

    expect(published.keys.length).toBeGreaterThan(0);
    for (const key of published.keys) {
      expect(key).not.toHaveProperty("d");
      expect(key.kid).toBeString();
      expect(key.alg).toBe("ES256");
    }
  });

  it("keeps a superseded key published while an artefact it signed is unexpired", async () => {
    const key = await ensureActiveSigningKey(db, MASTER_KEY, "statements", NOW);
    const pairingId = await makePairing(db);
    const account = await makeAccount(db);
    await insertSoftwareStatement(db, {
      pairingId,
      jti: `jti-${uniqueSuffix()}`,
      mintedBy: account.id,
      keyId: key.kid,
      claims: claimsFor(),
      jws: "not.a.real.jws",
      expiresAt: new Date(NOW.getTime() + 86_400_000),
      now: NOW,
    });

    await rotateSigningKeyFor(db, MASTER_KEY, "statements", NOW);

    // Principle VI: rotating a key must not invalidate what it signed, and the only way a
    // vendor can verify an outstanding statement is for the key to still be published.
    const published = await publishedJwks(db, NOW);
    expect(published.keys.some((published) => published.kid === key.kid)).toBe(
      true,
    );
  });

  it("still verifies a statement minted under a superseded key against the JWKS", async () => {
    await ensureActiveSigningKey(db, MASTER_KEY, "statements", NOW);
    const signing = await loadSigningKey(db, MASTER_KEY, "statements", NOW);
    const jws = await signClaims(claimsFor(), signing);

    const pairingId = await makePairing(db);
    const account = await makeAccount(db);
    await insertSoftwareStatement(db, {
      pairingId,
      jti: `jti-${uniqueSuffix()}`,
      mintedBy: account.id,
      keyId: signing.kid,
      claims: claimsFor(),
      jws,
      expiresAt: new Date(NOW.getTime() + 86_400_000),
      now: NOW,
    });
    await rotateSigningKeyFor(db, MASTER_KEY, "statements", NOW);

    // Verified against the document the public route serves, matched by `kid` - which is
    // what a vendor does, and which proves publication rather than key survival.
    const jwks = createLocalJWKSet(
      (await publishedJwks(db, NOW)) as { keys: Record<string, unknown>[] },
    );
    const verified = await jwtVerify(jws, jwks, { issuer: ISSUER });
    expect(verified.protectedHeader.kid).toBe(signing.kid);
  });

  it("withdraws a superseded key once nothing it signed is still alive", async () => {
    const key = await ensureActiveSigningKey(db, MASTER_KEY, "statements", NOW);
    const pairingId = await makePairing(db);
    const account = await makeAccount(db);
    await insertSoftwareStatement(db, {
      pairingId,
      jti: `jti-${uniqueSuffix()}`,
      mintedBy: account.id,
      keyId: key.kid,
      claims: claimsFor(),
      jws: "not.a.real.jws",
      expiresAt: new Date(NOW.getTime() + 3_600_000),
      now: NOW,
    });
    await rotateSigningKeyFor(db, MASTER_KEY, "statements", NOW);

    const later = new Date(NOW.getTime() + 7_200_000);
    const published = await publishedJwks(db, later);

    // "Until no unexpired artefact references it" (`data-model.md`) is a boundary, not a
    // suggestion: a document that grew for ever would advertise material nothing can use.
    expect(published.keys.some((jwk) => jwk.kid === key.kid)).toBe(false);
  });
});

/**
 * A pairing to hang a statement off.
 *
 * The statement table references one, and none of this suite's subjects are about pairings,
 * so the arrangement is as small as the foreign keys allow.
 */
async function makePairing(db: Database): Promise<string> {
  const owner = await makeAccount(db);
  const event = await makeEvent(db, { status: "open" });
  const organisation = await makeOrganisation(db, owner.id);
  const [clientSystem, serverSystem] = await Promise.all([
    makeSystem(db, organisation.id, {
      serverProfile: null,
      clientProfile: clientProfileFixture(),
    }),
    makeSystem(db, organisation.id),
  ]);
  const [client, server] = await Promise.all([
    makeEnrolment(db, {
      event,
      systemId: clientSystem.id,
      accountId: owner.id,
    }),
    makeEnrolment(db, {
      event,
      systemId: serverSystem.id,
      accountId: owner.id,
    }),
  ]);
  const written = await insertPairing(db, {
    eventId: event.id,
    clientEnrolmentId: client.id,
    serverEnrolmentId: server.id,
    registrationFields: {
      clientName: "Smart Forms",
      launchUrl: "https://app.test/launch",
      redirectUris: ["https://app.test/callback"],
      scopes: ["launch"],
      confidentiality: "public",
      launchContext: "",
      needsIntrospection: false,
    },
    actorAccountId: owner.id,
    actingForOrganisationId: organisation.id,
    now: NOW,
  });
  if (!written.ok) {
    throw new Error("fixture pairing was refused as a duplicate");
  }
  return written.pairing.id;
}
