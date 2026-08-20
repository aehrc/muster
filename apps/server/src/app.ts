/*
 * Copyright © 2026 Commonwealth Scientific and Industrial Research Organisation
 * (CSIRO) ABN 41 687 119 230. Licensed under the Apache License, Version 2.0.
 */

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

import { createDirectoryRoutes } from "./admin/directory.routes.ts";
import { createMembersRoutes } from "./admin/members.routes.ts";
import { createPersonaRoutes } from "./admin/personas.routes.ts";
import { createAuthRoutes } from "./auth/routes.ts";
import { createBrandsRoutes } from "./http/brands.ts";
import { createDocsRoutes } from "./http/docs.ts";
import { createJwksRoutes } from "./http/jwks.ts";
import { createPublicRoutes } from "./http/publicApi.ts";
import { createWebAppRoutes } from "./http/webApp.ts";
import { createDcrRoutes } from "./pairing/dcr.routes.ts";
import { createHarnessRoutes } from "./pairing/harness.routes.ts";
import { createPairingRoutes } from "./pairing/routes.ts";
import { createTicketRoutes } from "./pairing/tickets.routes.ts";

import type { MusterConfig } from "./config.ts";
import type { MailTransport } from "./mail/transport.ts";
import type { OutboundOverrides } from "./outbound/outboundFetch.ts";
import type { ErrorEnvelope } from "@muster/contracts";
import type { SQL } from "bun";

/**
 * The application factory.
 *
 * Everything the routes need arrives as a dependency and is put on the request
 * context, so a suite builds the application with a console mail transport and
 * no network while the entry point builds it with the configured ones.
 *
 * Every error on the wire is `{ error, detail? }` - the envelope in
 * `contracts/http-api.md` - including the ones Hono would otherwise answer as
 * plain text. An unexpected failure is reported without its message: exception
 * text carries connection strings, tokens and queries, and no credential is
 * ever written to a response.
 *
 * @author John Grimes
 */

/** What the application needs in order to serve. */
export type AppDependencies = {
  /** the runtime configuration */
  readonly config: MusterConfig;
  /** the mail transport notifications go through */
  readonly mail: MailTransport;
  /** the connection held by the serving database role */
  readonly sql: SQL;
  /**
   * overrides for the guarded outbound fetch; empty in a deployment, and the
   * only way a suite drives a route that reaches a participant's server without
   * a network.
   */
  readonly outbound?: OutboundOverrides;
};

/** The Hono environment every Muster route is written against. */
export type AppEnvironment = {
  /** values every handler can read from its context */
  Variables: {
    /** the runtime configuration */
    config: MusterConfig;
    /** the mail transport notifications go through */
    mail: MailTransport;
    /** the connection held by the serving database role */
    sql: SQL;
    /** overrides for the guarded outbound fetch; empty in a deployment */
    outbound: OutboundOverrides;
  };
};

/**
 * The error code answered for each refusal status. A status without an entry
 * answers `internal_error`, which is the safe direction to fail in.
 */
const errorCodeByStatus: Record<number, string> = {
  400: "invalid_request",
  401: "unauthorised",
  403: "forbidden",
  404: "not_found",
  405: "method_not_allowed",
  409: "conflict",
  422: "unprocessable",
  429: "rate_limited",
};

/**
 * Builds the application.
 *
 * @param dependencies - the configuration and transports the routes use
 * @returns the application, ready to serve or to be driven by a test
 * @example
 * ```ts
 * const app = createApp({ config, mail });
 * Bun.serve({ port: config.port, fetch: app.fetch });
 * ```
 */
export const createApp = (
  dependencies: AppDependencies,
): Hono<AppEnvironment> => {
  const app = new Hono<AppEnvironment>();

  // One place holds the dependencies, so no route has to be handed them and no
  // module reaches for a global.
  app.use("*", async (context, next) => {
    context.set("config", dependencies.config);
    context.set("mail", dependencies.mail);
    context.set("sql", dependencies.sql);
    context.set("outbound", dependencies.outbound ?? {});
    await next();
  });

  // Liveness only: it says the process is answering, not that it is healthy in
  // any deeper sense. The container smoke test and the compose healthcheck both
  // poll it, so it must need no configuration and touch nothing.
  app.get("/healthz", (context) => context.json({ status: "ok" }));

  // Mounted in order of how open they are: the credential routes, then the
  // routes a member drives, then the public read API.
  app.route("/api/auth", createAuthRoutes());
  app.route("/api", createMembersRoutes());
  app.route("/api", createDirectoryRoutes());
  app.route("/api", createPersonaRoutes());
  app.route("/api", createPairingRoutes());
  app.route("/api", createDcrRoutes());
  app.route("/api", createHarnessRoutes());
  app.route("/api", createTicketRoutes());
  app.route("/api", createPublicRoutes());
  app.route("/api", createBrandsRoutes());

  // Not under /api: the key set is published where the profile says it is, and
  // the documentation is published where an implementer would look for it.
  app.route("/", createJwksRoutes());
  app.route("/", createDocsRoutes());

  // Last, because it answers whatever is left: the built console, so that one
  // container serves the API and the screens.
  app.route("/", createWebAppRoutes());

  app.notFound((context) =>
    context.json(
      {
        error: "not_found",
        detail: `No route matches ${context.req.method} ${new URL(context.req.url).pathname}`,
      } satisfies ErrorEnvelope,
      404,
    ),
  );

  app.onError((cause, context) => {
    if (cause instanceof HTTPException) {
      const envelope: ErrorEnvelope = {
        error: errorCodeByStatus[cause.status] ?? "internal_error",
        ...(cause.message === "" ? {} : { detail: cause.message }),
      };
      return context.json(envelope, cause.status);
    }

    // Logged for the operator, never returned: the message is not ours to
    // publish, and the path is enough to find it in the log.
    console.error(
      `Unhandled failure serving ${context.req.method} ${new URL(context.req.url).pathname}`,
      cause,
    );
    return context.json(
      { error: "internal_error" } satisfies ErrorEnvelope,
      500,
    );
  });

  return app;
};
