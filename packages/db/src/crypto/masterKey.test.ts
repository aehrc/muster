/**
 * That a sealed secret comes back exactly, and that an altered one never does.
 *
 * The outcome helper is the point of this suite's shape. A tamper test written as
 * `expect(decrypt(...)).rejects.toThrow()` says nothing useful when it fails: the
 * interesting failure is a tampered ciphertext that decrypted *successfully* to something,
 * and that has to show up naming what it decrypted to rather than as "expected a throw".
 *
 * Author: John Grimes
 */

import { describe, expect, it } from "bun:test";

import {
  decryptSecret,
  encryptSecret,
  ENVELOPE_VERSION,
  EnvelopeError,
} from "./masterKey.js";

/** Exactly the minimum length, so the length check is exercised by its neighbours. */
const MASTER_KEY = "0123456789abcdef0123456789abcdef";

/** A different key of the same length. */
const OTHER_KEY = "fedcba9876543210fedcba9876543210";

/**
 * What happened, as a string either way.
 *
 * A refusal reports its reason; a success reports what it recovered. So a tamper that was
 * not detected fails the assertion by naming the plaintext it produced.
 */
async function outcomeOf(ciphertext: string, key: string): Promise<string> {
  try {
    return `decrypted to ${JSON.stringify(await decryptSecret(ciphertext, key))}`;
  } catch (error) {
    return error instanceof EnvelopeError ? error.reason : String(error);
  }
}

describe("sealing and opening a secret", () => {
  it.each([
    ["an empty string", ""],
    [
      "a private JWK",
      '{"kty":"EC","crv":"P-256","d":"abc","x":"def","y":"ghi"}',
    ],
    ["non-ASCII text", "clé privée - ключ - 鍵"],
    ["a long value", "x".repeat(10_000)],
  ])("recovers %s exactly", async (_label, plaintext) => {
    const sealed = await encryptSecret(plaintext, MASTER_KEY);

    expect(await decryptSecret(sealed, MASTER_KEY)).toBe(plaintext);
  });

  it("writes the version tag the data model requires", async () => {
    const sealed = await encryptSecret("secret", MASTER_KEY);

    // `data-model.md`: the ciphertext carries a version tag. Asserted on the prefix rather
    // than by decrypting, because the tag is what lets a later build recognise this format.
    expect(sealed.startsWith(`${ENVELOPE_VERSION}.`)).toBe(true);
    expect(sealed.split(".")).toHaveLength(3);
  });

  it("never repeats an initialisation vector", async () => {
    const sealed = await Promise.all(
      Array.from(
        { length: 50 },
        async () => await encryptSecret("the same plaintext", MASTER_KEY),
      ),
    );

    // A repeated nonce under one key is the failure mode that makes GCM catastrophic
    // rather than merely broken.
    expect(new Set(sealed.map((value) => value.split(".", 2)[1])).size).toBe(
      50,
    );
  });

  it("produces a different ciphertext for the same plaintext each time", async () => {
    const first = await encryptSecret("the same plaintext", MASTER_KEY);
    const second = await encryptSecret("the same plaintext", MASTER_KEY);

    expect(first).not.toBe(second);
  });

  it("does not leak the plaintext into the envelope", async () => {
    const sealed = await encryptSecret("P-256-private-scalar", MASTER_KEY);

    expect(sealed).not.toContain("P-256");
  });
});

describe("refusing to open a secret", () => {
  it("refuses the wrong master key", async () => {
    const sealed = await encryptSecret("secret", MASTER_KEY);

    expect(await outcomeOf(sealed, OTHER_KEY)).toBe("authentication-failed");
  });

  it("refuses a master key too short to be one", async () => {
    // The same floor `config.ts` enforces, held here too: a key derived from twelve
    // characters would encrypt perfectly and protect nothing.
    expect(await outcomeOf(await encryptSecret("s", MASTER_KEY), "short")).toBe(
      "invalid-master-key",
    );
    await expect(encryptSecret("s", "short")).rejects.toThrow(EnvelopeError);
  });

  it.each([
    ["a value that is not an envelope", "not-an-envelope"],
    ["too few parts", "v1.abc"],
    ["too many parts", "v1.abc.def.ghi"],
  ])("refuses %s as malformed", async (_label, value) => {
    expect(await outcomeOf(value, MASTER_KEY)).toBe("malformed");
  });

  it("refuses a version this build does not implement", async () => {
    const sealed = await encryptSecret("secret", MASTER_KEY);
    const parts = sealed.split(".");

    expect(
      await outcomeOf(`v2.${parts[1] ?? ""}.${parts[2] ?? ""}`, MASTER_KEY),
    ).toBe("unsupported-version");
  });

  it("refuses non-canonical base64url", async () => {
    const sealed = await encryptSecret("secret", MASTER_KEY);
    const parts = sealed.split(".");

    // Padding is not part of the format. A value that decoded two ways would be a stored
    // value with two meanings.
    expect(
      await outcomeOf(`v1.${parts[1] ?? ""}=.${parts[2] ?? ""}`, MASTER_KEY),
    ).toBe("malformed");
  });

  it("refuses an initialisation vector of the wrong length", async () => {
    const sealed = await encryptSecret("secret", MASTER_KEY);
    const parts = sealed.split(".");

    expect(
      await outcomeOf(
        `v1.${Buffer.alloc(8).toString("base64url")}.${parts[2] ?? ""}`,
        MASTER_KEY,
      ),
    ).toBe("malformed");
  });

  it("refuses a truncated ciphertext", async () => {
    expect(
      await outcomeOf(
        `v1.${Buffer.alloc(12).toString("base64url")}.${Buffer.alloc(4).toString("base64url")}`,
        MASTER_KEY,
      ),
    ).toBe("malformed");
  });

  it("detects a single flipped bit anywhere in the ciphertext", async () => {
    const sealed = await encryptSecret("a private key", MASTER_KEY);
    const [, ivPart = "", sealedPart = ""] = sealed.split(".");
    const bytes = Buffer.from(sealedPart, "base64url");

    const outcomes = new Set<string>();
    for (let index = 0; index < bytes.length; index += 1) {
      const altered = Buffer.from(bytes);
      altered.writeUInt8((bytes.readUInt8(index) ^ 0x01) & 0xff, index);
      outcomes.add(
        await outcomeOf(
          `v1.${ivPart}.${altered.toString("base64url")}`,
          MASTER_KEY,
        ),
      );
    }

    // Every byte, including the authentication tag's own.
    expect([...outcomes]).toEqual(["authentication-failed"]);
  });

  it("detects a single flipped bit anywhere in the initialisation vector", async () => {
    const sealed = await encryptSecret("a private key", MASTER_KEY);
    const [, ivPart = "", sealedPart = ""] = sealed.split(".");
    const bytes = Buffer.from(ivPart, "base64url");

    const outcomes = new Set<string>();
    for (let index = 0; index < bytes.length; index += 1) {
      const altered = Buffer.from(bytes);
      altered.writeUInt8((bytes.readUInt8(index) ^ 0x01) & 0xff, index);
      outcomes.add(
        await outcomeOf(
          `v1.${altered.toString("base64url")}.${sealedPart}`,
          MASTER_KEY,
        ),
      );
    }

    expect([...outcomes]).toEqual(["authentication-failed"]);
  });
});
