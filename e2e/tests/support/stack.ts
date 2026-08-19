import { execSync } from "node:child_process";
import { dirname, resolve } from "node:path";

/**
 * Where the stack is, and what is in it.
 *
 * The suite runs against `deploy/docker-compose.yml`, so the defaults here are
 * the compose network's names. Every one of them is overridable, because the same
 * arrangement can be run as bare processes - which is how it is driven on a
 * machine with no container runtime - and then the stubs are on localhost instead.
 *
 * Two addresses exist for the data holder, and the distinction matters. Muster
 * reaches it over the compose network as `data-holder-stub:9091`, which is what
 * goes into an entry; the suite reaches it through its published port, which is
 * what a token exchange is posted to.
 *
 * @author John Grimes
 */

/**
 * Reads a variable, falling back to the compose stack's value.
 *
 * @param name - the variable's name
 * @param fallback - the compose stack's value
 * @returns the address to use
 */
const address = (name: string, fallback: string): string => {
  const value = process.env[name];
  return value === undefined || value.trim() === "" ? fallback : value.trim();
};

/** The repository root, for the commands that are run from it. */
const repositoryRoot = resolve(
  dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
  "..",
);

/** Where Muster is. */
export const musterUrl = address(
  "MUSTER_E2E_BASE_URL",
  "http://localhost:8080",
);

/** The registration stub, as Muster reaches it. */
export const registerStubUrl = address(
  "MUSTER_E2E_REGISTER_STUB",
  "http://register-stub:9090",
);

/** The data holder, as Muster reaches it. */
export const dataHolderUrl = address(
  "MUSTER_E2E_DATA_HOLDER",
  "http://data-holder-stub:9091",
);

/** The data holder, as this suite reaches it. */
export const dataHolderPublicUrl = address(
  "MUSTER_E2E_DATA_HOLDER_PUBLIC",
  "http://localhost:9091",
);

/** The persona source, as Muster reaches it: what the seed put on the event. */
export const personaSourceUrl = address(
  "MUSTER_E2E_PERSONA_SOURCE",
  "http://persona-source-stub:9092/fhir",
);

/** The event the seed opens, which every scenario runs inside. */
export const eventSlug = address("MUSTER_E2E_EVENT_SLUG", "sparked-2026-09");

/** The seeded track admin. */
export const admin = {
  email: address("MUSTER_SEED_ADMIN_EMAIL", "admin@example.org"),
  password: address("MUSTER_SEED_ADMIN_PASSWORD", "muster-admin-password"),
};

/** The password every account this suite creates is given. */
export const password = "correct horse battery staple";

/** The persona the quickstart curates, as the fixture holds her. */
export const charlotte = {
  patientId: "charlotte-morris",
  ihi: "8003608500314687",
  name: "Charlotte Morris",
};

/** The fixture's patient with no IHI, whom curation must refuse. */
export const jordan = { patientId: "jordan-vale", name: "Jordan Vale" };

/** The identifier system the stack asserts an IHI under. */
export const ihiSystem = "http://ns.electronichealth.net.au/id/hi/ihi/1.0";

/**
 * The command that prints Muster's log.
 *
 * Mail goes to the log in the stack, because no SMTP server is configured, so
 * this is how a verification link is read - the same way a person running the
 * stack reads it. Overridable, because "print the log" is a different command
 * for a container and for a process writing to a file.
 */
const logCommand = address(
  "MUSTER_E2E_LOG_COMMAND",
  "docker compose -f deploy/docker-compose.yml logs muster",
);

/**
 * Reads Muster's log.
 *
 * @returns everything the server has logged
 * @throws {Error} when the command fails
 */
export const musterLog = (): string =>
  execSync(logCommand, {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });

/**
 * Finds the newest verification token addressed to one account.
 *
 * The console mail transport writes each message to the log with its recipient,
 * so the link is found by looking for the address and taking the token from the
 * message that carries it.
 *
 * @param email - the address the message was sent to
 * @returns the token from the newest verification link for that address
 * @throws {Error} when no message carries one
 * @example
 * ```ts
 * await page.goto(`/verify?token=${verificationToken(email)}`);
 * ```
 */
export const verificationToken = (email: string): string => {
  const messages = musterLog().split("To: ");
  for (const message of [...messages].reverse()) {
    if (!message.startsWith(email)) {
      continue;
    }
    const found = /\/verify\?token=([\w-]+)/.exec(message);
    if (found?.[1] !== undefined) {
      return found[1];
    }
  }
  throw new Error(`No verification link was logged for ${email}`);
};

/** How many participant addresses have been handed out. */
let allocated = 0;

/**
 * An address for one participant in this run.
 *
 * FR-035 limits the credential routes by client address, and a whole spec file
 * signing several accounts in would exhaust one address's allowance in a way a
 * real participant never would. Each file presents its own documentation-range
 * address, which is what separate participants at a venue look like to a server
 * behind a proxy.
 *
 * Handed out in sequence rather than at random, because two files that happened
 * to draw the same address would share one allowance and the suite would fail
 * for a reason that had nothing to do with Muster.
 *
 * @returns a documentation-range address
 * @example
 * ```ts
 * test.use({ extraHTTPHeaders: { "x-forwarded-for": participantAddress() } });
 * ```
 */
export const participantAddress = (): string => {
  allocated += 1;
  return `198.51.100.${String(((allocated - 1) % 254) + 1)}`;
};

/**
 * Builds an address nothing else in this run will use.
 *
 * @param prefix - what the account or record is for
 * @returns a unique name
 * @example
 * ```ts
 * const email = `${unique("appowner")}@example.org`;
 * ```
 */
export const unique = (prefix: string): string =>
  `${prefix}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
