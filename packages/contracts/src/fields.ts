import { z } from "zod";

/**
 * The field shapes more than one contract module needs.
 *
 * A participant's endpoint is an https URL wherever it appears, and a free-text
 * field has the same ceiling wherever it appears, so both are stated once here
 * rather than once per module. Nothing in here is exported from the package: it
 * is the vocabulary the contract modules are written in, not part of the
 * contract itself.
 *
 * @author John Grimes
 */

/** Longest free-text field accepted, so a note cannot become a payload. */
export const maximumTextLength = 4000;

/**
 * Builds a check that a value is an absolute URL with one of the given schemes.
 *
 * @param schemes - the acceptable URL schemes, with their colons
 * @returns a predicate for `refine`
 * @example
 * ```ts
 * const httpUrl = z.string().refine(urlWithScheme(["http:", "https:"]));
 * ```
 */
export const urlWithScheme =
  (schemes: readonly string[]) =>
  (value: string): boolean => {
    try {
      return schemes.includes(new URL(value).protocol);
    } catch {
      return false;
    }
  };

/** An https URL, which is what a participant's endpoints must be. */
export const httpsUrl = z
  .string()
  .refine(urlWithScheme(["https:"]), "must be an absolute https URL");
