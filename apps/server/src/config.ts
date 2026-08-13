/**
 * Resolution of runtime configuration from the environment.
 *
 * Nothing here defaults where a wrong guess would be invisible. A missing public
 * URL, a short master key or an unparseable port stops startup with a message
 * naming the variable, because each of those deployments would otherwise run while
 * failing to do something it was expected to do - emit links that resolve, protect
 * a signing key, listen where the probe looks.
 *
 * The commands resolve less than the server does, and deliberately so: a migration
 * uses a connection and nothing else, so `resolveDatabaseUrl` and
 * `resolveMigrationIdentities` exist separately rather than an operator being told
 * off by name for omitting a master key that the migration never reads.
 *
 * Author: John Grimes
 */

import { roleNameFromDatabaseUrl } from "@muster/db";

/** The subset of `process.env` this module reads. */
export type Environment = Readonly<Record<string, string | undefined>>;

/** A resolved, validated Muster configuration. */
export interface MusterConfig {
  readonly port: number;
  /** Public origin. Every public URL Muster emits derives from it. No trailing slash. */
  readonly publicUrl: string;
  /** The serving connection: the non-owning role, which cannot issue DDL. */
  readonly databaseUrl: string;
  /** Envelope key protecting signing private keys at rest. */
  readonly masterKey: string;
  readonly logLevel: "debug" | "info" | "warn" | "error";
  /**
   * Directory holding the built console, served for any path the API does not claim.
   *
   * Absent in development, where Vite serves it on its own port and proxies `/api`.
   */
  readonly webRoot: string | undefined;
  /**
   * Where mail is sent. Absent selects the console transport, which logs the
   * rendered message instead of sending it.
   */
  readonly smtpUrl: string | undefined;
  /** The `From` address on every message. */
  readonly mailFrom: string;
  /**
   * Hosts the outbound guard may reach on a private address or over plain HTTP.
   *
   * Empty by default, which is the whole point: the guard is the only thing between
   * a participant-supplied URL and the network Muster runs in, and a control that
   * could be turned off by omitting a variable would not be one. A development or
   * connectathon stack names its stubs here (`stub-server:8080`) and nothing else
   * is exempt.
   */
  readonly outboundAllowedHosts: readonly string[];
}

/** The two identities the `migrate` command needs. */
export interface MigrationIdentities {
  /**
   * The connection the migrations are applied with.
   *
   * The owning identity: migrations are DDL, and the grants are issued by the role
   * that owns the objects being granted.
   */
  readonly ownerUrl: string;
  /**
   * The role the grants are issued to, parsed out of the serving connection.
   *
   * A name, not a connection. `migrate` never uses the serving password, so the
   * migration job holds no credential it has no use for.
   */
  readonly servingRole: string;
}

/** Thrown when the environment cannot produce a usable configuration. */
export class ConfigError extends Error {
  /** @param message - An actionable description naming the offending variable. */
  public constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const LOG_LEVELS = new Set(["debug", "info", "warn", "error"]);

/** The shortest master key accepted: 32 characters, or 256 bits of hex. */
const MIN_MASTER_KEY_LENGTH = 32;

/** Reads a variable, treating a blank string as absent. */
function read(env: Environment, name: string): string | undefined {
  const value = env[name];
  return value === undefined || value.trim().length === 0 ? undefined : value;
}

/** Reads a variable that must be present. */
function requireValue(env: Environment, name: string, why: string): string {
  const value = read(env, name);
  if (value === undefined) {
    throw new ConfigError(`${name} is required; ${why}`);
  }
  return value;
}

/**
 * Strips trailing slashes and checks the scheme, so paths concatenate predictably.
 *
 * @throws {ConfigError} When the value is not an absolute http or https URL.
 */
function normalisePublicUrl(raw: string): string {
  const trimmed = raw.replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new ConfigError(`MUSTER_PUBLIC_URL is not a valid URL: "${raw}"`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ConfigError(
      `MUSTER_PUBLIC_URL must be http or https, got "${parsed.protocol}"`,
    );
  }
  return trimmed;
}

/**
 * Reads the listening port.
 *
 * @throws {ConfigError} When it is not a whole number in the port range.
 */
function readPort(env: Environment): number {
  const raw = read(env, "PORT") ?? "3000";
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new ConfigError(
      `PORT must be an integer between 1 and 65535, got "${raw}"`,
    );
  }
  return port;
}

/**
 * Splits a comma-separated list into trimmed, case-folded entries.
 *
 * Blank entries are dropped rather than kept as an empty host, because a trailing
 * comma is a typo and an empty allowlist entry that matched everything would be the
 * worst possible reading of one.
 */
function readHostList(env: Environment, name: string): readonly string[] {
  const raw = read(env, name);
  if (raw === undefined) {
    return [];
  }
  return raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

/**
 * The role a connection URL authenticates as, as a configuration failure.
 *
 * `roleNameFromDatabaseUrl` reports its refusals as plain errors; the entry point
 * distinguishes a configuration problem from a crash by type, so they are
 * translated here rather than at the exit.
 *
 * @throws {ConfigError} When the URL cannot be parsed or names no role. The message
 *   names the variable and quotes no part of the URL: it contains a password, and
 *   these messages reach a Job's logs.
 */
function roleOf(url: string, variable: string): string {
  try {
    return roleNameFromDatabaseUrl(url, variable);
  } catch (error) {
    throw new ConfigError(
      error instanceof Error ? error.message : `${variable} is unusable`,
    );
  }
}

/**
 * Resolves just the serving database connection.
 *
 * @param env - The environment to read.
 * @returns The connection URL.
 * @throws {ConfigError} When it is absent.
 * @example
 * ```ts
 * const url = resolveDatabaseUrl(process.env);
 * ```
 */
export function resolveDatabaseUrl(env: Environment): string {
  return requireValue(
    env,
    "MUSTER_DATABASE_URL",
    "it is the connection the server serves with",
  );
}

/**
 * Resolves the two identities the `migrate` command acts with.
 *
 * It connects as the owning identity, because migrations are DDL, and it grants the
 * serving role the access the server needs - so it has to know that role's name,
 * which it takes from the connection the server itself is configured with rather
 * than from a second variable that could disagree.
 *
 * @param env - The environment to read.
 * @returns The owner connection and the serving role's name.
 * @throws {ConfigError} When either connection is absent or unparseable, or the two
 *   name the same role. The last is the quiet one: a serving role that owns its
 *   tables is not constrained by the grants that were supposed to constrain it, and
 *   that deployment would run for months appearing correct.
 * @example
 * ```ts
 * const { ownerUrl, servingRole } = resolveMigrationIdentities(process.env);
 * await runMigrateCommand(ownerUrl, servingRole);
 * ```
 */
export function resolveMigrationIdentities(
  env: Environment,
): MigrationIdentities {
  // Resolved first, so a deployment missing the connection every command needs is
  // told about that rather than about the one only `migrate` needs.
  const servingUrl = resolveDatabaseUrl(env);
  const ownerUrl = requireValue(
    env,
    "MUSTER_DATABASE_OWNER_URL",
    "it names the identity that owns the schema, which MUSTER_DATABASE_URL must not",
  );

  const servingRole = roleOf(servingUrl, "MUSTER_DATABASE_URL");
  const ownerRole = roleOf(ownerUrl, "MUSTER_DATABASE_OWNER_URL");
  if (servingRole === ownerRole) {
    throw new ConfigError(
      `MUSTER_DATABASE_URL and MUSTER_DATABASE_OWNER_URL both name the role "${servingRole}". The serving role must be non-owning: a role that owns its tables can alter and drop them, so the grants that are meant to hold the server to reads and writes hold nothing.`,
    );
  }

  return { ownerUrl, servingRole };
}

/**
 * Resolves the server's configuration, refusing rather than half-configuring.
 *
 * @param env - The environment to read.
 * @returns The validated configuration.
 * @throws {ConfigError} With an actionable message naming the offending variable.
 * @example
 * ```ts
 * const config = loadConfig(process.env);
 * ```
 */
export function loadConfig(env: Environment): MusterConfig {
  const port = readPort(env);

  const publicUrl = normalisePublicUrl(
    requireValue(
      env,
      "MUSTER_PUBLIC_URL",
      "every public URL Muster emits derives from it",
    ),
  );

  const databaseUrl = resolveDatabaseUrl(env);

  const masterKey = requireValue(
    env,
    "MUSTER_MASTER_KEY",
    "it encrypts signing private keys at rest",
  );
  if (masterKey.length < MIN_MASTER_KEY_LENGTH) {
    throw new ConfigError(
      `MUSTER_MASTER_KEY must be at least ${String(MIN_MASTER_KEY_LENGTH)} characters`,
    );
  }

  const logLevel = read(env, "MUSTER_LOG_LEVEL") ?? "info";
  if (!LOG_LEVELS.has(logLevel)) {
    throw new ConfigError(
      `MUSTER_LOG_LEVEL must be one of debug, info, warn, error; got "${logLevel}"`,
    );
  }

  return {
    port,
    publicUrl,
    databaseUrl,
    masterKey,
    logLevel: logLevel as MusterConfig["logLevel"],
    webRoot: read(env, "MUSTER_WEB_ROOT"),
    smtpUrl: read(env, "MUSTER_SMTP_URL"),
    // Derived from the public URL so a development stack needs one variable fewer.
    // A relay that will not accept the derived address is told so explicitly.
    mailFrom:
      read(env, "MUSTER_MAIL_FROM") ?? `muster@${new URL(publicUrl).hostname}`,
    outboundAllowedHosts: readHostList(env, "MUSTER_OUTBOUND_ALLOWED_HOSTS"),
  };
}
