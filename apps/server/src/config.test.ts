/**
 * What the environment must contain before Muster will serve anything.
 *
 * Every case here is a deployment that would otherwise have started up in a state
 * it could not honour: a public URL that verification links are built from and is
 * absent, a master key too short to protect a signing key, an outbound allowlist
 * that was meant to be off. The loader refuses rather than defaulting, so these
 * tests are the record of what "refuses" means for each variable.
 *
 * Author: John Grimes
 */

import { describe, expect, it } from "bun:test";

import {
  ConfigError,
  loadConfig,
  resolveDatabaseUrl,
  resolveMigrationIdentities,
} from "./config.js";

import type { Environment } from "./config.js";

/** The smallest environment `loadConfig` accepts, for tests that vary one thing. */
const MINIMAL: Environment = {
  MUSTER_PUBLIC_URL: "https://muster.example",
  MUSTER_DATABASE_URL: "postgres://muster_app:pw@db:5432/muster",
  MUSTER_MASTER_KEY: "0123456789abcdef0123456789abcdef",
};

/** The minimal environment with one variable added or replaced. */
function withEnv(changes: Environment): Environment {
  return { ...MINIMAL, ...changes };
}

describe("loadConfig", () => {
  it("accepts a minimal environment", () => {
    const config = loadConfig(MINIMAL);

    expect(config.publicUrl).toBe("https://muster.example");
    expect(config.databaseUrl).toBe("postgres://muster_app:pw@db:5432/muster");
    expect(config.port).toBe(3000);
    expect(config.logLevel).toBe("info");
  });

  // Every public URL Muster emits derives from this one, so a deployment without it
  // would send verification links to nowhere.
  it("requires the public URL, naming it", () => {
    expect(() =>
      loadConfig({ ...MINIMAL, MUSTER_PUBLIC_URL: undefined }),
    ).toThrow(ConfigError);
    expect(() =>
      loadConfig({ ...MINIMAL, MUSTER_PUBLIC_URL: undefined }),
    ).toThrow(/MUSTER_PUBLIC_URL/);
  });

  it("treats a blank variable as absent", () => {
    expect(() => loadConfig(withEnv({ MUSTER_PUBLIC_URL: "   " }))).toThrow(
      /MUSTER_PUBLIC_URL/,
    );
  });

  // Public URLs are concatenated with paths, so a trailing slash would produce
  // `https://muster.example//api/events`.
  it("strips trailing slashes from the public URL", () => {
    expect(
      loadConfig(withEnv({ MUSTER_PUBLIC_URL: "https://muster.example///" }))
        .publicUrl,
    ).toBe("https://muster.example");
  });

  it("refuses a public URL that is not a URL", () => {
    expect(() => loadConfig(withEnv({ MUSTER_PUBLIC_URL: "muster" }))).toThrow(
      /MUSTER_PUBLIC_URL/,
    );
  });

  it("refuses a public URL that is neither http nor https", () => {
    expect(() =>
      loadConfig(withEnv({ MUSTER_PUBLIC_URL: "ftp://muster.example" })),
    ).toThrow(/http/);
  });

  it("requires a database URL", () => {
    expect(() =>
      loadConfig({ ...MINIMAL, MUSTER_DATABASE_URL: undefined }),
    ).toThrow(/MUSTER_DATABASE_URL/);
  });

  it("requires a master key", () => {
    expect(() =>
      loadConfig({ ...MINIMAL, MUSTER_MASTER_KEY: undefined }),
    ).toThrow(/MUSTER_MASTER_KEY/);
  });

  // A key shorter than the thing it protects is a key that does not protect it.
  it("refuses a master key shorter than 32 characters", () => {
    expect(() => loadConfig(withEnv({ MUSTER_MASTER_KEY: "short" }))).toThrow(
      /32/,
    );
  });

  it("reads the port", () => {
    expect(loadConfig(withEnv({ PORT: "8080" })).port).toBe(8080);
  });

  it("refuses a port that is not a number in range", () => {
    expect(() => loadConfig(withEnv({ PORT: "http" }))).toThrow(/PORT/);
    expect(() => loadConfig(withEnv({ PORT: "0" }))).toThrow(/PORT/);
    expect(() => loadConfig(withEnv({ PORT: "70000" }))).toThrow(/PORT/);
    expect(() => loadConfig(withEnv({ PORT: "3000.5" }))).toThrow(/PORT/);
  });

  it("reads the log level and refuses an unknown one", () => {
    expect(loadConfig(withEnv({ MUSTER_LOG_LEVEL: "debug" })).logLevel).toBe(
      "debug",
    );
    expect(() => loadConfig(withEnv({ MUSTER_LOG_LEVEL: "chatty" }))).toThrow(
      /MUSTER_LOG_LEVEL/,
    );
  });

  it("carries the web root when one is built, and not otherwise", () => {
    expect(loadConfig(MINIMAL).webRoot).toBeUndefined();
    expect(loadConfig(withEnv({ MUSTER_WEB_ROOT: "/app/web" })).webRoot).toBe(
      "/app/web",
    );
  });
});

describe("loadConfig mail settings", () => {
  // Absent SMTP is not a failure: it selects the console transport, which is what a
  // developer and the compose stack run with.
  it("leaves the SMTP URL undefined when unset", () => {
    expect(loadConfig(MINIMAL).smtpUrl).toBeUndefined();
  });

  it("reads the SMTP URL when set", () => {
    expect(
      loadConfig(withEnv({ MUSTER_SMTP_URL: "smtp://relay:25" })).smtpUrl,
    ).toBe("smtp://relay:25");
  });

  // Derived rather than required, so a development stack needs one variable fewer;
  // a relay that will not accept the derived address is told about it explicitly.
  it("derives the from-address from the public URL host", () => {
    expect(loadConfig(MINIMAL).mailFrom).toBe("muster@muster.example");
  });

  it("prefers an explicit from-address", () => {
    expect(
      loadConfig(withEnv({ MUSTER_MAIL_FROM: "Muster <no-reply@csiro.au>" }))
        .mailFrom,
    ).toBe("Muster <no-reply@csiro.au>");
  });
});

describe("loadConfig outbound allowlist", () => {
  // Deny by default. The guard is the only thing standing between a
  // participant-supplied URL and the network Muster runs in, and an allowlist that
  // defaulted to anything would be a guard that could be turned off by omission.
  it("is empty when unset", () => {
    expect(loadConfig(MINIMAL).outboundAllowedHosts).toEqual([]);
  });

  it("parses a comma-separated list, trimmed and case-folded", () => {
    expect(
      loadConfig(
        withEnv({
          MUSTER_OUTBOUND_ALLOWED_HOSTS: " Stub-Server:8080 , localhost ,,",
        }),
      ).outboundAllowedHosts,
    ).toEqual(["stub-server:8080", "localhost"]);
  });
});

describe("resolveDatabaseUrl", () => {
  // The migrate command needs a connection and nothing else. Demanding a public URL
  // and a master key to run one would be an operator told off by name for omitting
  // something the command never reads.
  it("reads the serving connection alone", () => {
    expect(
      resolveDatabaseUrl({ MUSTER_DATABASE_URL: "postgres://a:b@db/muster" }),
    ).toBe("postgres://a:b@db/muster");
  });

  it("refuses when absent", () => {
    expect(() => resolveDatabaseUrl({})).toThrow(/MUSTER_DATABASE_URL/);
  });
});

describe("resolveMigrationIdentities", () => {
  it("returns the owner connection and the serving role's name", () => {
    const identities = resolveMigrationIdentities({
      MUSTER_DATABASE_URL: "postgres://muster_app:pw@db/muster",
      MUSTER_DATABASE_OWNER_URL: "postgres://muster:pw@db/muster",
    });

    expect(identities.ownerUrl).toBe("postgres://muster:pw@db/muster");
    // A name, not a connection: migrate never uses the serving password.
    expect(identities.servingRole).toBe("muster_app");
  });

  it("requires the owning identity", () => {
    expect(() =>
      resolveMigrationIdentities({
        MUSTER_DATABASE_URL: "postgres://muster_app:pw@db/muster",
      }),
    ).toThrow(/MUSTER_DATABASE_OWNER_URL/);
  });

  // The quiet failure this prevents: one role for both means the server owns its
  // tables, so the grants in `packages/db/src/roles.ts` constrain nothing and a
  // server that should not be able to issue DDL can.
  it("refuses one role serving and owning", () => {
    expect(() =>
      resolveMigrationIdentities({
        MUSTER_DATABASE_URL: "postgres://muster:pw@db/muster",
        MUSTER_DATABASE_OWNER_URL: "postgres://muster:other@db/muster",
      }),
    ).toThrow(/non-owning/);
  });

  it("names the variable rather than quoting an unparseable connection", () => {
    // A connection URL contains a password and these messages reach a Job's logs.
    expect(() =>
      resolveMigrationIdentities({
        MUSTER_DATABASE_URL: "postgres://muster_app:pw@db/muster",
        MUSTER_DATABASE_OWNER_URL: "not a url",
      }),
    ).toThrow(/^MUSTER_DATABASE_OWNER_URL is not a valid connection URL$/);
  });
});
