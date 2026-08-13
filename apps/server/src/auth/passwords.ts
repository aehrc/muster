/**
 * Hashing and checking a password.
 *
 * argon2id, per the constitution: a password is stored as an argon2id hash and as
 * nothing else. The implementation is Bun's, which is why the runtime image runs this
 * bundle under Bun rather than Node - it is the only argon2id available without a native
 * addon, and the single-file bundle forbids one (see the Dockerfile and
 * `scripts/checkBundle.mjs`). Two alternatives were considered and rejected: a WASM
 * hashing dependency, which is one more thing to bundle and audit, and `scrypt` from
 * `node:crypto`, which is not what the constitution names.
 *
 * Bun's API is reached through the narrow shape used rather than through its global
 * types, for the same reason `../mail/transport.ts` declares its own SMTP factory type: a
 * test substitutes a recorder without pulling a runtime's whole type surface into the
 * server's program.
 *
 * The absence of that API is treated as a startup failure rather than as a fallback. A
 * deployment that silently hashed with something weaker would look exactly like one that
 * did not, which is the worst available outcome for a credential store.
 *
 * Author: John Grimes
 */

/** The two calls this module makes into an argon2id implementation. */
export interface PasswordHasher {
  readonly hash: (
    password: string,
    options: { readonly algorithm: "argon2id" },
  ) => Promise<string>;
  readonly verify: (password: string, hash: string) => Promise<boolean>;
}

/**
 * The runtime's argon2id implementation.
 *
 * Read off the global rather than imported, because the server's TypeScript program is
 * typed against Node - see `tsconfig.json` - and this is the one place that knows the
 * process is Bun.
 */
function runtimeHasher(): PasswordHasher {
  const runtime = globalThis as {
    readonly Bun?: { readonly password?: PasswordHasher };
  };
  const hasher = runtime.Bun?.password;
  if (hasher === undefined) {
    throw new Error(
      "No argon2id implementation is available. Muster's server bundle must be run by Bun (`bun dist/index.js`), which is what the runtime image does.",
    );
  }
  return hasher;
}

/**
 * A hash that no password matches.
 *
 * Presented to {@link verifyPassword} when the address named in a sign-in has no account,
 * so that every refusal costs one argon2id verification. Without it, "no such account"
 * returns in microseconds and "wrong password" in tens of milliseconds, which is an
 * account-enumeration oracle that no amount of identical response bodies can close.
 *
 * A syntactically valid argon2id encoding whose salt and hash are constant. Nothing is
 * ever hashed to this value.
 */
export const UNMATCHABLE_PASSWORD_HASH =
  "$argon2id$v=19$m=65536,t=2,p=1$bXVzdGVyLW5vLXN1Y2gtYWNjb3VudA$Y2Fubm90IG1hdGNoIGFueSBwYXNzd29yZCBldmVy";

/**
 * Hashes a password for storage.
 *
 * @param password - The password as the holder typed it.
 * @param hasher - The implementation. Defaults to the runtime's.
 * @returns The argon2id encoding, including its parameters and salt.
 * @throws {Error} When the runtime provides no argon2id implementation.
 * @example
 * ```ts
 * const passwordHash = await hashPassword(body.password);
 * ```
 */
export async function hashPassword(
  password: string,
  hasher: PasswordHasher = runtimeHasher(),
): Promise<string> {
  return await hasher.hash(password, { algorithm: "argon2id" });
}

/**
 * Checks a password against a stored hash.
 *
 * Never throws for a malformed hash. A stored value this implementation cannot parse must
 * refuse the sign-in rather than fail the request: the alternative turns a bad row into a
 * 500 that tells its holder their account is special.
 *
 * @param password - The password as the holder typed it.
 * @param hash - The stored argon2id encoding, or {@link UNMATCHABLE_PASSWORD_HASH}.
 * @param hasher - The implementation. Defaults to the runtime's.
 * @returns Whether they match.
 * @example
 * ```ts
 * const matches = await verifyPassword(
 *   body.password,
 *   found?.passwordHash ?? UNMATCHABLE_PASSWORD_HASH,
 * );
 * ```
 */
export async function verifyPassword(
  password: string,
  hash: string,
  hasher: PasswordHasher = runtimeHasher(),
): Promise<boolean> {
  try {
    return await hasher.verify(password, hash);
  } catch {
    return false;
  }
}
