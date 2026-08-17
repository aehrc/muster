import { describe, expect, test } from "bun:test";

import { loadConfig, publicUrlFor } from "./config.ts";

/**
 * Configuration is deny by default: anything absent, empty or unparseable
 * fails start-up rather than starting the server on a guess.
 */

/** A complete, valid environment. Tests override one key at a time. */
const completeEnvironment = {
  MUSTER_PUBLIC_URL: "https://muster.example.org",
  MUSTER_MASTER_KEY: "0123456789abcdef0123456789abcdef",
  MUSTER_DATABASE_URL: "postgresql://muster_server:secret@db:5432/muster",
  MUSTER_MIGRATION_DATABASE_URL:
    "postgresql://muster_owner:secret@db:5432/muster",
} as const;

/**
 * Builds an environment with one required variable removed.
 *
 * @param key - the variable to leave out
 * @returns the remaining environment
 */
const environmentWithout = (
  key: keyof typeof completeEnvironment,
): Record<string, string | undefined> => {
  const rest: Record<string, string | undefined> = { ...completeEnvironment };
  delete rest[key];
  return rest;
};

describe("loadConfig", () => {
  // Arrange-Act-Assert: the happy path first, so the shape every other test
  // perturbs is stated once.
  test("reads a complete environment", () => {
    const config = loadConfig({
      ...completeEnvironment,
      MUSTER_PORT: "9090",
      MUSTER_SMTP_URL: "smtps://user:pass@smtp.example.org:465",
      MUSTER_MAIL_FROM: "Muster <muster@example.org>",
      MUSTER_SERVER_DATABASE_ROLE: "muster_serving",
      MUSTER_SERVER_DATABASE_PASSWORD: "serving-secret",
      MUSTER_OUTBOUND_TIMEOUT_MS: "5000",
      MUSTER_OUTBOUND_ALLOWLIST: "stub-register:9000, localhost",
    });

    expect(config.publicUrl).toBe("https://muster.example.org");
    expect(config.port).toBe(9090);
    expect(config.masterKey).toBe(completeEnvironment.MUSTER_MASTER_KEY);
    expect(config.databaseUrl).toBe(completeEnvironment.MUSTER_DATABASE_URL);
    expect(config.migrationDatabaseUrl).toBe(
      completeEnvironment.MUSTER_MIGRATION_DATABASE_URL,
    );
    expect(config.serverDatabaseRole).toBe("muster_serving");
    expect(config.serverDatabasePassword).toBe("serving-secret");
    expect(config.mailFrom).toBe("Muster <muster@example.org>");
    expect(config.mail).toEqual({
      kind: "smtp",
      url: "smtps://user:pass@smtp.example.org:465",
    });
    expect(config.outbound.timeoutMs).toBe(5000);
    expect(config.outbound.allowedHosts).toEqual([
      "stub-register:9000",
      "localhost",
    ]);
  });

  test("applies the documented defaults when optional variables are absent", () => {
    const config = loadConfig(completeEnvironment);

    expect(config.port).toBe(8080);
    expect(config.serverDatabaseRole).toBe("muster_server");
    expect(config.serverDatabasePassword).toBeUndefined();
    expect(config.outbound.timeoutMs).toBe(10_000);
    expect(config.outbound.allowedHosts).toEqual([]);
  });

  // MUSTER_PUBLIC_URL: required, and every public URL in the product is
  // derived from it, so a bad value cannot be tolerated.
  test("requires MUSTER_PUBLIC_URL", () => {
    expect(() => loadConfig(environmentWithout("MUSTER_PUBLIC_URL"))).toThrow(
      /MUSTER_PUBLIC_URL/,
    );
  });

  test("refuses an empty MUSTER_PUBLIC_URL", () => {
    expect(() =>
      loadConfig({ ...completeEnvironment, MUSTER_PUBLIC_URL: "" }),
    ).toThrow(/MUSTER_PUBLIC_URL/);
  });

  test("refuses a MUSTER_PUBLIC_URL that is not an absolute http(s) URL", () => {
    for (const value of [
      "muster.example.org",
      "ftp://muster.example.org",
      "/muster",
    ]) {
      expect(() =>
        loadConfig({ ...completeEnvironment, MUSTER_PUBLIC_URL: value }),
      ).toThrow(/MUSTER_PUBLIC_URL/);
    }
  });

  test("strips trailing slashes from MUSTER_PUBLIC_URL", () => {
    const config = loadConfig({
      ...completeEnvironment,
      MUSTER_PUBLIC_URL: "https://muster.example.org/directory//",
    });

    expect(config.publicUrl).toBe("https://muster.example.org/directory");
  });

  // MUSTER_MASTER_KEY: signing keys are unreadable without it, so a missing or
  // trivially short value is a refusal.
  test("requires MUSTER_MASTER_KEY", () => {
    expect(() => loadConfig(environmentWithout("MUSTER_MASTER_KEY"))).toThrow(
      /MUSTER_MASTER_KEY/,
    );
  });

  test("refuses a MUSTER_MASTER_KEY shorter than 16 characters", () => {
    expect(() =>
      loadConfig({ ...completeEnvironment, MUSTER_MASTER_KEY: "too-short" }),
    ).toThrow(/MUSTER_MASTER_KEY/);
  });

  // Both database URLs are required: the owning role migrates, the serving
  // role serves, and neither substitutes for the other.
  test("requires MUSTER_DATABASE_URL", () => {
    expect(() => loadConfig(environmentWithout("MUSTER_DATABASE_URL"))).toThrow(
      /MUSTER_DATABASE_URL/,
    );
  });

  test("requires MUSTER_MIGRATION_DATABASE_URL", () => {
    expect(() =>
      loadConfig(environmentWithout("MUSTER_MIGRATION_DATABASE_URL")),
    ).toThrow(/MUSTER_MIGRATION_DATABASE_URL/);
  });

  test("refuses a database URL that is not a PostgreSQL URL", () => {
    expect(() =>
      loadConfig({
        ...completeEnvironment,
        MUSTER_DATABASE_URL: "mysql://muster@db:3306/muster",
      }),
    ).toThrow(/MUSTER_DATABASE_URL/);
  });

  test("accepts both PostgreSQL URL schemes", () => {
    const config = loadConfig({
      ...completeEnvironment,
      MUSTER_DATABASE_URL: "postgres://muster@db:5432/muster",
    });

    expect(config.databaseUrl).toBe("postgres://muster@db:5432/muster");
  });

  // Mail: SMTP when configured, otherwise the console transport, which is what
  // makes the compose stack and the tests observable without a mail server.
  test("falls back to the console mail transport when MUSTER_SMTP_URL is unset", () => {
    const config = loadConfig(completeEnvironment);

    expect(config.mail).toEqual({ kind: "console" });
  });

  test("treats an empty MUSTER_SMTP_URL as unset", () => {
    const config = loadConfig({
      ...completeEnvironment,
      MUSTER_SMTP_URL: "",
    });

    expect(config.mail).toEqual({ kind: "console" });
  });

  test("refuses a MUSTER_SMTP_URL that is not an SMTP URL", () => {
    expect(() =>
      loadConfig({
        ...completeEnvironment,
        MUSTER_SMTP_URL: "https://smtp.example.org",
      }),
    ).toThrow(/MUSTER_SMTP_URL/);
  });

  test("derives the default from-address from the public URL host", () => {
    const config = loadConfig(completeEnvironment);

    expect(config.mailFrom).toBe("muster@muster.example.org");
  });

  // Deny by default: an unparseable number is never rounded down to a guess.
  test("refuses an unparseable MUSTER_PORT", () => {
    for (const value of ["not-a-number", "0", "70000", "8080.5"]) {
      expect(() =>
        loadConfig({ ...completeEnvironment, MUSTER_PORT: value }),
      ).toThrow(/MUSTER_PORT/);
    }
  });

  // A variable present but blank is treated as absent, uniformly, so that a
  // deployment can neutralise an inherited variable with an empty value.
  test("treats a blank MUSTER_PORT as absent", () => {
    expect(loadConfig({ ...completeEnvironment, MUSTER_PORT: "  " }).port).toBe(
      8080,
    );
  });

  test("refuses an unparseable MUSTER_OUTBOUND_TIMEOUT_MS", () => {
    expect(() =>
      loadConfig({
        ...completeEnvironment,
        MUSTER_OUTBOUND_TIMEOUT_MS: "soon",
      }),
    ).toThrow(/MUSTER_OUTBOUND_TIMEOUT_MS/);
  });

  test("ignores blank entries in the outbound allowlist", () => {
    const config = loadConfig({
      ...completeEnvironment,
      MUSTER_OUTBOUND_ALLOWLIST: " stub-register:9000 , , localhost ,",
    });

    expect(config.outbound.allowedHosts).toEqual([
      "stub-register:9000",
      "localhost",
    ]);
  });

  // One start-up failure should name everything wrong, not just the first
  // problem, so an operator fixes the deployment in one pass.
  test("reports every problem in one failure", () => {
    let message = "";
    try {
      loadConfig({});
    } catch (cause) {
      message = cause instanceof Error ? cause.message : String(cause);
    }

    expect(message).toContain("MUSTER_PUBLIC_URL");
    expect(message).toContain("MUSTER_MASTER_KEY");
    expect(message).toContain("MUSTER_DATABASE_URL");
    expect(message).toContain("MUSTER_MIGRATION_DATABASE_URL");
  });

  test("never repeats a secret in a failure message", () => {
    let message = "";
    try {
      loadConfig({ ...completeEnvironment, MUSTER_PORT: "nope" });
    } catch (cause) {
      message = cause instanceof Error ? cause.message : String(cause);
    }

    expect(message).toContain("MUSTER_PORT");
    expect(message).not.toContain(completeEnvironment.MUSTER_MASTER_KEY);
    expect(message).not.toContain("secret");
  });
});

describe("publicUrlFor", () => {
  const config = loadConfig({
    ...completeEnvironment,
    MUSTER_PUBLIC_URL: "https://muster.example.org",
  });

  test("derives an absolute URL from the configured public URL", () => {
    expect(publicUrlFor(config, "/.well-known/jwks.json")).toBe(
      "https://muster.example.org/.well-known/jwks.json",
    );
  });

  test("accepts a path with no leading slash", () => {
    expect(publicUrlFor(config, "docs/registration-profile")).toBe(
      "https://muster.example.org/docs/registration-profile",
    );
  });

  test("returns the public URL itself for the root path", () => {
    expect(publicUrlFor(config, "/")).toBe("https://muster.example.org");
    expect(publicUrlFor(config, "")).toBe("https://muster.example.org");
  });

  test("keeps a path prefix in the configured public URL", () => {
    const prefixed = loadConfig({
      ...completeEnvironment,
      MUSTER_PUBLIC_URL: "https://example.org/muster",
    });

    expect(publicUrlFor(prefixed, "/api/events")).toBe(
      "https://example.org/muster/api/events",
    );
  });
});
