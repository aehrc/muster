import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { createMailTransport } from "./mail/transport.ts";

import type { MusterConfig } from "./config.ts";

/**
 * Muster server entry point.
 *
 * Configuration is read once, here, and a deployment that is misconfigured
 * fails to start rather than serving on a guess. What it starts with is then
 * stated in the log, because an operator should not have to infer from
 * behaviour whether mail is being sent or written to the log.
 *
 * @author John Grimes
 */

let config: MusterConfig;
try {
  config = loadConfig(process.env);
} catch (cause) {
  console.error(cause instanceof Error ? cause.message : String(cause));
  process.exit(1);
}

const mail = createMailTransport({
  from: config.mailFrom,
  delivery: config.mail,
});

const server = Bun.serve({
  port: config.port,
  fetch: createApp({ config, mail }).fetch,
});

console.log(
  `Muster listening on ${server.url.toString()}, public URL ${config.publicUrl}, ` +
    `mail ${config.mail.kind === "smtp" ? "over SMTP" : "written to this log"}`,
);
