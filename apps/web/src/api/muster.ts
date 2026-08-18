import { createApiClient } from "./client.ts";

/**
 * The one client every screen calls Muster through.
 *
 * No base URL: the console is served from the same origin as the API, so the
 * session cookie travels with every call and nothing hardcodes a host. In
 * development the Vite proxy forwards `/api` to the server, which keeps that
 * true there too.
 *
 * @author John Grimes
 */
export const muster = createApiClient();
