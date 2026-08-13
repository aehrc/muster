/**
 * Reading, installing and rotating the signing keys.
 *
 * The same rules as the rest of this layer hold - the executor comes first, the time is
 * passed in, a domain refusal is a value - and three things are specific to keys.
 *
 * **Nothing here handles key material.** The rows carry a public JWK and an envelope over
 * the private one; generating a pair and opening an envelope are `apps/server`'s, because
 * the master key belongs to the process's configuration and not to the data layer.
 *
 * **Installing an active key is attempted, not checked first.** Two processes starting at
 * once - or a startup racing the first mint - would both find no active key and both
 * insert; the partial unique index is what decides between them, so the loser is told and
 * handed the winner's key rather than failing. Reading and then inserting would leave a
 * window in which both succeed, and then half an afternoon's statements carry a `kid` that
 * is about to be superseded by the other.
 *
 * **What the JWKS publishes is a question about artefacts, not about keys.** Principle VI:
 * a superseded key stays published until nothing it signed is still unexpired. So
 * {@link listPublishedSigningKeys} joins to the artefact tables rather than reading a
 * third status, which is what makes "until every statement or ticket signed with them has
 * expired" (FR-024) exactly true rather than approximately.
 *
 * Author: John Grimes
 */

import { and, asc, eq, exists, gt, or, sql } from "drizzle-orm";

import { isUniqueViolation } from "./errors.js";
import { firstRow, requireRow } from "./rows.js";
import { signingKey } from "../schema/keys.js";
import { softwareStatement } from "../schema/statements.js";
import { ticket } from "../schema/tickets.js";

import type { Executor } from "../executor.js";
import type { SigningKeyRow } from "../schema/keys.js";
import type { SigningKeyPurpose } from "@muster/core";

/** A key pair to record. The material is generated in `apps/server`, which owns crypto. */
export interface NewSigningKey {
  readonly kid: string;
  readonly purpose: SigningKeyPurpose;
  /** Served verbatim from the JWKS. */
  readonly publicJwk: Record<string, unknown>;
  /** A `masterKey.ts` envelope over the private JWK. */
  readonly privateJwkEncrypted: string;
  readonly now: Date;
}

/** The outcome of trying to install a first active key. */
export type SigningKeyInstall =
  | { readonly ok: true; readonly key: SigningKeyRow }
  /** Something installed one first. Its key is returned, so the caller can use it. */
  | {
      readonly ok: false;
      readonly reason: "already-active";
      readonly key: SigningKeyRow;
    };

/**
 * Whether any unexpired artefact still names a key.
 *
 * One `exists` per artefact table, disjoined rather than unioned because the question is
 * "anything at all?" - which short-circuits, and which stayed readable when the second table
 * arrived. Both artefacts count: FR-024 says a rotated key stays published until every
 * statement *or ticket* signed with it has expired, and a predicate that named only one of
 * them would withdraw a key while outstanding tickets still pointed at it.
 */
function hasLiveArtefact(now: Date) {
  return or(
    exists(
      sql`(select 1 from ${softwareStatement} where ${and(
        eq(softwareStatement.keyId, signingKey.kid),
        gt(softwareStatement.expiresAt, now),
      )})`,
    ),
    exists(
      sql`(select 1 from ${ticket} where ${and(
        eq(ticket.keyId, signingKey.kid),
        gt(ticket.expiresAt, now),
      )})`,
    ),
  );
}

/**
 * The columns an installed key is written with.
 *
 * Written once because the two writers - a first install and a rotation - insert the same row
 * and differ only in what they do to the key that came before it.
 */
function activeKeyValues(input: NewSigningKey) {
  return {
    kid: input.kid,
    purpose: input.purpose,
    status: "active" as const,
    publicJwk: input.publicJwk,
    privateJwkEncrypted: input.privateJwkEncrypted,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

/**
 * Installs the first active key of a purpose.
 *
 * @param db - The executor.
 * @param input - The generated pair and the time.
 * @returns The installed key, or the one that was already active.
 * @throws {Error} When a key was refused for any reason but a purpose already having one -
 *   and when the existing key cannot then be found, which would mean a key was deleted,
 *   and keys are never deleted.
 * @example
 * ```ts
 * const installed = await installActiveSigningKey(db, { ...generated, purpose, now });
 * const key = installed.key;
 * ```
 */
export async function installActiveSigningKey(
  db: Executor,
  input: NewSigningKey,
): Promise<SigningKeyInstall> {
  try {
    return {
      ok: true,
      key: requireRow(
        await db.insert(signingKey).values(activeKeyValues(input)).returning(),
        "insert into signing_key",
      ),
    };
  } catch (error) {
    if (!isUniqueViolation(error, "signing_key_one_active_per_purpose")) {
      throw error;
    }
    const existing = await findActiveSigningKey(db, input.purpose);
    if (existing === undefined) {
      throw new Error(
        "a signing key collided with an active key that cannot be found; keys are never deleted",
      );
    }
    return { ok: false, reason: "already-active", key: existing };
  }
}

/**
 * The key of this purpose that signs now.
 *
 * @param db - The executor.
 * @param purpose - Statements or tickets.
 * @returns The active key, or `undefined` when none has been installed.
 */
export async function findActiveSigningKey(
  db: Executor,
  purpose: SigningKeyPurpose,
): Promise<SigningKeyRow | undefined> {
  return firstRow(
    await db
      .select()
      .from(signingKey)
      .where(
        and(eq(signingKey.purpose, purpose), eq(signingKey.status, "active")),
      )
      .limit(1),
  );
}

/**
 * One key by its identifier, whatever its status.
 *
 * @param db - The executor.
 * @param kid - The key identifier an artefact names.
 * @returns The key, or `undefined`.
 */
export async function findSigningKeyByKid(
  db: Executor,
  kid: string,
): Promise<SigningKeyRow | undefined> {
  return firstRow(
    await db.select().from(signingKey).where(eq(signingKey.kid, kid)).limit(1),
  );
}

/**
 * Every key the JWKS should publish (FR-024, principle VI).
 *
 * The active key of each purpose, plus every superseded key that still has an unexpired
 * artefact naming it. Ordered so the document is stable between requests: a JWKS whose
 * member order moved would make a vendor's cache comparison useless.
 *
 * @param db - The executor.
 * @param now - The current time, which decides what counts as unexpired.
 * @returns The keys, oldest first within each purpose.
 * @example
 * ```ts
 * const keys = await listPublishedSigningKeys(db, context.clock());
 * ```
 */
export async function listPublishedSigningKeys(
  db: Executor,
  now: Date,
): Promise<readonly SigningKeyRow[]> {
  return await db
    .select()
    .from(signingKey)
    .where(or(eq(signingKey.status, "active"), hasLiveArtefact(now)))
    .orderBy(asc(signingKey.purpose), asc(signingKey.createdAt));
}

/**
 * Supersedes the active key of a purpose and installs a replacement.
 *
 * Both in one transaction, and in that order, because the partial unique index permits
 * exactly one active key: inserting first would be refused, and superseding without
 * inserting would leave a purpose with nothing to sign with.
 *
 * @param db - The executor.
 * @param input - The replacement pair and the time.
 * @returns The new active key.
 * @throws {Error} When the insert produces no row.
 * @example
 * ```ts
 * const key = await rotateSigningKey(db, { ...generated, purpose: "statements", now });
 * ```
 */
export async function rotateSigningKey(
  db: Executor,
  input: NewSigningKey,
): Promise<SigningKeyRow> {
  return await db.transaction(async (tx) => {
    await tx
      .update(signingKey)
      .set({
        status: "superseded",
        supersededAt: input.now,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(signingKey.purpose, input.purpose),
          eq(signingKey.status, "active"),
        ),
      );

    return requireRow(
      await tx.insert(signingKey).values(activeKeyValues(input)).returning(),
      "insert into signing_key",
    );
  });
}
