/**
 * What every route is given.
 *
 * Passed in rather than reached for, so an integration test can substitute a throwaway
 * database, a recording mail transport and a fixed clock, and drive the whole
 * application through `app.request()` without opening a socket.
 *
 * Author: John Grimes
 */

import type { MusterConfig } from "./config.js";
import type { MailTransport } from "./mail/transport.js";
import type { Database } from "@muster/db";

/** The server's dependencies. */
export interface ServerContext {
  readonly config: MusterConfig;
  readonly db: Database;
  readonly mail: MailTransport;
  /**
   * The current time.
   *
   * Injected because the domain rules that decide expiry and validity are pure and
   * take a time; the server is where that time comes from.
   */
  readonly clock: () => Date;
}
