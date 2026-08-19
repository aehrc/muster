import { findProfileDocument, profileDocuments } from "@muster/core";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

import { jwksPath } from "./jwks.ts";
import { publicUrlFor } from "../config.ts";

import type { AppEnvironment } from "../app.ts";
import type { DocBlock, ProfileDocument } from "@muster/core";

/**
 * The published profile documentation (FR-028).
 *
 * Server-rendered HTML, not a console screen. A vendor implementing the
 * registration profile reads this from a terminal, quotes it in an email, and
 * hands the URL to a colleague; a page that needs JavaScript to say what a claim
 * is called would fail all three. It is anonymous for the same reason: an
 * implementer has no account here.
 *
 * The documents themselves are pure data in `@muster/core`, a function of the
 * deployment's issuer identifier, so this module is only a renderer - and the
 * console renders the same documents its own way without either copy drifting.
 *
 * Every value that reaches the page goes through {@link escapeHtml}. The documents
 * are Muster's own text rather than a participant's, so this is belt and braces,
 * but a renderer that escapes only what it currently distrusts is one edit away
 * from being wrong.
 *
 * @author John Grimes
 */

/** Where the documentation is published. */
export const docsPath = "/docs";

/**
 * Escapes text for inclusion in HTML.
 *
 * @param text - the text to escape
 * @returns the text with the five markup characters replaced by entities
 */
const escapeHtml = (text: string): string =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

/**
 * Renders one block of a document.
 *
 * @param block - the block to render
 * @returns its HTML
 */
const renderBlock = (block: DocBlock): string => {
  switch (block.kind) {
    case "paragraph": {
      return `<p>${escapeHtml(block.text)}</p>`;
    }
    case "list": {
      return `<ul>${block.items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
    }
    case "steps": {
      return `<ol>${block.items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ol>`;
    }
    case "table": {
      const head = block.columns
        .map((column) => `<th scope="col">${escapeHtml(column)}</th>`)
        .join("");
      const body = block.rows
        .map(
          (row) =>
            `<tr>${row.map((cell) => `<td><code>${escapeHtml(cell)}</code></td>`).join("")}</tr>`,
        )
        .join("");
      return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
    }
    case "code": {
      return `<figure><figcaption>${escapeHtml(block.caption)}</figcaption><pre><code>${escapeHtml(block.text)}</code></pre></figure>`;
    }
  }
};

/**
 * The stylesheet every published page carries.
 *
 * Inline, because a document that fetches a stylesheet is a document that renders
 * wrongly when the stylesheet is unreachable, and this one has to be readable
 * from anywhere. It follows the system's colour preference, as every Muster
 * surface does.
 */
const stylesheet = `
:root { color-scheme: light dark; --ink: #1c1e21; --paper: #fdfdfc; --muted: #5b6169; --line: #d9dce0; --panel: #f4f5f6; }
@media (prefers-color-scheme: dark) {
  :root { --ink: #e6e7e8; --paper: #16181a; --muted: #a0a6ad; --line: #33383d; --panel: #1f2225; }
}
* { box-sizing: border-box; }
body { margin: 0; padding: 2rem 1rem 4rem; background: var(--paper); color: var(--ink);
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; line-height: 1.55; }
main { margin: 0 auto; max-width: 48rem; }
h1 { font-size: 1.8rem; margin: 0 0 0.25rem; }
h2 { font-size: 1.2rem; margin: 2.5rem 0 0.75rem; padding-top: 0.75rem; border-top: 1px solid var(--line); }
p.summary { color: var(--muted); margin: 0 0 1.5rem; }
a { color: inherit; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.9em; }
table { width: 100%; border-collapse: collapse; margin: 0 0 1rem; display: block; overflow-x: auto; }
th, td { text-align: left; vertical-align: top; padding: 0.4rem 0.6rem; border-bottom: 1px solid var(--line); }
th { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); }
td:first-child code { font-weight: 600; }
figure { margin: 0 0 1rem; }
figcaption { font-size: 0.8rem; color: var(--muted); margin-bottom: 0.35rem; }
pre { margin: 0; padding: 0.9rem 1rem; overflow-x: auto; background: var(--panel);
  border: 1px solid var(--line); border-radius: 0.4rem; }
ul, ol { padding-left: 1.4rem; }
li { margin-bottom: 0.4rem; }
nav { font-size: 0.9rem; margin-bottom: 1.5rem; }
header { margin: 0 auto 2rem; max-width: 48rem; font-weight: 600; }
`.trim();

/**
 * Wraps rendered content in a page.
 *
 * @param title - the page's title
 * @param body - the rendered body
 * @returns the whole document
 */
const renderPage = (title: string, body: string): string =>
  [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)} - Muster</title>`,
    `<style>${stylesheet}</style>`,
    "</head><body>",
    // The same process serves the console, so a reader who arrives here from a
    // search engine or a vendor's email has a way into the rest of Muster.
    '<header><a href="/">Muster</a></header><main>',
    body,
    "</main></body></html>",
  ].join("");

/**
 * Renders one profile.
 *
 * @param document - the profile to render
 * @param jwksUrl - the deployment's key set address, linked from every profile
 * @returns the page
 */
const renderProfile = (document: ProfileDocument, jwksUrl: string): string =>
  renderPage(
    document.title,
    [
      `<nav><a href="${escapeHtml(docsPath)}">All profiles</a></nav>`,
      `<h1>${escapeHtml(document.title)}</h1>`,
      `<p class="summary">${escapeHtml(document.summary)}</p>`,
      ...document.sections.map((section) =>
        [
          `<h2>${escapeHtml(section.heading)}</h2>`,
          ...section.blocks.map(renderBlock),
        ].join(""),
      ),
      `<h2>Keys</h2><p>The signing keys these profiles refer to are published at <a href="${escapeHtml(jwksUrl)}"><code>${escapeHtml(jwksUrl)}</code></a>.</p>`,
    ].join(""),
  );

/**
 * Renders the index of published profiles.
 *
 * @param documents - the profiles published
 * @param jwksUrl - the deployment's key set address
 * @returns the page
 */
const renderIndex = (
  documents: readonly ProfileDocument[],
  jwksUrl: string,
): string =>
  renderPage(
    "Profiles",
    [
      "<h1>Muster profiles</h1>",
      '<p class="summary">What a participating server implements in order to accept a client Muster vouches for, or a permission ticket Muster minted.</p>',
      "<ul>",
      ...documents.map(
        (document) =>
          `<li><a href="${escapeHtml(`${docsPath}/${document.slug}`)}"><strong>${escapeHtml(document.title)}</strong></a><br>${escapeHtml(document.summary)}</li>`,
      ),
      "</ul>",
      `<h2>Keys</h2><p>Signing keys are published at <a href="${escapeHtml(jwksUrl)}"><code>${escapeHtml(jwksUrl)}</code></a>.</p>`,
    ].join(""),
  );

/**
 * Builds the documentation routes.
 *
 * @returns the routes, to be mounted at the root
 * @example
 * ```ts
 * app.route("/", createDocsRoutes());
 * ```
 */
export const createDocsRoutes = (): Hono<AppEnvironment> => {
  const routes = new Hono<AppEnvironment>();

  routes.get(docsPath, (context) => {
    const config = context.get("config");
    return context.html(
      renderIndex(
        profileDocuments(config.publicUrl),
        publicUrlFor(config, jwksPath),
      ),
    );
  });

  routes.get(`${docsPath}/:slug`, (context) => {
    const config = context.get("config");
    const document = findProfileDocument(
      config.publicUrl,
      context.req.param("slug"),
    );
    if (document === undefined) {
      throw new HTTPException(404, {
        message: "Muster publishes no profile under that name.",
      });
    }
    return context.html(
      renderProfile(document, publicUrlFor(config, jwksPath)),
    );
  });

  return routes;
};
