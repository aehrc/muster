/*
 * Copyright © 2026 Commonwealth Scientific and Industrial Research Organisation
 * (CSIRO) ABN 41 687 119 230. Licensed under the Apache License, Version 2.0.
 */

import {
  ciphertextVersion,
  currentCiphertextVersion,
  decryptUnderMasterKey,
  encryptUnderMasterKey,
  findActiveSigningKey,
  findSigningKeyByKid,
  insertAccount,
  insertEnrolment,
  insertEvent,
  insertOrganisation,
  insertPairing,
  insertSigningKey,
  insertSoftwareStatement,
  insertSystem,
  isUniqueViolation,
} from "@muster/db";
import {
  createMigratedSchema,
  describeDatabase,
} from "@muster/db/test/harness";
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { importJWK, jwtVerify } from "jose";

import {
  activeSigningKey,
  ensureActiveSigningKey,
  generateSigningKey,
  publishedJwks,
  rotateSigningKey,
  signingKeyByKid,
  signJws,
} from "./keys.ts";

import type { MigratedSchema } from "@muster/db/test/harness";

/**
 * Signing key management: generation, encryption at rest, rotation, and what
 * stays published.
 *
 * Four properties are load-bearing here, and each has its own reason to be a
 * test rather than a code comment. The keys are ES256 with a key identifier,
 * because that is what the registration profile tells a vendor to expect. A
 * private key is only ever at rest as ciphertext under `MUSTER_MASTER_KEY`, with
 * a version tag on the ciphertext, so a key encrypted under this scheme can be
 * recognised - and re-encrypted - when the scheme changes. Exactly one key per
 * purpose is active, enforced by the database rather than by whoever is calling.
 * And a superseded key stays in the JWKS until every artefact signed with it has
 * expired (FR-024), which is the whole of what makes rotation safe mid-event.
 */

describeDatabase("signing key management", () => {
  let database: MigratedSchema;
  let pairingId: string;
  let accountId: string;

  /** The key the suite encrypts private keys under. */
  const masterKey = "0123456789abcdef0123456789abcdef";

  beforeAll(async () => {
    database = await createMigratedSchema("keys");
    const sql = database.sql;

    // A pairing is the minimum a software statement can hang off, and statements
    // are what decide whether a superseded key stays published.
    const account = await insertAccount(sql, {
      email: "owner@example.org",
      displayName: "An Owner",
      passwordHash: "not-a-real-hash",
    });
    accountId = account.id;
    const organisation = await insertOrganisation(sql, { name: "CSIRO" });
    const client = await insertSystem(sql, {
      organisationId: organisation.id,
      name: "Smart Forms",
      description: "",
      serverProfile: null,
      clientProfile: {
        launchUrl: "https://smartforms.example.org/launch",
        redirectUris: ["https://smartforms.example.org/callback"],
        scopes: ["openid"],
        confidentiality: "public",
        launchContext: "patient",
        needsIntrospection: false,
      },
    });
    const server = await insertSystem(sql, {
      organisationId: organisation.id,
      name: "Stub Auth",
      description: "",
      serverProfile: {
        fhirBaseUrl: "https://stub.example.org/fhir",
        authorizationMode: "smart",
        registrationMode: "trustedDcr",
        registrationEndpoint: "https://stub.example.org/register",
        notes: "",
      },
      clientProfile: null,
    });
    const event = await insertEvent(sql, {
      slug: "keys-event",
      name: "Sparked connectathon",
      startsOn: "2026-09-01",
      endsOn: "2026-09-03",
      status: "open",
    });
    const clientEnrolment = await insertEnrolment(sql, {
      eventId: event.id,
      systemId: client.id,
      tags: [],
      confirmedBy: account.id,
    });
    const serverEnrolment = await insertEnrolment(sql, {
      eventId: event.id,
      systemId: server.id,
      tags: [],
      confirmedBy: account.id,
    });
    const pairing = await insertPairing(sql, {
      eventId: event.id,
      clientEnrolmentId: clientEnrolment.id,
      serverEnrolmentId: serverEnrolment.id,
      registrationFields: {},
    });
    pairingId = pairing.id;
  });

  // Every test starts with no keys and no statements, so no test depends on what
  // another left behind.
  beforeEach(async () => {
    await database.sql`delete from software_statement`;
    await database.sql`delete from signing_key`;
  });

  afterAll(async () => {
    await database.close();
  });

  // Records a minted statement against a key, so retention has something to see.
  const arrangeStatement = async (
    keyId: string,
    expiresAt: Date,
  ): Promise<void> => {
    await insertSoftwareStatement(database.sql, {
      pairingId,
      jti: crypto.randomUUID(),
      mintedBy: accountId,
      keyId,
      claims: { jti: "recorded" },
      jws: "header.payload.signature",
      expiresAt,
    });
  };

  /** The moment the retention tests reckon from. */
  const now = new Date("2026-09-02T00:00:00Z");

  // Generation --------------------------------------------------------------

  // The profile tells a vendor to expect ES256 with a `kid` in the protected
  // header, so that is what generation produces.
  test("generates an ES256 key pair with a key identifier", async () => {
    const generated = await generateSigningKey({
      purpose: "statements",
      masterKey,
    });

    expect(generated.purpose).toBe("statements");
    expect(generated.kid.length).toBeGreaterThan(0);
    expect(generated.publicJwk).toMatchObject({
      kty: "EC",
      crv: "P-256",
      alg: "ES256",
      use: "sig",
      kid: generated.kid,
    });
    // The public half is public: it carries no private scalar.
    expect(generated.publicJwk).not.toHaveProperty("d");
  });

  // Two keys are two keys: a repeated identifier would make the JWKS ambiguous
  // and rotation meaningless.
  test("gives each generated key its own identifier", async () => {
    const first = await generateSigningKey({
      purpose: "statements",
      masterKey,
    });
    const second = await generateSigningKey({
      purpose: "statements",
      masterKey,
    });

    expect(second.kid).not.toBe(first.kid);
  });

  // Encryption at rest ------------------------------------------------------

  // The constitution: a private key is stored encrypted under the master key,
  // with a version tag on the ciphertext.
  test("encrypts and decrypts under the master key, round trip", () => {
    const plaintext = '{"kty":"EC","d":"the-private-scalar"}';

    const ciphertext = encryptUnderMasterKey(masterKey, plaintext);

    expect(ciphertext).not.toContain("the-private-scalar");
    expect(decryptUnderMasterKey(masterKey, ciphertext)).toBe(plaintext);
  });

  test("tags the ciphertext with the scheme version", () => {
    const ciphertext = encryptUnderMasterKey(masterKey, "anything");

    expect(ciphertext.startsWith(`${currentCiphertextVersion}.`)).toBe(true);
    expect(ciphertextVersion(ciphertext)).toBe(currentCiphertextVersion);
  });

  // Two encryptions of one plaintext differ, because each carries its own nonce.
  test("uses a fresh nonce for every encryption", () => {
    const first = encryptUnderMasterKey(masterKey, "anything");
    const second = encryptUnderMasterKey(masterKey, "anything");

    expect(second).not.toBe(first);
    expect(decryptUnderMasterKey(masterKey, second)).toBe("anything");
  });

  // A different master key cannot read it, and neither can a tampered
  // ciphertext: the authentication tag is checked, so a modified ciphertext
  // fails rather than decrypting to something else.
  test("refuses the wrong master key", () => {
    const ciphertext = encryptUnderMasterKey(masterKey, "anything");

    expect(() =>
      decryptUnderMasterKey("fedcba9876543210fedcba9876543210", ciphertext),
    ).toThrow();
  });

  test("refuses a tampered ciphertext", () => {
    const ciphertext = encryptUnderMasterKey(masterKey, "anything");
    const tampered = `${ciphertext.slice(0, -2)}${ciphertext.endsWith("a") ? "b" : "a"}`;

    expect(() => decryptUnderMasterKey(masterKey, tampered)).toThrow();
  });

  // Deny by default: an unrecognised version tag is refused rather than guessed
  // at, because guessing at a key's encoding is how a key gets corrupted.
  test("refuses a ciphertext whose version it does not know", () => {
    const ciphertext = encryptUnderMasterKey(masterKey, "anything");
    const relabelled = `v99.${ciphertext.split(".").slice(1).join(".")}`;

    expect(() => decryptUnderMasterKey(masterKey, relabelled)).toThrow(/v99/);
  });

  // The private key is only ever at rest as ciphertext.
  test("stores the private key as ciphertext with its version tag", async () => {
    const key = await ensureActiveSigningKey(database.sql, {
      purpose: "statements",
      masterKey,
    });

    const stored = await findSigningKeyByKid(database.sql, key.kid);
    expect(stored?.privateJwk.startsWith(`${currentCiphertextVersion}.`)).toBe(
      true,
    );
    expect(stored?.privateJwk).not.toContain('"d"');

    // And it is the key it says it is: decrypting yields the private half of the
    // published public half.
    const privateJwk: unknown = JSON.parse(
      decryptUnderMasterKey(masterKey, stored?.privateJwk ?? ""),
    );
    expect(privateJwk).toHaveProperty("d");
  });

  // One active key per purpose ----------------------------------------------

  // Asking twice does not mint twice: the second call finds the key the first
  // one made.
  test("keeps one active key per purpose", async () => {
    const first = await ensureActiveSigningKey(database.sql, {
      purpose: "statements",
      masterKey,
    });
    const second = await ensureActiveSigningKey(database.sql, {
      purpose: "statements",
      masterKey,
    });

    expect(second.kid).toBe(first.kid);
    expect(second.status).toBe("active");
  });

  // Statements and tickets are signed with separate keys, so compromising one
  // does not implicate the other.
  test("keeps a separate active key for each purpose", async () => {
    const statements = await ensureActiveSigningKey(database.sql, {
      purpose: "statements",
      masterKey,
    });
    const tickets = await ensureActiveSigningKey(database.sql, {
      purpose: "tickets",
      masterKey,
    });

    expect(tickets.kid).not.toBe(statements.kid);
    expect(tickets.purpose).toBe("tickets");
  });

  // The rule is the database's, not the caller's: a second active key for one
  // purpose is refused by a constraint, however it is attempted.
  test("refuses a second active key for one purpose", async () => {
    await ensureActiveSigningKey(database.sql, {
      purpose: "statements",
      masterKey,
    });
    const another = await generateSigningKey({
      purpose: "statements",
      masterKey,
    });

    let cause: unknown;
    try {
      await insertSigningKey(database.sql, another);
    } catch (thrown) {
      cause = thrown;
    }

    expect(isUniqueViolation(cause)).toBe(true);
  });

  // Rotation ----------------------------------------------------------------

  // Rotation supersedes the old key and activates a new one, in that order, so
  // there is never a moment with two active keys or none.
  test("rotates by superseding the old key and activating a new one", async () => {
    const before = await ensureActiveSigningKey(database.sql, {
      purpose: "statements",
      masterKey,
    });

    const after = await rotateSigningKey(database.sql, {
      purpose: "statements",
      masterKey,
    });

    expect(after.kid).not.toBe(before.kid);
    expect(after.status).toBe("active");
    expect((await findSigningKeyByKid(database.sql, before.kid))?.status).toBe(
      "superseded",
    );
    expect((await findActiveSigningKey(database.sql, "statements"))?.kid).toBe(
      after.kid,
    );
  });

  // What stays published ----------------------------------------------------

  // The active key is always published, for both purposes, because that is what
  // a server verifying a fresh statement fetches.
  test("publishes the active key of every purpose", async () => {
    const statements = await ensureActiveSigningKey(database.sql, {
      purpose: "statements",
      masterKey,
    });
    const tickets = await ensureActiveSigningKey(database.sql, {
      purpose: "tickets",
      masterKey,
    });

    const jwks = await publishedJwks(database.sql, now);

    expect(jwks.keys.map((key) => key.kid).sort()).toEqual(
      [statements.kid, tickets.kid].sort(),
    );
  });

  // FR-024 and the specification's edge case: a key rotated mid-event stays
  // published while a statement signed with it is still valid.
  test("keeps a superseded key published while an artefact signed with it lives", async () => {
    const superseded = await ensureActiveSigningKey(database.sql, {
      purpose: "statements",
      masterKey,
    });
    await arrangeStatement(superseded.kid, new Date("2026-09-11T00:00:00Z"));
    const active = await rotateSigningKey(database.sql, {
      purpose: "statements",
      masterKey,
    });

    const jwks = await publishedJwks(database.sql, now);

    expect(jwks.keys.map((key) => key.kid).sort()).toEqual(
      [superseded.kid, active.kid].sort(),
    );
  });

  // Once the last artefact has expired the key is withdrawn, which is what the
  // profile's validation rule 1 depends on: a withdrawn key must stop verifying.
  test("withdraws a superseded key once its artefacts have expired", async () => {
    const superseded = await ensureActiveSigningKey(database.sql, {
      purpose: "statements",
      masterKey,
    });
    await arrangeStatement(superseded.kid, new Date("2026-09-01T00:00:00Z"));
    const active = await rotateSigningKey(database.sql, {
      purpose: "statements",
      masterKey,
    });

    const jwks = await publishedJwks(database.sql, now);

    expect(jwks.keys.map((key) => key.kid)).toEqual([active.kid]);
  });

  // A superseded key with nothing signed under it is withdrawn immediately:
  // there is nothing left to verify.
  test("withdraws a superseded key that signed nothing", async () => {
    const superseded = await ensureActiveSigningKey(database.sql, {
      purpose: "statements",
      masterKey,
    });
    const active = await rotateSigningKey(database.sql, {
      purpose: "statements",
      masterKey,
    });

    const jwks = await publishedJwks(database.sql, now);

    expect(jwks.keys.map((key) => key.kid)).toEqual([active.kid]);
    expect(superseded.kid).not.toBe(active.kid);
  });

  // Signing -----------------------------------------------------------------

  // The end-to-end property the profile rests on: what Muster signs verifies
  // against what Muster publishes, matched by `kid`.
  test("signs with the active key and verifies against the published JWKS", async () => {
    await ensureActiveSigningKey(database.sql, {
      purpose: "statements",
      masterKey,
    });
    const key = await activeSigningKey(database.sql, {
      purpose: "statements",
      masterKey,
    });

    const jws = await signJws(key, { iss: "https://muster.example.org" });

    const jwks = await publishedJwks(database.sql, now);
    const published = jwks.keys.find((candidate) => candidate.kid === key.kid);
    const verified = await jwtVerify(
      jws,
      await importJWK({ ...published }, "ES256"),
    );
    expect(verified.payload.iss).toBe("https://muster.example.org");
    expect(verified.protectedHeader).toMatchObject({
      alg: "ES256",
      kid: key.kid,
      typ: "JWT",
    });
  });

  // A caller can reach a key by identifier rather than by purpose, which is what
  // the conformance harness needs: a statement signed with a key the target server
  // cannot know about is one of the checks it runs.
  test("reads a key by its identifier, including a superseded one", async () => {
    const superseded = await ensureActiveSigningKey(database.sql, {
      purpose: "statements",
      masterKey,
    });
    await rotateSigningKey(database.sql, { purpose: "statements", masterKey });

    const found = await signingKeyByKid(
      database.sql,
      superseded.kid,
      masterKey,
    );

    expect(found?.kid).toBe(superseded.kid);
    expect(found?.purpose).toBe("statements");
    // Deny by default: an identifier nothing was signed with answers nothing.
    expect(
      await signingKeyByKid(database.sql, "no-such-kid", masterKey),
    ).toBeUndefined();
  });

  // The key the signer holds is the key the JWKS publishes, so an implementer
  // reading the JWKS is reading the right half of the right pair.
  test("publishes the public half of the key it signs with", async () => {
    await ensureActiveSigningKey(database.sql, {
      purpose: "statements",
      masterKey,
    });
    const key = await activeSigningKey(database.sql, {
      purpose: "statements",
      masterKey,
    });

    const stored = await findSigningKeyByKid(database.sql, key.kid);
    const privateJwk = JSON.parse(
      decryptUnderMasterKey(masterKey, stored?.privateJwk ?? ""),
    ) as { x: string; y: string };
    const jwks = await publishedJwks(database.sql, now);
    const published = jwks.keys.find((candidate) => candidate.kid === key.kid);

    expect(published?.x).toBe(privateJwk.x);
    expect(published?.y).toBe(privateJwk.y);
  });
});
