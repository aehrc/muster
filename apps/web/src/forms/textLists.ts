/**
 * The two conversions every form makes between a text box and a list.
 *
 * A system's redirect URIs and a pairing request's are the same thing typed into the same kind of
 * box, and both forms need the same answer to "what did they mean by this line break?". Written
 * once, so the two cannot disagree about whether a trailing newline is an empty entry.
 *
 * Author: John Grimes
 */

/**
 * The non-empty lines of a textarea, trimmed.
 *
 * @param value - The textarea's contents.
 * @returns One entry per non-empty line.
 * @example
 * ```ts
 * lines("https://a.test/\n\n https://b.test/ \n"); // ["https://a.test/", "https://b.test/"]
 * ```
 */
export function lines(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * The whitespace-separated words of a field.
 *
 * Any whitespace, not only spaces: scopes pasted out of a discovery document arrive with newlines
 * in them, and a person who typed two spaces meant one separator.
 *
 * @param value - The field's contents.
 * @returns One entry per word.
 * @example
 * ```ts
 * words("launch  openid\nfhirUser"); // ["launch", "openid", "fhirUser"]
 * ```
 */
export function words(value: string): string[] {
  return value.split(/\s+/).filter((word) => word.length > 0);
}
