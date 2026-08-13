/**
 * The vendor-facing profiles, rendered and public (FR-028).
 *
 * Four decisions, and the first is the one worth arguing about.
 *
 * **The pages render the contract, and the contract ships inside the bundle.**
 * `contracts/registration-profile.md` is the document Signet's `002-trusted-dcr-tickets`
 * implements against, so the documentation Muster publishes has to *be* it rather than
 * describe it - prose that drifts from the contract is worse than no prose, because a vendor
 * implements what they read. The specification directory is not in the runtime image, so the
 * markdown is copied into `./docs/` and imported as text, which Bun's bundler inlines.
 * `jwks.test.ts` asserts the copies are byte-identical to the originals wherever the
 * originals are present, so drift fails the build rather than reaching a vendor.
 *
 * **The placeholders are resolved.** The contract writes `{MUSTER_PUBLIC_URL}` because it is
 * deployment-independent; a vendor reading this deployment's page needs this deployment's
 * address, and every public URL Muster emits derives from that variable.
 *
 * **The anchor's current key identifiers are shown beside the address.** FR-028 asks for key
 * locations, and the useful form of that is "here is the document, and here is what is in it
 * right now" - so somebody debugging a signature mismatch can compare a `kid` without
 * fetching anything.
 *
 * **The console owns `/docs`; the server owns `/docs/<profile>`.** `contracts/http-api.md`
 * gives `GET /docs/*` to the server and the wireframe's nav links to a console page, which
 * cannot both be all of it. The split is by what each is good at: the console's page is the
 * signposted index a person browses to, and these are standalone documents a vendor links
 * to, cites and reads with JavaScript disabled. An unknown `/docs/<something>` is a 404 here
 * rather than falling through to the console's shell, because a documentation address that
 * silently rendered an empty page would be read as the documentation being empty.
 *
 * Author: John Grimes
 */

import { marked } from "marked";

import registrationProfile from "./docs/registrationProfile.md" with { type: "text" };
import ticketProfile from "./docs/ticketProfile.md" with { type: "text" };
import { jsonError } from "./errors.js";
import { publishedJwks } from "../keys/keys.js";

import type { MusterEnvironment, ServerContext } from "../context.js";
import type { Hono } from "hono";

/** One rendered profile page. */
interface ProfilePage {
  /** The path segment under `/docs`. */
  readonly slug: string;
  /** The browser's title, and the page's own heading is the contract's. */
  readonly title: string;
  readonly markdown: string;
}

/** The two profiles this deployment publishes. */
const PAGES: readonly ProfilePage[] = [
  {
    slug: "registration-profile",
    title: "Trusted dynamic client registration profile",
    markdown: registrationProfile,
  },
  {
    slug: "ticket-profile",
    title: "Permission ticket profile",
    markdown: ticketProfile,
  },
];

/**
 * Escapes text for interpolation into HTML.
 *
 * Only the anchor's own configuration and its key identifiers pass through here, so this is
 * defence in depth rather than a control - but a page assembled by concatenation should not
 * have an unescaped hole in it whatever is currently flowing through.
 */
function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * The page's own stylesheet.
 *
 * Inline, because a documentation page a vendor reads must not depend on the console's build
 * being present, and because a stylesheet is one more request for something that is one
 * screen of CSS.
 */
const STYLE = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    line-height: 1.5;
    color: #222;
    background: #fff;
  }
  main { max-width: 52rem; margin: 0 auto; padding: 2rem 1.25rem 4rem; }
  h1 { font-size: 1.6rem; line-height: 1.25; }
  h2 { font-size: 1.2rem; margin-top: 2rem; }
  h3 { font-size: 1rem; margin-top: 1.5rem; }
  code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.875rem; }
  code { background: #f2f2f2; padding: 0.1rem 0.25rem; border-radius: 3px; }
  pre { background: #f6f6f6; border: 1px solid #ddd; border-radius: 4px; padding: 0.75rem; overflow-x: auto; }
  pre code { background: none; padding: 0; }
  table { border-collapse: collapse; width: 100%; display: block; overflow-x: auto; }
  th, td { border: 1px solid #ddd; padding: 0.4rem 0.6rem; text-align: left; vertical-align: top; }
  th { background: #f2f2f2; }
  .anchor { border: 1px solid #ccc; border-radius: 4px; padding: 0.75rem 1rem; margin-bottom: 2rem; background: #fafafa; }
  .anchor dt { font-weight: 600; margin-top: 0.5rem; }
  .anchor dd { margin: 0 0 0 0; }
  .quiet { color: #666; font-size: 0.875rem; }
  nav { margin-bottom: 1.5rem; font-size: 0.875rem; }
  @media (prefers-color-scheme: dark) {
    body { color: #e6e6e6; background: #111; }
    code { background: #222; }
    pre { background: #1a1a1a; border-color: #333; }
    th { background: #1d1d1d; }
    th, td { border-color: #333; }
    .anchor { background: #171717; border-color: #333; }
    .quiet { color: #999; }
  }
`;

/**
 * The panel naming this deployment's anchor identity.
 *
 * The issuer, the JWKS address and the identifiers currently in the document - which is what
 * somebody comparing a `kid` from a rejected statement actually needs.
 */
function anchorPanel(publicUrl: string, kids: readonly string[]): string {
  return [
    `<div class="anchor">`,
    `<dl>`,
    `<dt>Issuer identifier</dt><dd><code>${escapeHtml(publicUrl)}</code></dd>`,
    `<dt>JWKS</dt><dd><code>${escapeHtml(`${publicUrl}/.well-known/jwks.json`)}</code></dd>`,
    `<dt>Key identifiers currently published</dt><dd>${
      kids.length === 0
        ? '<span class="quiet">none yet</span>'
        : kids.map((kid) => `<code>${escapeHtml(kid)}</code>`).join(" ")
    }</dd>`,
    `</dl>`,
    `<p class="quiet">Superseded keys stay published until every statement or ticket signed with them has expired, so a rotation does not invalidate anything outstanding.</p>`,
    `</div>`,
  ].join("");
}

/** The whole document. */
function renderPage(
  page: ProfilePage,
  publicUrl: string,
  kids: readonly string[],
): string {
  // Resolved rather than rendered as written: the contract is deployment-independent and this
  // page is not.
  const source = page.markdown.replaceAll("{MUSTER_PUBLIC_URL}", publicUrl);
  const body = marked.parse(source, { async: false });
  return [
    "<!doctype html>",
    `<html lang="en">`,
    "<head>",
    `<meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<title>${escapeHtml(page.title)} - Muster</title>`,
    `<style>${STYLE}</style>`,
    "</head>",
    "<body>",
    "<main>",
    `<nav><a href="/docs">Muster documentation</a></nav>`,
    anchorPanel(publicUrl, kids),
    body,
    `<p class="quiet">This page is public: no account is needed to read it. It renders the contract this deployment implements, unchanged apart from resolving the issuer address above.</p>`,
    "</main>",
    "</body>",
    "</html>",
  ].join("\n");
}

/**
 * Registers the rendered profile pages.
 *
 * Attached to the application rather than to the `/api` router, because
 * `contracts/http-api.md` puts them at `/docs/*`.
 *
 * @param app - The application.
 * @param context - The server's dependencies.
 * @example
 * ```ts
 * registerDocsRoutes(app, context);
 * ```
 */
export function registerDocsRoutes(
  app: Hono<MusterEnvironment>,
  context: ServerContext,
): void {
  for (const page of PAGES) {
    app.get(`/docs/${page.slug}`, async (c) => {
      const document = await publishedJwks(context.db, context.clock());
      const kids = document.keys
        .map((key) => key.kid)
        .filter((kid): kid is string => kid !== undefined);
      return c.html(renderPage(page, context.config.publicUrl, kids));
    });
  }

  // Registered after the pages, so a named profile wins. An unknown one is refused here
  // rather than falling through to the console's shell: see the module header.
  app.get("/docs/:page", (c) =>
    jsonError(
      c,
      404,
      "not_found",
      `Muster publishes ${PAGES.map((page) => `/docs/${page.slug}`).join(" and ")}`,
    ),
  );
}
