import { z } from "zod";

/**
 * Runtime configuration, read from the environment exactly once at start-up.
 *
 * Configuration is deny by default: a required variable that is absent, blank
 * or unparseable fails start-up rather than letting the server run on a guess.
 * A variable that is present but blank counts as absent, uniformly, so a
 * deployment can neutralise an inherited variable with an empty value.
 *
 * Every public URL Muster advertises - the issuer identifier in signed
 * artefacts, the JWKS address, links in email - derives from
 * `MUSTER_PUBLIC_URL` through {@link publicUrlFor}. Nothing hardcodes a host.
 *
 * @author John Grimes
 */

/** Where mail goes. */
export type MailDelivery =
  /** to an SMTP server */
  | { readonly kind: "smtp"; readonly url: string }
  /** to the log, for development and tests */
  | { readonly kind: "console" };

/** Settings for the SSRF-guarded outbound fetch. */
export type OutboundConfig = {
  /** how long a single outbound request may take, in milliseconds */
  readonly timeoutMs: number;
  /**
   * hosts exempted from the address guard, as `host` or `host:port`. Empty in
   * a deployment; the compose stack and the test suites use it to reach stubs
   * on addresses the guard would otherwise refuse.
   */
  readonly allowedHosts: readonly string[];
};

/** Everything the server needs from its environment. */
export type MusterConfig = {
  /** the externally reachable base URL, without a trailing slash */
  readonly publicUrl: string;
  /** the port to listen on */
  readonly port: number;
  /** the key private signing keys are encrypted under at rest */
  readonly masterKey: string;
  /** connection URL for the non-owning serving role */
  readonly databaseUrl: string;
  /** connection URL for the owning role, which applies migrations */
  readonly migrationDatabaseUrl: string;
  /**
   * directory holding the `.sql` migrations, applied at start-up. The bundled
   * server is one file beside a copied directory, so this is relative to the
   * working directory rather than to the module.
   */
  readonly migrationsDirectory: string;
  /**
   * directory holding the built console, served for every path the API does not
   * own. Relative to the working directory, like the migrations: the image holds
   * it beside the bundle. A directory that is not there means the API is served
   * alone, which is a legitimate deployment and is stated at start-up.
   */
  readonly webDirectory: string;
  /** the serving role bootstrapped by the owning role */
  readonly serverDatabaseRole: string;
  /** password to set on the serving role, when the deployment sets one */
  readonly serverDatabasePassword: string | undefined;
  /** the From address on outbound mail */
  readonly mailFrom: string;
  /** how mail is delivered */
  readonly mail: MailDelivery;
  /** outbound request settings */
  readonly outbound: OutboundConfig;
  /**
   * the identifier system a persona's IHI is asserted under. Configuration
   * rather than a constant, so a deployment pointed at another programme's
   * source server reads that programme's identifier (FR-031).
   */
  readonly ihiSystem: string;
};

/**
 * The identifier system personas' IHIs are asserted under when unconfigured.
 *
 * The Australian IHI namespace, which is what the Sparked programme's test
 * patients carry.
 */
const defaultIhiSystem = "http://ns.electronichealth.net.au/id/hi/ihi/1.0";

/** Milliseconds allowed for one outbound request when unconfigured. */
const defaultOutboundTimeoutMs = 10_000;

/** Port listened on when unconfigured. */
const defaultPort = 8080;

/** Serving database role when unconfigured. */
const defaultServerDatabaseRole = "muster_server";

/** Migration directory when unconfigured, which is where the image holds it. */
const defaultMigrationsDirectory = "migrations";

/** Console directory when unconfigured, which is where the image holds it. */
const defaultWebDirectory = "web";

/** Shortest master key accepted; anything shorter is not a secret. */
const minimumMasterKeyLength = 16;

/**
 * Builds a check that a value is an absolute URL with one of the given schemes.
 *
 * @param schemes - acceptable URL protocols, including the colon
 * @returns a predicate suitable for a Zod refinement
 */
const urlWithScheme =
  (schemes: readonly string[]) =>
  (value: string): boolean => {
    try {
      return schemes.includes(new URL(value).protocol);
    } catch {
      // A relative reference or a malformed URL: not acceptable anywhere.
      return false;
    }
  };

/** A whole number given as text, with its own message so no input is echoed. */
const wholeNumber = z
  .string()
  .regex(/^\d+$/, "must be a whole number")
  .transform(Number);

/** The environment variables Muster reads. */
const environmentSchema = z.object({
  MUSTER_PUBLIC_URL: z
    .string()
    .refine(
      urlWithScheme(["http:", "https:"]),
      "must be an absolute http or https URL",
    ),
  MUSTER_MASTER_KEY: z
    .string()
    .min(
      minimumMasterKeyLength,
      `must be at least ${String(minimumMasterKeyLength)} characters`,
    ),
  MUSTER_DATABASE_URL: z
    .string()
    .refine(
      urlWithScheme(["postgresql:", "postgres:"]),
      "must be a postgresql:// or postgres:// URL",
    ),
  MUSTER_MIGRATION_DATABASE_URL: z
    .string()
    .refine(
      urlWithScheme(["postgresql:", "postgres:"]),
      "must be a postgresql:// or postgres:// URL",
    ),
  MUSTER_PORT: wholeNumber
    .refine((port) => port >= 1 && port <= 65_535, "must be a port number")
    .optional(),
  MUSTER_SMTP_URL: z
    .string()
    .refine(
      urlWithScheme(["smtp:", "smtps:"]),
      "must be an smtp:// or smtps:// URL",
    )
    .optional(),
  MUSTER_MAIL_FROM: z.string().optional(),
  MUSTER_MIGRATIONS_DIRECTORY: z.string().optional(),
  MUSTER_WEB_DIRECTORY: z.string().optional(),
  MUSTER_SERVER_DATABASE_ROLE: z.string().optional(),
  MUSTER_SERVER_DATABASE_PASSWORD: z.string().optional(),
  MUSTER_OUTBOUND_TIMEOUT_MS: wholeNumber
    .refine((milliseconds) => milliseconds > 0, "must be greater than zero")
    .optional(),
  MUSTER_OUTBOUND_ALLOWLIST: z.string().optional(),
  MUSTER_IHI_SYSTEM: z
    .string()
    .refine(
      (value) => URL.canParse(value),
      "must be an absolute URI identifying the IHI identifier system",
    )
    .optional(),
});

/**
 * Drops absent and blank variables and trims the rest.
 *
 * @param environment - the raw environment
 * @returns the environment with blank values removed
 */
const compactEnvironment = (
  environment: Readonly<Record<string, string | undefined>>,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(environment)
      .map(([key, value]) => [key, value?.trim() ?? ""] as const)
      .filter(([, value]) => value.length > 0),
  );

/**
 * Renders parse failures as one message naming each offending variable.
 *
 * Only the variable name and Muster's own wording appear; a value is never
 * echoed, because several of these variables carry credentials.
 *
 * @param issues - the issues Zod reported
 * @returns the message for the start-up failure
 */
const describeIssues = (issues: readonly z.core.$ZodIssue[]): string => {
  const lines = issues.map((issue) => {
    const name = issue.path.join(".");
    const reason =
      issue.code === "invalid_type" ? "is required" : issue.message;
    return `  - ${name}: ${reason}`;
  });
  return `Configuration is invalid:\n${lines.join("\n")}`;
};

/**
 * Reads configuration from an environment.
 *
 * @param environment - the environment to read, normally `process.env`
 * @returns the parsed configuration
 * @throws {Error} when any variable is missing or unparseable, naming every
 *   problem found so a deployment is fixed in one pass
 * @example
 * ```ts
 * const config = loadConfig(process.env);
 * console.log(config.publicUrl); // https://muster.example.org
 * ```
 */
export const loadConfig = (
  environment: Readonly<Record<string, string | undefined>>,
): MusterConfig => {
  const parsed = environmentSchema.safeParse(compactEnvironment(environment));
  if (!parsed.success) {
    throw new Error(describeIssues(parsed.error.issues));
  }
  const values = parsed.data;

  // Trailing slashes are stripped once, here, so that every derived URL is
  // formed by appending and no caller has to think about it.
  const publicUrl = values.MUSTER_PUBLIC_URL.replace(/\/+$/, "");
  const smtpUrl = values.MUSTER_SMTP_URL;
  const allowedHosts = (values.MUSTER_OUTBOUND_ALLOWLIST ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  return {
    publicUrl,
    port: values.MUSTER_PORT ?? defaultPort,
    masterKey: values.MUSTER_MASTER_KEY,
    databaseUrl: values.MUSTER_DATABASE_URL,
    migrationDatabaseUrl: values.MUSTER_MIGRATION_DATABASE_URL,
    migrationsDirectory:
      values.MUSTER_MIGRATIONS_DIRECTORY ?? defaultMigrationsDirectory,
    webDirectory: values.MUSTER_WEB_DIRECTORY ?? defaultWebDirectory,
    serverDatabaseRole:
      values.MUSTER_SERVER_DATABASE_ROLE ?? defaultServerDatabaseRole,
    serverDatabasePassword: values.MUSTER_SERVER_DATABASE_PASSWORD,
    mailFrom:
      values.MUSTER_MAIL_FROM ?? `muster@${new URL(publicUrl).hostname}`,
    mail:
      smtpUrl === undefined
        ? { kind: "console" }
        : { kind: "smtp", url: smtpUrl },
    outbound: {
      timeoutMs: values.MUSTER_OUTBOUND_TIMEOUT_MS ?? defaultOutboundTimeoutMs,
      allowedHosts,
    },
    ihiSystem: values.MUSTER_IHI_SYSTEM ?? defaultIhiSystem,
  };
};

/**
 * Derives a public URL from the configured base.
 *
 * @param config - the configuration holding the public base URL
 * @param path - the path to append, with or without a leading slash
 * @returns the absolute URL
 * @example
 * ```ts
 * publicUrlFor(config, "/.well-known/jwks.json");
 * // https://muster.example.org/.well-known/jwks.json
 * ```
 */
export const publicUrlFor = (config: MusterConfig, path: string): string => {
  const suffix = path.replace(/^\/+/, "");
  return suffix.length === 0
    ? config.publicUrl
    : `${config.publicUrl}/${suffix}`;
};
