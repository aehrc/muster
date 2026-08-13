/**
 * Timestamps, as the reader's own browser writes them.
 *
 * Separate from the pure wording functions in `../pages/eventFilters.js` on purpose. The
 * wireframe asks for times "in the event's local time zone", which in a browser means the
 * reader's - and a function whose output depends on the machine's locale is not one a test can
 * pin to a string. So the sentences are pure and tested, and the two lines that format a time
 * live here.
 *
 * Author: John Grimes
 */

/**
 * Hours and minutes.
 *
 * The event view's status column is narrow and its rows are all from the last few minutes; the
 * date belongs on the check history, where a reader comparing two entries needs it.
 *
 * @param iso - An ISO 8601 timestamp, as the API sends them.
 * @returns The time, in the reader's locale.
 * @example
 * ```ts
 * describeCheckStatus(system.check, shortTime);
 * ```
 */
export function shortTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * The date and the time.
 *
 * @param iso - An ISO 8601 timestamp, as the API sends them.
 * @returns The moment, in the reader's locale.
 */
export function fullTime(iso: string): string {
  return new Date(iso).toLocaleString();
}
