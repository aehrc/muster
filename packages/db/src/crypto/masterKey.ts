/**
 * Encrypting the one kind of secret Muster has to be able to read back.
 *
 * Almost every credential in this system is only ever compared, never recovered: a
 * password is an argon2id hash, a session token and a verification token are SHA-256
 * digests, and a client secret is not stored at all (constitution principle IV). Signing
 * private keys are the exception. Muster has to sign a software statement with the same
 * key it signed yesterday's with, or every artefact it has vouched for stops verifying -
 * so the private half has to survive a restart, which means it has to be stored in a form
 * something can decrypt.
 *
 * That form is an envelope under `MUSTER_MASTER_KEY`. The scheme is deliberately the same
 * one Signet uses in `packages/db/src/crypto/envelope.ts`, because the two codebases are
 * maintained together and a second scheme would be a second thing to get subtly wrong.
 *
 * **AES-256-GCM through Web Crypto.** No dependency: the server bundles to a single file
 * with no native addons, so the only cryptography available is what the runtime ships.
 * GCM is authenticated, which is what makes a tampered ciphertext a refusal rather than a
 * key that signs garbage.
 *
 * **HKDF-SHA256 from the variable's raw bytes.** The variable is a passphrase rather than
 * an encoded key, so it is stretched rather than parsed - an operator who sets 32
 * characters of English gets a uniformly distributed key, and one who sets 64 hex
 * characters gets one too, without either having to know which was expected. The `info`
 * string is Muster's own, which is what stops a ciphertext from one system being readable
 * by the other under a shared master key.
 *
 * **`v1.<iv>.<ciphertext+tag>`, and the version is authenticated.** `data-model.md`
 * requires the version tag, and the reason it is passed to GCM as additional data rather
 * than merely prefixed is that a stored value whose version somebody edited must fail
 * authentication rather than be decrypted under different rules.
 *
 * **The key is derived per call, never cached.** A cache would be a lookup table from the
 * master key to live key material, held for the process's lifetime, for the sake of
 * microseconds on an operation that happens a handful of times per statement.
 *
 * **Failure throws.** Everything else in this layer reports a domain refusal as a value,
 * and this is the exception: there is no safe fallback for "the master key does not open
 * the signing key". A route that treated it as an ordinary outcome would carry on and
 * mint something.
 *
 * Author: John Grimes
 */

/** Why an envelope operation failed. */
export type EnvelopeErrorReason =
  /** The master key is too short to be one. */
  | "invalid-master-key"
  /** The stored value is not an envelope at all. */
  | "malformed"
  /** The envelope names a version this build does not implement. */
  | "unsupported-version"
  /** The wrong master key, or a ciphertext somebody edited. */
  | "authentication-failed";

/** Thrown when a secret cannot be sealed or opened. */
export class EnvelopeError extends Error {
  /** Which failure it was, for a caller that logs the class rather than the message. */
  public readonly reason: EnvelopeErrorReason;

  /**
   * @param reason - The classification.
   * @param message - What went wrong. Never contains the plaintext or the master key.
   */
  public constructor(reason: EnvelopeErrorReason, message: string) {
    super(message);
    this.name = "EnvelopeError";
    this.reason = reason;
  }
}

/** The envelope format this build writes. */
export const ENVELOPE_VERSION = "v1";

/** Domain separation for the derivation. Muster's own, deliberately not Signet's. */
const HKDF_INFO = "muster/envelope/v1/aes-256-gcm";

/** The shortest master key accepted, matching `config.ts`. */
const MASTER_KEY_MIN_LENGTH = 32;

/** AES-GCM's nominal nonce length. */
const IV_BYTES = 12;

/** The authentication tag length, in bits. */
const TAG_BITS = 128;

const utf8 = new TextEncoder();
const utf8Decoder = new TextDecoder();

/** Unpadded base64url, as JOSE spells binary. */
function encodeBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/**
 * Decodes unpadded base64url, refusing anything that is not canonical.
 *
 * Round-tripped through the encoder rather than trusted, because `Buffer.from` is
 * forgiving: it accepts padding, whitespace and stray characters, and a stored value that
 * decoded two different ways would be a stored value with two meanings.
 */
function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> | undefined {
  const decoded = Buffer.from(value, "base64url");
  // Copied into a fresh buffer rather than viewed: `Buffer.from` may return a view over a
  // pooled - and typed as possibly shared - allocation, which Web Crypto will not accept.
  const bytes = new Uint8Array(new ArrayBuffer(decoded.length));
  bytes.set(decoded);
  return encodeBase64Url(bytes) === value ? bytes : undefined;
}

/**
 * Stretches the master key into an AES-256 key.
 *
 * @throws {EnvelopeError} With `invalid-master-key` when the variable is too short.
 */
async function deriveKey(masterKey: string): Promise<CryptoKey> {
  if (masterKey.length < MASTER_KEY_MIN_LENGTH) {
    throw new EnvelopeError(
      "invalid-master-key",
      `MUSTER_MASTER_KEY must be at least ${String(MASTER_KEY_MIN_LENGTH)} characters`,
    );
  }

  const material = await crypto.subtle.importKey(
    "raw",
    utf8.encode(masterKey),
    "HKDF",
    false,
    ["deriveKey"],
  );

  return await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      // Empty, which RFC 5869 §3.1 permits: the master key is already a secret of at
      // least 256 bits of intent, and a salt would have to be stored beside every
      // ciphertext to buy anything.
      salt: new Uint8Array(0),
      info: utf8.encode(HKDF_INFO),
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * Seals a secret under the master key.
 *
 * @param plaintext - What to protect. A private JWK, in this codebase.
 * @param masterKey - `MUSTER_MASTER_KEY`.
 * @returns The envelope, as `v1.<iv>.<ciphertext>`; safe to store and to include in a
 *   database dump.
 * @throws {EnvelopeError} When the master key is too short to be one.
 * @example
 * ```ts
 * const stored = await encryptSecret(JSON.stringify(privateJwk), config.masterKey);
 * ```
 */
export async function encryptSecret(
  plaintext: string,
  masterKey: string,
): Promise<string> {
  const key = await deriveKey(masterKey);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));

  const sealed = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      tagLength: TAG_BITS,
      // Authenticated but not encrypted, so that editing the version fails the tag.
      additionalData: utf8.encode(ENVELOPE_VERSION),
    },
    key,
    utf8.encode(plaintext),
  );

  return [
    ENVELOPE_VERSION,
    encodeBase64Url(iv),
    encodeBase64Url(new Uint8Array(sealed)),
  ].join(".");
}

/**
 * Opens a secret sealed by {@link encryptSecret}.
 *
 * @param ciphertext - The stored envelope.
 * @param masterKey - `MUSTER_MASTER_KEY`.
 * @returns The plaintext.
 * @throws {EnvelopeError} When the envelope is malformed, names an unknown version, or
 *   fails authentication - which is the wrong master key or an altered ciphertext, and
 *   which this deliberately does not distinguish.
 * @example
 * ```ts
 * const jwk = JSON.parse(await decryptSecret(row.privateJwkEncrypted, config.masterKey));
 * ```
 */
export async function decryptSecret(
  ciphertext: string,
  masterKey: string,
): Promise<string> {
  const parts = ciphertext.split(".");
  if (parts.length !== 3) {
    throw new EnvelopeError(
      "malformed",
      "An encrypted secret must have the form <version>.<iv>.<ciphertext>",
    );
  }

  const [version, ivPart, sealedPart] = parts as [string, string, string];
  if (version !== ENVELOPE_VERSION) {
    throw new EnvelopeError(
      "unsupported-version",
      `Unsupported encrypted secret version "${version}"`,
    );
  }

  const iv = decodeBase64Url(ivPart);
  const sealed = decodeBase64Url(sealedPart);
  if (iv === undefined || sealed === undefined) {
    throw new EnvelopeError(
      "malformed",
      "An encrypted secret must be canonical base64url",
    );
  }
  if (iv.length !== IV_BYTES) {
    throw new EnvelopeError(
      "malformed",
      `An initialisation vector must be ${String(IV_BYTES)} bytes`,
    );
  }
  if (sealed.length < TAG_BITS / 8) {
    throw new EnvelopeError("malformed", "An encrypted secret is truncated");
  }

  const key = await deriveKey(masterKey);

  let opened: ArrayBuffer;
  try {
    opened = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv,
        tagLength: TAG_BITS,
        additionalData: utf8.encode(version),
      },
      key,
      sealed,
    );
  } catch {
    throw new EnvelopeError(
      "authentication-failed",
      "An encrypted secret failed authentication: wrong master key, or altered ciphertext",
    );
  }

  return utf8Decoder.decode(opened);
}
