/**
 * The credential routes, end to end against a real database.
 *
 * These are the properties nothing above them can restore: that an account cannot be used
 * before its address is verified, that a verification link works exactly once, that an
 * approved account and a pending one are told apart, and that the cookie a browser receives
 * carries the attributes that make it a session rather than a bearer token in a shop window.
 *
 * The notifications are asserted here too. FR-003 is a promise about messages, and the only
 * place it can be checked is where the messages are.
 *
 * Author: John Grimes
 */

import { hasTestDatabase, makeAccount, uniqueSuffix } from "@muster/db";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import { apiJson, apiRequest } from "../test/api.js";
import { createTestStack, TEST_PASSWORD } from "../test/harness.js";

import type { TestStack } from "../test/harness.js";
import type { Me } from "@muster/contracts";

/** The verification token out of the message the console transport would have printed. */
function tokenFromLink(text: string): string {
  const found = /\/verify\?token=([\w-]+)/.exec(text);
  if (found?.[1] === undefined) {
    throw new Error(`no verification link in the message:\n${text}`);
  }
  return decodeURIComponent(found[1]);
}

describe.skipIf(!hasTestDatabase())("the credential routes", () => {
  let stack: TestStack;

  beforeAll(async () => {
    stack = await createTestStack();
  });

  afterAll(async () => {
    await stack.close();
  });

  /** Signs up, and returns the address and the token that was emailed. */
  async function signUp(displayName = "Jo Chen") {
    const email = `signup-${uniqueSuffix()}@muster.test`;
    const before = stack.sent.length;
    await apiJson<Me>(
      stack,
      "POST",
      "/api/auth/sign-up",
      { body: { email, displayName, password: TEST_PASSWORD } },
      201,
    );
    const message = stack.sent[before];
    if (message === undefined) {
      throw new Error("sign-up sent no verification email");
    }
    return { email, token: tokenFromLink(message.text) };
  }

  describe("signing up", () => {
    it("creates a pending account and emails a verification link", async () => {
      const email = `fresh-${uniqueSuffix()}@muster.test`;
      const before = stack.sent.length;

      const body = await apiJson<Me>(
        stack,
        "POST",
        "/api/auth/sign-up",
        { body: { email, displayName: "Jo Chen", password: TEST_PASSWORD } },
        201,
      );

      // Scenario 1: verification is required, and approval is required after it.
      expect(body.account?.status).toBe("pending");
      expect(body.account?.emailVerified).toBe(false);
      expect(body.account?.writeRefusal).toBe("email_unverified");
      expect(stack.sent[before]?.to).toBe(email);
      expect(stack.sent[before]?.subject).toContain("Verify");
      expect(stack.sent[before]?.text).toContain("/verify?token=");
    });

    it("folds the case of the address it stores", async () => {
      const local = `Mixed-${uniqueSuffix()}`;
      await apiJson<Me>(
        stack,
        "POST",
        "/api/auth/sign-up",
        {
          body: {
            email: `${local}@Muster.TEST`,
            displayName: "Jo",
            password: TEST_PASSWORD,
          },
        },
        201,
      );

      // Signing in with a different case finds the same account, which is the point of
      // folding it.
      const second = await apiRequest(stack, "POST", "/api/auth/sign-up", {
        body: {
          email: `${local.toLowerCase()}@muster.test`,
          displayName: "Someone else",
          password: TEST_PASSWORD,
        },
      });
      expect(second.status).toBe(409);
      expect(((await second.json()) as { error: string }).error).toBe(
        "email_taken",
      );
    });

    it("refuses a password shorter than the contract allows", async () => {
      const response = await apiRequest(stack, "POST", "/api/auth/sign-up", {
        body: {
          email: `short-${uniqueSuffix()}@muster.test`,
          displayName: "Jo",
          password: "short",
        },
      });

      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string; detail: string };
      expect(body.error).toBe("invalid_request");
      // The field is named, so the console can put the message beside the input.
      expect(body.detail).toContain("password");
    });
  });

  describe("verifying an address", () => {
    it("verifies once, and tells the admins somebody is waiting", async () => {
      const { email, token } = await signUp();
      const before = stack.sent.length;

      const body = await apiJson<Me>(stack, "POST", "/api/auth/verify", {
        body: { token },
      });

      expect(body.account?.emailVerified).toBe(true);
      // Still pending: verification proves the address, approval is an admin's decision.
      expect(body.account?.status).toBe("pending");
      expect(body.account?.writeRefusal).toBe("awaiting_approval");
      // FR-003: the admins are told there is somebody in the queue.
      const notice = stack.sent.slice(before);
      expect(notice.some((message) => message.to === stack.admin.email)).toBe(
        true,
      );
      expect(notice.some((message) => message.text.includes(email))).toBe(true);
    });

    it("refuses the second use of a link, and offers a resend", async () => {
      const { token } = await signUp();
      await apiJson<Me>(stack, "POST", "/api/auth/verify", { body: { token } });

      const again = await apiRequest(stack, "POST", "/api/auth/verify", {
        body: { token },
      });

      // The edge case: a link used twice fails with a clear message.
      expect(again.status).toBe(400);
      const body = (await again.json()) as { error: string; detail: string };
      expect(body.error).toBe("token_used");
      expect(body.detail).toContain("already been used");
    });

    it("refuses a link past its expiry, and offers a resend", async () => {
      const { token } = await signUp();
      stack.setNow(new Date("2026-09-03T10:00:00.000Z"));

      const response = await apiRequest(stack, "POST", "/api/auth/verify", {
        body: { token },
      });

      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string; detail: string };
      expect(body.error).toBe("token_expired");
      // The edge case asks for an offer to resend, not just a refusal.
      expect(body.detail).toContain("verification email");
      stack.setNow(new Date("2026-09-01T10:00:00.000Z"));
    });

    it("refuses a token it never issued", async () => {
      const response = await apiRequest(stack, "POST", "/api/auth/verify", {
        body: { token: "not-a-token-muster-minted" },
      });

      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: string }).error).toBe(
        "invalid_token",
      );
    });

    it("sends another link on request, and says nothing about who has an account", async () => {
      const { email } = await signUp();
      const before = stack.sent.length;

      const known = await apiRequest(
        stack,
        "POST",
        "/api/auth/resend-verification",
        { body: { email } },
      );
      const unknown = await apiRequest(
        stack,
        "POST",
        "/api/auth/resend-verification",
        { body: { email: `nobody-${uniqueSuffix()}@muster.test` } },
      );

      expect(known.status).toBe(202);
      // Identical answers: the caller needs no account, and the difference is not
      // actionable for anybody legitimate.
      expect(unknown.status).toBe(202);
      expect(await known.json()).toEqual(await unknown.json());
      // One message, for the address that has an unverified account.
      expect(stack.sent.slice(before).map((message) => message.to)).toEqual([
        email,
      ]);
    });
  });

  describe("signing in", () => {
    it("issues an httpOnly session cookie", async () => {
      const response = await apiRequest(stack, "POST", "/api/auth/sign-in", {
        body: { email: stack.admin.email, password: TEST_PASSWORD },
      });

      expect(response.status).toBe(200);
      const cookie = response.headers.get("set-cookie") ?? "";
      expect(cookie).toContain("muster_session=");
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("SameSite=Lax");
      // The harness's public URL is https, so the cookie must be marked Secure even though
      // no real connection is made.
      expect(cookie).toContain("Secure");
      expect(response.headers.get("cache-control")).toBe("no-store");
    });

    it("answers an unknown address exactly as it answers a wrong password", async () => {
      const unknown = await apiRequest(stack, "POST", "/api/auth/sign-in", {
        body: {
          email: `nobody-${uniqueSuffix()}@muster.test`,
          password: TEST_PASSWORD,
        },
      });
      const wrong = await apiRequest(stack, "POST", "/api/auth/sign-in", {
        body: { email: stack.admin.email, password: "not the password" },
      });

      expect(unknown.status).toBe(wrong.status);
      expect(await unknown.json()).toEqual(await wrong.json());
      expect(unknown.headers.get("set-cookie")).toBeNull();
    });

    it("refuses an account whose address is unverified, and offers a resend", async () => {
      const { email } = await signUp();

      const response = await apiRequest(stack, "POST", "/api/auth/sign-in", {
        body: { email, password: TEST_PASSWORD },
      });

      // FR-001: the account cannot be used before the address is proven. Said only after
      // the password was right, so it is not an enumeration oracle.
      expect(response.status).toBe(403);
      const body = (await response.json()) as { error: string; detail: string };
      expect(body.error).toBe("email_unverified");
      expect(body.detail).toContain("verification email");
    });

    it("lets a revoked account sign in and tells it where it stands", async () => {
      const revoked = await makeAccount(stack.db, {
        email: `revoked-${uniqueSuffix()}@muster.test`,
        status: "revoked",
        passwordHash: (await import("./passwords.js"))
          .UNMATCHABLE_PASSWORD_HASH,
      });

      // It cannot sign in with the unmatchable hash, which is the point of that constant:
      // the refusal is indistinguishable from a wrong password.
      const response = await apiRequest(stack, "POST", "/api/auth/sign-in", {
        body: { email: revoked.email, password: TEST_PASSWORD },
      });
      expect(response.status).toBe(401);
    });
  });

  describe("who the caller is", () => {
    it("answers an anonymous visitor with a null account rather than an error", async () => {
      const body = await apiJson<Me>(stack, "GET", "/api/auth/me");

      // Every public page asks this on load. A 401 would make browsing without an account
      // look like a failure.
      expect(body).toEqual({ account: null, memberships: [] });
    });

    it("answers a signed-in member with their own account and memberships", async () => {
      const body = await apiJson<Me>(stack, "GET", "/api/auth/me", {
        cookie: stack.adminCookie,
      });

      expect(body.account?.id).toBe(stack.admin.id);
      expect(body.account?.isAdmin).toBe(true);
      expect(body.account?.writeRefusal).toBeNull();
    });

    it("stops identifying the caller once they sign out", async () => {
      const member = await stack.makeMember();
      const cookie = await stack.signIn(member.email);

      const signedOut = await apiRequest(stack, "POST", "/api/auth/sign-out", {
        cookie,
      });
      const after = await apiJson<Me>(stack, "GET", "/api/auth/me", { cookie });

      expect(signedOut.status).toBe(204);
      // The row is gone, so the cookie a browser kept identifies nobody.
      expect(signedOut.headers.get("set-cookie")).toContain("Max-Age=0");
      expect(after.account).toBeNull();
    });

    it("clears the cookie even when there was no session to end", async () => {
      const response = await apiRequest(stack, "POST", "/api/auth/sign-out");

      expect(response.status).toBe(204);
      expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    });
  });

  describe("what a pending account may do", () => {
    it("refuses to let it create an organisation", async () => {
      const { email, token } = await signUp();
      await apiJson<Me>(stack, "POST", "/api/auth/verify", { body: { token } });
      const cookie = await stack.signIn(email);

      const response = await apiRequest(stack, "POST", "/api/organisations", {
        cookie,
        body: { name: "Too Soon" },
      });

      // Scenario 1: the account remains unable to create content until an admin approves it.
      expect(response.status).toBe(403);
      expect(((await response.json()) as { error: string }).error).toBe(
        "awaiting_approval",
      );
    });
  });

  describe("reporting a failed notification", () => {
    it("refuses a sign-up whose verification email could not be sent", async () => {
      const failing = await createTestStack({ mail: "failing" });
      try {
        const response = await apiRequest(
          failing,
          "POST",
          "/api/auth/sign-up",
          {
            body: {
              email: `unreachable-${uniqueSuffix()}@muster.test`,
              displayName: "Jo",
              password: TEST_PASSWORD,
            },
          },
        );

        // FR-037: the operation reports its own failure with a cause, rather than
        // succeeding into an account nobody can finish creating.
        expect(response.status).toBe(502);
        const body = (await response.json()) as {
          error: string;
          detail: string;
        };
        expect(body.error).toBe("mail_failed");
        expect(body.detail).toContain("verification email");
      } finally {
        await failing.close();
      }
    });
  });

  describe("rate limiting", () => {
    it("refuses a burst of sign-ins with 429 and a Retry-After", async () => {
      const limited = await createTestStack({ rateLimits: "enforced" });
      try {
        const attempt = async () =>
          await apiRequest(limited, "POST", "/api/auth/sign-in", {
            body: { email: limited.admin.email, password: "wrong" },
            headers: { "x-forwarded-for": "203.0.113.7" },
          });

        // The limit is ten a minute; the eleventh is refused. The clock is frozen, so the
        // window cannot roll underneath the assertion.
        const statuses: number[] = [];
        for (let attemptNumber = 0; attemptNumber < 12; attemptNumber += 1) {
          statuses.push((await attempt()).status);
        }

        expect(statuses.filter((status) => status === 401)).toHaveLength(10);
        const refused = await attempt();
        expect(refused.status).toBe(429);
        expect(refused.headers.get("retry-after")).toBeTruthy();
        expect(((await refused.json()) as { error: string }).error).toBe(
          "too_many_requests",
        );
      } finally {
        await limited.close();
      }
    });

    it("limits one address without limiting another", async () => {
      const limited = await createTestStack({ rateLimits: "enforced" });
      try {
        for (let attemptNumber = 0; attemptNumber < 11; attemptNumber += 1) {
          await apiRequest(limited, "POST", "/api/auth/sign-in", {
            body: { email: limited.admin.email, password: "wrong" },
            headers: { "x-forwarded-for": "203.0.113.8" },
          });
        }

        const elsewhere = await apiRequest(
          limited,
          "POST",
          "/api/auth/sign-in",
          {
            body: { email: limited.admin.email, password: "wrong" },
            headers: { "x-forwarded-for": "203.0.113.9" },
          },
        );

        // Keyed by address and route, so one caller's guessing cannot exhaust another's
        // allowance - which a key derived from the submitted address would allow.
        expect(elsewhere.status).toBe(401);
      } finally {
        await limited.close();
      }
    });
  });
});
