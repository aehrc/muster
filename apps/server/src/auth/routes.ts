/**
 * Signing up, verifying an address, signing in and out.
 *
 * Five decisions here are the ones a reader should not have to reconstruct.
 *
 * **A sign-in refusal is one refusal.** An unknown address and a wrong password answer with
 * the same status and the same body, and both cost one argon2id verification - the unknown
 * address is checked against {@link UNMATCHABLE_PASSWORD_HASH}. Identical bodies with
 * different timings is not a closed oracle, it is a slower one.
 *
 * **Sign-up does say when an address is taken.** That is deliberate, and it is the opposite
 * trade: a participant whose colleague already registered their shared address otherwise
 * waits for an email that will never arrive. The directory already shows every approved
 * member's address to every other approved member, so the refusal publishes nothing new.
 *
 * **Verification is where the admins are told.** FR-003 asks for an awaiting-approval
 * notice; sending it when the address is verified rather than when the account is created
 * keeps the queue free of sign-ups from addresses nobody controls.
 *
 * **A failed notification is reported, not swallowed.** Sign-up whose verification email
 * could not be sent answers 502 and says the account exists and a resend is available,
 * because the alternative is an account nobody can finish creating and no indication why
 * (FR-037).
 *
 * **Nothing here logs a credential.** No password, no token, no verification link reaches a
 * log line from this module; the console mail transport prints the message it was asked to
 * send, which is a different thing and is the point of that transport (FR-036).
 *
 * Author: John Grimes
 */

import {
  resendVerificationSchema,
  signInSchema,
  signUpSchema,
  verifyEmailSchema,
} from "@muster/contracts";
import {
  accountTokenRefusal,
  foldEmail,
  verificationExpiry,
} from "@muster/core";
import {
  deleteSession,
  findAccountByEmail,
  findAccountToken,
  insertAccount,
  insertAccountToken,
  insertSession,
  listAdminEmails,
  listMemberships,
  markAccountTokenUsed,
  markEmailVerified,
} from "@muster/db";

import {
  hashPassword,
  UNMATCHABLE_PASSWORD_HASH,
  verifyPassword,
} from "./passwords.js";
import {
  clearedSessionCookie,
  presentedSessionToken,
  sessionCookie,
  sessionExpiry,
} from "./sessions.js";
import { generateOpaqueToken, hashToken } from "./tokens.js";
import { jsonError } from "../http/errors.js";
import { rateLimit } from "../http/rateLimit.js";
import { parseBody } from "../http/requestBody.js";
import { membershipView, sessionAccountView } from "../http/views.js";
import {
  awaitingApprovalMessage,
  verificationMessage,
} from "../mail/messages.js";

import type { MusterEnvironment, ServerContext } from "../context.js";
import type { Me } from "@muster/contracts";
import type { AccountRow } from "@muster/db";
import type { Context, Hono } from "hono";

/** What to tell somebody whose verification link will not work. */
const RESEND_OFFER =
  "Ask for another verification email from the sign-in page.";

/**
 * Who the caller is, in the one shape every credential route answers with.
 *
 * The memberships are read alongside the account because the console needs both on every
 * transition and a second round trip to discover them would leave the page briefly claiming
 * the member belongs to nothing.
 */
async function meResponse(
  context: ServerContext,
  account: AccountRow,
): Promise<Me> {
  const memberships = await listMemberships(context.db, account.id);
  return {
    account: sessionAccountView(account),
    memberships: memberships.map(membershipView),
  };
}

/**
 * Issues a verification link and sends it.
 *
 * @returns Whether the message was accepted for delivery. A refusal is the caller's to
 *   report: at sign-up it fails the request, and on a resend it does not.
 */
async function sendVerification(
  context: ServerContext,
  account: AccountRow,
): Promise<boolean> {
  const now = context.clock();
  const token = generateOpaqueToken();
  await insertAccountToken(context.db, {
    accountId: account.id,
    purpose: "email_verification",
    tokenHash: hashToken(token),
    expiresAt: verificationExpiry(now),
  });

  try {
    await context.mail.send(
      verificationMessage({
        to: account.email,
        displayName: account.displayName,
        publicUrl: context.config.publicUrl,
        token,
      }),
    );
    return true;
  } catch (error) {
    // The cause is logged and the token is not. A relay failure is an operational fault
    // that somebody has to see; the link is a credential.
    console.error(
      JSON.stringify({
        message: "muster.mail.failed",
        purpose: "email_verification",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return false;
  }
}

/**
 * Tells the admins that somebody is waiting.
 *
 * Failures are logged and do not fail the verification: the member has done their part, and
 * an admin can find them in the queue whether or not the notice arrived.
 */
async function notifyAdmins(
  context: ServerContext,
  account: AccountRow,
): Promise<void> {
  const admins = await listAdminEmails(context.db);
  for (const to of admins) {
    try {
      await context.mail.send(
        awaitingApprovalMessage({
          to,
          displayName: account.displayName,
          email: account.email,
          publicUrl: context.config.publicUrl,
        }),
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          message: "muster.mail.failed",
          purpose: "awaiting_approval",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }
}

/**
 * Opens a session and answers with it.
 *
 * @returns The response, carrying the cookie and who the caller now is.
 */
async function establishSession(
  context: ServerContext,
  c: Context<MusterEnvironment>,
  account: AccountRow,
): Promise<Response> {
  const now = context.clock();
  const token = generateOpaqueToken();
  await insertSession(context.db, {
    accountId: account.id,
    tokenHash: hashToken(token),
    expiresAt: sessionExpiry(now),
  });

  c.header("Set-Cookie", sessionCookie(token, context.config.publicUrl));
  // A response that establishes a credential must never be cached, even though the
  // credential is in a header rather than in the body.
  c.header("Cache-Control", "no-store");
  return c.json(await meResponse(context, account));
}

/**
 * Registers the credential routes.
 *
 * @param router - The API router.
 * @param context - The server's dependencies.
 * @example
 * ```ts
 * registerAuthRoutes(router, context);
 * ```
 */
export function registerAuthRoutes(
  router: Hono<MusterEnvironment>,
  context: ServerContext,
): void {
  /** Creates a pending account and sends it a verification link. */
  router.post("/auth/sign-up", rateLimit("signUp", context), async (c) => {
    const body = await parseBody(c, signUpSchema);
    if (body instanceof Response) {
      return body;
    }

    const created = await insertAccount(context.db, {
      email: foldEmail(body.email),
      displayName: body.displayName,
      passwordHash: await hashPassword(body.password),
    });
    if (!created.ok) {
      return jsonError(
        c,
        409,
        "email_taken",
        "An account already exists for that address. Sign in, or ask for a new verification email.",
      );
    }

    if (!(await sendVerification(context, created.account))) {
      return jsonError(
        c,
        502,
        "mail_failed",
        `Your account was created but the verification email could not be sent. ${RESEND_OFFER}`,
      );
    }

    c.header("Cache-Control", "no-store");
    return c.json(await meResponse(context, created.account), 201);
  });

  /** Redeems a verification link. */
  router.post("/auth/verify", rateLimit("verify", context), async (c) => {
    const body = await parseBody(c, verifyEmailSchema);
    if (body instanceof Response) {
      return body;
    }

    const stored = await findAccountToken(context.db, hashToken(body.token));
    if (stored === undefined || stored.purpose !== "email_verification") {
      return jsonError(
        c,
        400,
        "invalid_token",
        `That verification link is not one Muster issued. ${RESEND_OFFER}`,
      );
    }

    const now = context.clock();
    const refusal = accountTokenRefusal(stored, now);
    if (refusal !== undefined) {
      return jsonError(
        c,
        400,
        refusal,
        refusal === "token_used"
          ? "That verification link has already been used. Sign in instead."
          : `That verification link has expired. ${RESEND_OFFER}`,
      );
    }

    // Conditional on the token still being unredeemed, so two requests carrying one link
    // cannot both succeed.
    if (
      (await markAccountTokenUsed(context.db, stored.id, now)) === undefined
    ) {
      return jsonError(
        c,
        400,
        "token_used",
        "That verification link has already been used. Sign in instead.",
      );
    }

    const verified = await markEmailVerified(context.db, stored.accountId, now);
    if (verified === undefined) {
      return jsonError(
        c,
        400,
        "token_used",
        "That address was already verified. Sign in instead.",
      );
    }

    await notifyAdmins(context, verified);
    c.header("Cache-Control", "no-store");
    return c.json(await meResponse(context, verified));
  });

  /**
   * Sends another verification link.
   *
   * Answers the same way whether or not there is an unverified account at that address. Its
   * caller needs no account, and the difference is not actionable for anybody legitimate.
   */
  router.post(
    "/auth/resend-verification",
    rateLimit("verify", context),
    async (c) => {
      const body = await parseBody(c, resendVerificationSchema);
      if (body instanceof Response) {
        return body;
      }

      const found = await findAccountByEmail(context.db, foldEmail(body.email));
      if (found !== undefined && found.emailVerifiedAt === null) {
        await sendVerification(context, found);
      }

      c.header("Cache-Control", "no-store");
      return c.json(
        {
          status: "accepted",
          detail:
            "If that address has an unverified Muster account, a new link is on its way.",
        },
        202,
      );
    },
  );

  /** Signs in. */
  router.post("/auth/sign-in", rateLimit("signIn", context), async (c) => {
    const body = await parseBody(c, signInSchema);
    if (body instanceof Response) {
      return body;
    }

    const found = await findAccountByEmail(context.db, foldEmail(body.email));
    // Verified whether or not the account exists, so that every refusal costs the same.
    const matches = await verifyPassword(
      body.password,
      found?.passwordHash ?? UNMATCHABLE_PASSWORD_HASH,
    );
    if (found === undefined || !matches) {
      return jsonError(
        c,
        401,
        "invalid_credentials",
        "That address and password do not match an account",
      );
    }

    if (found.emailVerifiedAt === null) {
      // Said plainly, and only after the password was right: the holder cannot finish
      // creating their account without knowing this.
      return jsonError(
        c,
        403,
        "email_unverified",
        `Verify your address before signing in. ${RESEND_OFFER}`,
      );
    }

    // A revoked or still-pending account signs in and is told where it stands by the
    // account payload. Refusing the sign-in would leave them with no way to find out why.
    return await establishSession(context, c, found);
  });

  /** Signs out. */
  router.post("/auth/sign-out", async (c) => {
    const token = presentedSessionToken(c.req.header("cookie"));
    if (token !== undefined) {
      await deleteSession(context.db, hashToken(token));
    }
    // Cleared whether or not there was a session to end, so a stale cookie does not
    // survive a sign-out.
    c.header("Set-Cookie", clearedSessionCookie(context.config.publicUrl));
    c.header("Cache-Control", "no-store");
    return c.body(null, 204);
  });

  /**
   * Who the caller is.
   *
   * 200 with a null account for an anonymous visitor rather than 401: every public page asks
   * this on load, and answering a visitor's ordinary state with an error would make the
   * console treat browsing without an account as a failure.
   */
  router.get("/auth/me", async (c) => {
    const account = c.get("account");
    c.header("Cache-Control", "no-store");
    if (account === undefined) {
      return c.json({ account: null, memberships: [] } satisfies Me);
    }
    return c.json(await meResponse(context, account));
  });
}
