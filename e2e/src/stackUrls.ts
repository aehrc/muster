/**
 * Where the compose stack is, worked out from the environment.
 *
 * One module rather than a lookup per caller, because the Playwright configuration, the
 * global setup and the specs themselves all have to agree about it.
 *
 * **Two addresses for each stub, and the difference matters.** A stub is reached from the
 * host as `localhost:8443`, and from inside the compose network as `stub-server:8443`. The
 * suite needs both: an address it *types into Muster* is one Muster will fetch, so it has to
 * be the internal one - and it is also the name the stub's TLS certificate carries, which is
 * why an entry pointed at `localhost` would fail every verification check on the subject
 * alternative name. An address the suite fetches *itself* is the external one.
 *
 * **These variables have to be exported into the shell.** Bun loads a `.env` file into its
 * own process and does not pass the values to the processes it spawns, so a `MUSTER_PORT` in
 * `.env.local` reaches neither `docker compose` nor Playwright.
 *
 * Author: John Grimes
 */

/** The addresses the suite and the stack under test use. */
export interface StackUrls {
  /** Muster's origin, as a browser outside the stack reaches it. */
  muster: string;
  /** The stub registration server, from the host. */
  registrationStub: string;
  /** The stub registration server, as Muster reaches it and as its certificate names it. */
  registrationStubInternal: string;
  /** The stub data holder, from the host. */
  dataHolder: string;
  /** The stub data holder, as Muster reaches it and as its certificate names it. */
  dataHolderInternal: string;
}

/**
 * Reads a variable, treating an empty value as absent.
 *
 * An exported-but-cleared variable arrives as an empty string, and reading that as a port
 * would produce `http://localhost:/`, a URL that fails much later than the mistake.
 *
 * @param env - The environment to read.
 * @param name - The variable to read.
 * @returns The value, or `undefined` when it is unset or empty.
 */
function setting(
  env: Record<string, string | undefined>,
  name: string,
): string | undefined {
  const value = env[name];
  return value === undefined || value === "" ? undefined : value;
}

/**
 * Works out where the stack is from the environment.
 *
 * Each service takes its port from the same variable `deploy/docker-compose.yml` publishes
 * it on, defaulting to the same default. A base URL, where one is set, wins outright rather
 * than being combined with the port: a stack somewhere other than `localhost` is not
 * expressible as a port.
 *
 * @param env - The environment to read, normally `process.env`.
 * @returns The addresses of the stack's services.
 * @example
 * ```ts
 * resolveStackUrls({ MUSTER_PORT: "3100" }).muster; // "http://localhost:3100"
 * ```
 */
export function resolveStackUrls(
  env: Record<string, string | undefined>,
): StackUrls {
  const musterPort = setting(env, "MUSTER_PORT") ?? "3000";
  const registrationPort = setting(env, "STUB_SERVER_PORT") ?? "8443";
  const holderPort = setting(env, "STUB_HOLDER_PORT") ?? "8444";
  return {
    muster: setting(env, "MUSTER_BASE_URL") ?? `http://localhost:${musterPort}`,
    registrationStub: `https://localhost:${registrationPort}`,
    // The port is the container's own, not the published one: this address is resolved
    // inside the compose network, where the publishing does not apply.
    registrationStubInternal: "https://stub-server:8443",
    dataHolder: `https://localhost:${holderPort}`,
    dataHolderInternal: "https://stub-holder:8444",
  };
}
