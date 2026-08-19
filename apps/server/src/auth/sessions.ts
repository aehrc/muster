import {
  authoriseAdmin,
  authoriseMembership,
  authoriseWrite,
} from "@muster/core";
import {
  deleteSession,
  findAccountByEmail,
  findAccountBySessionToken,
  insertSession,
  listMembershipsForAccount,
} from "@muster/db";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";

import type { AppEnvironment } from "../app.ts";
import type { AccountFacts, Refusal, RefusalReason } from "@muster/core";
import type { AccountRow, Membership } from "@muster/db";
import type { Context } from "hono";

/**
 * Sessions and the guards every mutation passes through.
 *
 * A session is an opaque random token in an HttpOnly, SameSite=Lax cookie. Only
 * its SHA-256 digest is stored, so a leaked database gives no one a usable
 * session; the token has no structure and carries no claims, so there is
 * nothing in it to forge.
 *
 * The guards are the deny-by-default boundary. Each answers a decision made by
 * the pure rules in `packages/core`, and each throws the refusal as an HTTP
 * exception with the wording the rules produced, so the person refused is told
 * which condition they failed.
 *
 * @author John Grimes
 */

/** The cookie the opaque session token travels in. */
export const sessionCookieName = "muster_session";

/**
 * How long a session lives.
 *
 * Long enough to span a connectathon without a second sign-in, short enough
 * that an abandoned laptop is not a standing key.
 */
export const sessionLifetimeMs = 14 * 24 * 60 * 60 * 1000;

/** Bytes of randomness in a session or verification token. */
const tokenBytes = 32;

/**
 * Mints an opaque token.
 *
 * @returns a URL-safe token with 256 bits of randomness
 * @example
 * ```ts
 * const token = createOpaqueToken();
 * ```
 */
export const createOpaqueToken = (): string =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(tokenBytes))).toString(
    "base64url",
  );

/**
 * Digests a token for storage.
 *
 * SHA-256 rather than a password hash: the token is 256 random bits, so there
 * is no dictionary to attack and no reason to make verification slow.
 *
 * @param token - the token as the holder presented it
 * @returns the hexadecimal digest
 * @example
 * ```ts
 * await findAccountBySessionToken(sql, hashToken(token), new Date());
 * ```
 */
export const hashToken = (token: string): string =>
  new Bun.CryptoHasher("sha256").update(token).digest("hex");

/**
 * Reads what the rules need to know about an account.
 *
 * @param account - the account as stored
 * @returns the facts the rules decide on
 */
export const factsFor = (account: AccountRow): AccountFacts => ({
  status: account.status,
  emailVerifiedAt: account.emailVerifiedAt,
  isAdmin: account.isAdmin,
});

/**
 * The refusals that are about the input rather than the caller's rights: a token
 * that cannot be spent, a record that is not in the event named, a server that
 * registers nothing, and metadata that cannot be vouched for.
 */
const unprocessableReasons = new Set<RefusalReason>([
  "token_used",
  "token_expired",
  "not_in_event",
  "registration_not_needed",
  "invalid_metadata",
  "manual_registration",
]);

/**
 * The refusals that are about the state of the world rather than the caller's
 * rights: a closed event, a transition that has already happened, a record that
 * already exists, and vouching whose window has passed.
 */
const conflictReasons = new Set<RefusalReason>([
  "event_not_open",
  "illegal_transition",
  "duplicate_pairing",
  "vouching_expired",
]);

/**
 * Turns a refusal into the HTTP answer for it.
 *
 * Every refusal is a 403 - the caller may not - except those about the input,
 * which are unprocessable, and those about the state of the world, which are
 * conflicts.
 *
 * @param refusal - the refusal the rules produced
 * @returns the exception to throw
 * @example
 * ```ts
 * const decision = authoriseWrite(factsFor(account));
 * if (!decision.ok) {
 *   throw refusalError(decision.refusal);
 * }
 * ```
 */
export const refusalError = (refusal: Refusal): HTTPException => {
  if (unprocessableReasons.has(refusal.reason)) {
    return new HTTPException(422, { message: refusal.detail });
  }
  if (conflictReasons.has(refusal.reason)) {
    return new HTTPException(409, { message: refusal.detail });
  }
  return new HTTPException(403, { message: refusal.detail });
};

/**
 * Starts a session and sets its cookie.
 *
 * The cookie is HttpOnly so that no script can read it, SameSite=Lax so that a
 * cross-site form post cannot act as the member, and Secure whenever the public
 * URL is https - which is every deployment.
 *
 * @param context - the request being answered
 * @param accountId - the account signing in
 * @returns nothing
 * @example
 * ```ts
 * await startSession(context, account.id);
 * ```
 */
export const startSession = async (
  context: Context<AppEnvironment>,
  accountId: string,
): Promise<void> => {
  const token = createOpaqueToken();
  const expiresAt = new Date(Date.now() + sessionLifetimeMs);
  await insertSession(context.get("sql"), {
    accountId,
    tokenHash: hashToken(token),
    expiresAt,
  });
  setCookie(context, sessionCookieName, token, {
    httpOnly: true,
    sameSite: "Lax",
    secure: context.get("config").publicUrl.startsWith("https:"),
    path: "/",
    expires: expiresAt,
  });
};

/**
 * Ends the session the request presented, if any.
 *
 * @param context - the request being answered
 * @returns nothing
 */
export const endSession = async (
  context: Context<AppEnvironment>,
): Promise<void> => {
  const token = getCookie(context, sessionCookieName);
  if (token !== undefined) {
    await deleteSession(context.get("sql"), hashToken(token));
  }
  deleteCookie(context, sessionCookieName, { path: "/" });
};

/**
 * Reads the account behind the request's session cookie.
 *
 * @param context - the request being answered
 * @returns the account, or undefined when the caller is anonymous or the
 *   session has expired
 * @example
 * ```ts
 * const account = await currentAccount(context);
 * const contactsVisible = account !== undefined && authoriseWrite(factsFor(account)).ok;
 * ```
 */
export const currentAccount = async (
  context: Context<AppEnvironment>,
): Promise<AccountRow | undefined> => {
  const token = getCookie(context, sessionCookieName);
  if (token === undefined) {
    return undefined;
  }
  return findAccountBySessionToken(
    context.get("sql"),
    hashToken(token),
    new Date(),
  );
};

/**
 * Requires a signed-in account, whatever its status.
 *
 * Used by the routes that report state rather than change it: a pending member
 * has to be able to see that they are pending.
 *
 * @param context - the request being answered
 * @returns the account
 * @throws {HTTPException} 401 when the caller is not signed in
 */
export const requireAccount = async (
  context: Context<AppEnvironment>,
): Promise<AccountRow> => {
  const account = await currentAccount(context);
  if (account === undefined) {
    throw new HTTPException(401, { message: "Sign in to do that." });
  }
  return account;
};

/**
 * Requires an account that may create or edit content.
 *
 * @param context - the request being answered
 * @returns the account
 * @throws {HTTPException} 401 when the caller is not signed in, 403 when the
 *   account is pending, revoked or unverified
 * @example
 * ```ts
 * const account = await requireWriter(context);
 * ```
 */
export const requireWriter = async (
  context: Context<AppEnvironment>,
): Promise<AccountRow> => {
  const account = await requireAccount(context);
  const decision = authoriseWrite(factsFor(account));
  if (!decision.ok) {
    throw refusalError(decision.refusal);
  }
  return account;
};

/**
 * Requires a track admin.
 *
 * @param context - the request being answered
 * @returns the account
 * @throws {HTTPException} 401 when the caller is not signed in, 403 when the
 *   account may not act as an admin
 */
export const requireAdmin = async (
  context: Context<AppEnvironment>,
): Promise<AccountRow> => {
  const account = await requireAccount(context);
  const decision = authoriseAdmin(factsFor(account));
  if (!decision.ok) {
    throw refusalError(decision.refusal);
  }
  return account;
};

/**
 * Requires an account that may act for an organisation.
 *
 * @param context - the request being answered
 * @param organisationId - the organisation being acted for
 * @returns the account and its memberships
 * @throws {HTTPException} 401 when the caller is not signed in, 403 when the
 *   account may not write or is not a member of the organisation
 * @example
 * ```ts
 * const { account } = await requireMember(context, system.organisationId);
 * ```
 */
export const requireMember = async (
  context: Context<AppEnvironment>,
  organisationId: string,
): Promise<{
  /** the account acting */
  readonly account: AccountRow;
  /** every organisation it belongs to */
  readonly memberships: readonly Membership[];
}> => {
  const account = await requireWriter(context);
  const memberships = await listMembershipsForAccount(
    context.get("sql"),
    account.id,
  );
  const decision = authoriseMembership(
    factsFor(account),
    memberships.map((membership) => membership.organisationId),
    organisationId,
  );
  if (!decision.ok) {
    throw refusalError(decision.refusal);
  }
  return { account, memberships };
};

/**
 * Finds an account that may be given rights, by its address.
 *
 * Used where one person names another - inviting a member, reassigning an
 * orphaned organisation - so it refuses an account that could not have acted for
 * itself: rights cannot be handed to an unapproved or revoked account (FR-005).
 *
 * @param context - the request being answered
 * @param email - the address named
 * @returns the account
 * @throws {HTTPException} 422 when there is no such account, or it is not
 *   approved with a verified address
 * @example
 * ```ts
 * const invited = await requireGrantableAccount(context, body.email);
 * ```
 */
export const requireGrantableAccount = async (
  context: Context<AppEnvironment>,
  email: string,
): Promise<AccountRow> => {
  const account = await findAccountByEmail(context.get("sql"), email);
  if (account === undefined) {
    throw new HTTPException(422, {
      message: "No Muster account holds that address.",
    });
  }
  const decision = authoriseWrite(factsFor(account));
  if (!decision.ok) {
    throw new HTTPException(422, {
      message: `That account cannot be given rights: ${decision.refusal.detail}`,
    });
  }
  return account;
};
