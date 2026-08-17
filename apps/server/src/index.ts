/**
 * Muster server entry point.
 *
 * This is the setup-phase placeholder: it serves only a liveness endpoint so
 * that the container image and its smoke test are real from the first commit.
 * The foundational phase replaces the body of this file with the Hono
 * application factory (`app.ts`).
 *
 * @author John Grimes
 */

const port = Number(process.env["MUSTER_PORT"] ?? 8080);

const server = Bun.serve({
  port,
  /**
   * Handles an inbound HTTP request.
   *
   * @param request - the inbound request
   * @returns the liveness response, or 404 for any other path
   */
  fetch(request: Request): Response {
    const { pathname } = new URL(request.url);
    if (pathname === "/healthz") {
      return Response.json({ status: "ok" });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  },
});

console.log(`muster listening on ${server.url.toString()}`);
