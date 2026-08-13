/**
 * The type of `ticketProfile.md` when imported as text.
 *
 * TypeScript resolves a relative import of a non-TypeScript file through
 * `allowArbitraryExtensions`, which looks for `<name>.d.<ext>.ts` beside it - so this file is
 * how `import ... from "./ticketProfile.md" with { type: "text" }` typechecks. Bun's
 * bundler inlines the file's contents at build time.
 *
 * Author: John Grimes
 */

/** The contract, verbatim. */
declare const content: string;
export default content;
