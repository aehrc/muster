/**
 * Dates and ages, as a reader sees them.
 *
 * The event view's job is to be trusted, and an entry's age is most of what makes
 * it trustworthy: "confirmed 4 days ago" says something the raw timestamp does
 * not. The clock arrives as an argument, so the wording is a pure function and is
 * tested rather than observed.
 *
 * Months are spelled out rather than left to a locale, so a day is never
 * ambiguous between the reader's conventions and the writer's.
 *
 * @author John Grimes
 */

/** The months, in the order a day names them. */
const monthNames = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

/** A day, taken apart. */
type DayParts = {
  /** the day of the month */
  readonly day: number;
  /** the month's name */
  readonly month: string;
  /** the year */
  readonly year: string;
};

/**
 * Takes a day apart.
 *
 * @param day - the day, as `YYYY-MM-DD`
 * @returns its parts, or undefined when it is not a day
 */
const partsOf = (day: string): DayParts | undefined => {
  const found = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (found === null) {
    return undefined;
  }
  const month = monthNames[Number(found[2]) - 1];
  const dayOfMonth = Number(found[3]);
  if (month === undefined || dayOfMonth < 1 || dayOfMonth > 31) {
    return undefined;
  }
  return { day: dayOfMonth, month, year: found[1] ?? "" };
};

/**
 * Spells a day out.
 *
 * @param day - the day, as `YYYY-MM-DD`
 * @returns the day in words, or the input unchanged when it is not a day
 * @example
 * ```ts
 * formatDay("2026-09-01"); // "1 September 2026"
 * ```
 */
export const formatDay = (day: string): string => {
  const parts = partsOf(day);
  return parts === undefined
    ? day
    : `${String(parts.day)} ${parts.month} ${parts.year}`;
};

/**
 * Spells a range of days out.
 *
 * A range inside one month names the month once, because "1 to 3 September 2026"
 * is what a person would write.
 *
 * @param startsOn - the first day
 * @param endsOn - the last day
 * @returns the range in words
 * @example
 * ```ts
 * formatDateRange("2026-09-01", "2026-09-03"); // "1 to 3 September 2026"
 * ```
 */
export const formatDateRange = (startsOn: string, endsOn: string): string => {
  if (startsOn === endsOn) {
    return formatDay(startsOn);
  }
  const from = partsOf(startsOn);
  const to = partsOf(endsOn);
  if (
    from !== undefined &&
    to !== undefined &&
    from.month === to.month &&
    from.year === to.year
  ) {
    return `${String(from.day)} to ${String(to.day)} ${to.month} ${to.year}`;
  }
  return `${formatDay(startsOn)} to ${formatDay(endsOn)}`;
};

/** One minute, in milliseconds. */
const minuteMs = 60_000;

/** One hour, in milliseconds. */
const hourMs = 60 * minuteMs;

/** One day, in milliseconds. */
const dayMs = 24 * hourMs;

/** Beyond this, an age says less than a date does. */
const ageHorizonMs = 30 * dayMs;

/**
 * Counts an elapsed span in one unit.
 *
 * @param elapsed - how long has passed, in milliseconds
 * @param unit - the unit's length in milliseconds
 * @param singular - what one of them is called, with its article
 * @param plural - what several of them are called
 * @returns the phrase
 */
const inUnits = (
  elapsed: number,
  unit: number,
  singular: string,
  plural: string,
): string => {
  const count = Math.floor(elapsed / unit);
  return count === 1 ? `${singular} ago` : `${String(count)} ${plural} ago`;
};

/**
 * Says how long ago an instant was.
 *
 * @param instant - the instant, as an ISO 8601 string
 * @param now - the current instant
 * @returns how long ago it was, or the date once the age stops being useful
 * @example
 * ```ts
 * describeAge(entry.confirmedAt, new Date()); // "4 days ago"
 * ```
 */
export const describeAge = (instant: string, now: Date): string => {
  const at = new Date(instant);
  if (Number.isNaN(at.getTime())) {
    return "at an unknown time";
  }
  const elapsed = now.getTime() - at.getTime();
  if (elapsed >= ageHorizonMs) {
    return `on ${formatDay(at.toISOString().slice(0, 10))}`;
  }
  if (elapsed >= dayMs) {
    const days = Math.floor(elapsed / dayMs);
    return days === 1 ? "yesterday" : `${String(days)} days ago`;
  }
  if (elapsed >= hourMs) {
    return inUnits(elapsed, hourMs, "an hour", "hours");
  }
  if (elapsed >= minuteMs) {
    return inUnits(elapsed, minuteMs, "a minute", "minutes");
  }
  return "just now";
};
