import {
  insertAccount,
  markAccountVerified,
  updateAccountStatus,
} from "@muster/db";
import { describeDatabase, uniqueName } from "@muster/db/test/harness";
import { afterAll, beforeAll, expect, test } from "bun:test";

import { authRateLimitPolicy } from "./routes.ts";
import { sessionCookieName } from "./sessions.ts";
import {
  request,
  sessionCookie,
  signUpAndSignIn,
  startTestServer,
  testPassword,
  verificationToken,
} from "../test/support.ts";

import type { TestServer } from "../test/support.ts";

/**
 * The account lifecycle over HTTP: sign up, prove the address, sign in, and
 * find out what an unapproved account may do - which is nothing that changes
 * anything.
 */

describeDatabase("the auth routes", () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startTestServer("auth");
  });

  afterAll(async () => {
    await server.close();
  });

  // Arranges an approved, verified admin, so the notification path has somewhere
  // to send and the approval routes have someone to act.
  const arrangeAdmin = async (): Promise<string> => {
    const admin = await insertAccount(server.database.sql, {
      email: `${uniqueName("admin")}@example.org`,
      displayName: "Track Admin",
      passwordHash: await Bun.password.hash(testPassword, "argon2id"),
      isAdmin: true,
    });
    await markAccountVerified(server.database.sql, admin.id, new Date());
    await updateAccountStatus(server.database.sql, {
      accountId: admin.id,
      status: "approved",
      decidedBy: admin.id,
      decidedAt: new Date(),
    });
    return admin.email;
  };

  const address = () => `${uniqueName("member")}@example.org`;

  // FR-001, FR-002, FR-003: the whole path a participant walks, and the state
  // they are left in at the end of it.
  test("signs up, verifies the address, signs in and reports the caller", async () => {
    const adminEmail = await arrangeAdmin();
    const email = address();

    const signedUp = await request(server, "POST", "/api/auth/sign-up", {
      body: { email, displayName: "Server Owner", password: testPassword },
    });

    expect(signedUp.status).toBe(201);
    expect(await signedUp.json()).toMatchObject({
      account: {
        email,
        displayName: "Server Owner",
        status: "pending",
        emailVerified: false,
        isAdmin: false,
      },
    });

    // The verification message goes to the address being proved, and the admins
    // are told there is someone waiting (FR-003).
    const verification = server.sentMail.find((message) =>
      message.includes("/verify?token="),
    );
    expect(verification).toContain(`To: ${email}`);
    expect(verification).toContain("https://muster.example.org/verify?token=");
    const notice = server.sentMail.find((message) =>
      message.includes("awaiting approval"),
    );
    expect(notice).toContain(`To: ${adminEmail}`);
    // No credential is ever written anywhere it can be read back.
    expect(server.sentMail.join("\n")).not.toContain(testPassword);

    const verified = await request(server, "POST", "/api/auth/verify", {
      body: { token: verificationToken(server) },
    });
    expect(verified.status).toBe(200);
    expect(await verified.json()).toMatchObject({
      account: { email, status: "pending", emailVerified: true },
    });

    const signedIn = await request(server, "POST", "/api/auth/sign-in", {
      body: { email, password: testPassword },
    });
    expect(signedIn.status).toBe(200);
    const cookie = signedIn.headers.get("set-cookie") ?? "";
    // The session token is opaque, in an HttpOnly SameSite=Lax cookie.
    expect(cookie).toContain(`${sessionCookieName}=`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Secure");

    const me = await request(server, "GET", "/api/auth/me", {
      cookie: sessionCookie(signedIn),
    });
    expect(me.status).toBe(200);
    expect(await me.json()).toEqual({
      account: {
        id: expect.any(String),
        email,
        displayName: "Server Owner",
        status: "pending",
        emailVerified: true,
        isAdmin: false,
      },
      memberships: [],
    });

    const signedOut = await request(server, "POST", "/api/auth/sign-out", {
      cookie: sessionCookie(signedIn),
    });
    expect(signedOut.status).toBe(200);
    expect(
      (
        await request(server, "GET", "/api/auth/me", {
          cookie: sessionCookie(signedIn),
        })
      ).status,
    ).toBe(401);
  });

  test("refuses to say who the caller is without a session", async () => {
    const response = await request(server, "GET", "/api/auth/me");

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: "unauthorised" });
  });

  // The spec's edge case: the verification link is used twice.
  test("refuses a verification token that has already been spent", async () => {
    const email = address();
    await request(server, "POST", "/api/auth/sign-up", {
      body: { email, displayName: "Twice", password: testPassword },
    });
    const token = verificationToken(server);
    await request(server, "POST", "/api/auth/verify", { body: { token } });

    const second = await request(server, "POST", "/api/auth/verify", {
      body: { token },
    });

    expect(second.status).toBe(422);
    expect(await second.json()).toMatchObject({
      error: "unprocessable",
      detail: expect.stringContaining("already been used"),
    });
  });

  test("refuses a verification token it has never issued", async () => {
    const response = await request(server, "POST", "/api/auth/verify", {
      body: { token: "not-a-token" },
    });

    expect(response.status).toBe(422);
  });

  test("refuses a second account for the same address", async () => {
    const email = address();
    await request(server, "POST", "/api/auth/sign-up", {
      body: { email, displayName: "First", password: testPassword },
    });

    const second = await request(server, "POST", "/api/auth/sign-up", {
      body: { email, displayName: "Second", password: testPassword },
    });

    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ error: "conflict" });
  });

  test("refuses a short password", async () => {
    const response = await request(server, "POST", "/api/auth/sign-up", {
      body: { email: address(), displayName: "Short", password: "hunter2" },
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_request" });
  });

  // The same answer for a wrong password as for an unknown address: the reply
  // says nothing about which accounts exist.
  test("refuses a sign-in with the wrong password", async () => {
    const email = address();
    await request(server, "POST", "/api/auth/sign-up", {
      body: { email, displayName: "Owner", password: testPassword },
    });

    const wrong = await request(server, "POST", "/api/auth/sign-in", {
      body: { email, password: "not the password" },
    });
    const unknown = await request(server, "POST", "/api/auth/sign-in", {
      body: { email: address(), password: testPassword },
    });

    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(await wrong.json()).toEqual(await unknown.json());
  });

  // FR-002: no create or edit rights until an admin approves the account. The
  // organisation route is the cheapest write to try.
  test("refuses a pending account any write", async () => {
    const member = await signUpAndSignIn(server, address());

    const response = await request(server, "POST", "/api/organisations", {
      body: { name: "Premature" },
      cookie: member.cookie,
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: "forbidden",
      detail: expect.stringContaining("awaiting approval"),
    });
  });

  // The positive control for the test above: approval is the only difference.
  test("lets an approved, verified account write", async () => {
    const member = await signUpAndSignIn(server, address());
    await updateAccountStatus(server.database.sql, {
      accountId: member.id,
      status: "approved",
      decidedBy: member.id,
      decidedAt: new Date(),
    });

    const response = await request(server, "POST", "/api/organisations", {
      body: { name: "Approved Co" },
      cookie: member.cookie,
    });

    expect(response.status).toBe(201);
  });

  // FR-002 and the spec's revocation scenario: the rights go away again.
  test("refuses a revoked account any write", async () => {
    const member = await signUpAndSignIn(server, address());
    await updateAccountStatus(server.database.sql, {
      accountId: member.id,
      status: "approved",
      decidedBy: member.id,
      decidedAt: new Date(),
    });
    await updateAccountStatus(server.database.sql, {
      accountId: member.id,
      status: "revoked",
      decidedBy: member.id,
      decidedAt: new Date(),
    });

    const response = await request(server, "POST", "/api/organisations", {
      body: { name: "Revoked Co" },
      cookie: member.cookie,
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      detail: expect.stringContaining("revoked"),
    });
  });

  // FR-035: the credential routes are rate limited by address and route. A
  // fresh application per test is what makes the count predictable.
  test("refuses further sign-in attempts once the window is full", async () => {
    const isolated = await startTestServer("authlimit");
    try {
      const email = address();
      const attempts = [];
      for (let attempt = 0; attempt < authRateLimitPolicy.limit; attempt += 1) {
        attempts.push(
          await request(isolated, "POST", "/api/auth/sign-in", {
            body: { email, password: "wrong" },
          }),
        );
      }
      expect(attempts.map((response) => response.status)).toEqual(
        Array.from({ length: authRateLimitPolicy.limit }, () => 401),
      );

      const refused = await request(isolated, "POST", "/api/auth/sign-in", {
        body: { email, password: "wrong" },
      });

      expect(refused.status).toBe(429);
      expect(await refused.json()).toMatchObject({ error: "rate_limited" });
      expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);

      // The limit is per route: sign-up still answers.
      const elsewhere = await request(isolated, "POST", "/api/auth/sign-up", {
        body: { email, displayName: "Elsewhere", password: testPassword },
      });
      expect(elsewhere.status).toBe(201);
    } finally {
      await isolated.close();
    }
  });

  // FR-035 names three endpoints, and reading your own session is not one of
  // them. It matters because a connectathon venue is behind one address: the
  // console asks who the caller is on every screen it renders, and a limit on
  // that would lock a whole room out of the console after a few page loads
  // between them.
  test("does not rate limit reading the session", async () => {
    const isolated = await startTestServer("authmelimit");
    try {
      const member = await signUpAndSignIn(isolated, address());
      const statuses = [];
      for (
        let attempt = 0;
        attempt < authRateLimitPolicy.limit * 2;
        attempt += 1
      ) {
        const response = await request(isolated, "GET", "/api/auth/me", {
          cookie: member.cookie,
        });
        statuses.push(response.status);
      }

      expect(statuses.every((status) => status === 200)).toBeTrue();
    } finally {
      await isolated.close();
    }
  });

  // Nor is signing out, for the same reason: it spends no credential.
  test("does not rate limit signing out", async () => {
    const isolated = await startTestServer("authsignoutlimit");
    try {
      const statuses = [];
      for (
        let attempt = 0;
        attempt < authRateLimitPolicy.limit + 2;
        attempt += 1
      ) {
        const response = await request(isolated, "POST", "/api/auth/sign-out");
        statuses.push(response.status);
      }

      expect(statuses.every((status) => status === 200)).toBeTrue();
    } finally {
      await isolated.close();
    }
  });
});
