/**
 * The server's entry point.
 *
 * A placeholder, and deliberately the smallest one that can be deployed: it answers
 * the liveness probe the container image and the compose stack are wired to, so the
 * image can be built, started and proved before there is anything to serve. The
 * routing, the error envelope and the configuration loader arrive with the
 * foundational phase, which replaces the body of this file with the real app factory.
 *
 * Author: John Grimes
 */

import { serve } from "@hono/node-server";
import { Hono } from "hono";

const app = new Hono();

// The only route the image's HEALTHCHECK and the compose stack's `--wait` need.
app.get("/healthz", (context) => context.json({ status: "ok" }));

const port = Number(process.env["PORT"] ?? "3000");

serve({ fetch: app.fetch, port }, (address) => {
  console.log(`Muster listening on port ${address.port}`);
});
