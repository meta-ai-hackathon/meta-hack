/**
 * Calendar dates for the renewal tracker (BN-22 / HACK-50).
 *
 * A renewal date is a calendar date: what a notice prints and what a
 * calendar shows, with no time of day and no time zone. All arithmetic here
 * is integer math on (year, month, day), never Date objects carrying a local
 * offset, so a daylight-saving change or the device's zone can never move a
 * date by a day. The device's zone matters in exactly one place: deciding
 * which calendar date "today" is (localMomentInTimeZone).
 *
 * Client-safe: no server imports, no I/O.
 */

export interface CalendarDate {
  /** Proleptic Gregorian year. */
  readonly year: number;
  /** 1-12. */
  readonly month: number;
  /** 1 to the month's length. */
  readonly day: number;
}

const MONTH_LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

const MONTH_NAMES = [
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

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInMonth(year: number, month: number): number {
  if (month === 2 && isLeapYear(year)) {
    return 29;
  }
  return MONTH_LENGTHS[month - 1] ?? 0;
}

export function isValidCalendarDate(date: CalendarDate): boolean {
  return (
    Number.isInteger(date.year) &&
    Number.isInteger(date.month) &&
    Number.isInteger(date.day) &&
    date.year >= 1 &&
    date.year <= 9999 &&
    date.month >= 1 &&
    date.month <= 12 &&
    date.day >= 1 &&
    date.day <= daysInMonth(date.year, date.month)
  );
}

/** Strict YYYY-MM-DD to a real calendar date, or null. */
export function parseIsoDate(value: string): CalendarDate | null {
  const match = ISO_DATE_RE.exec(value);
  if (!match) {
    return null;
  }
  const date = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
  return isValidCalendarDate(date) ? date : null;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

export function formatIsoDate(date: CalendarDate): string {
  return `${pad(date.year, 4)}-${pad(date.month, 2)}-${pad(date.day, 2)}`;
}

/** "January 1, 2027": the plain-language date every surface shows. */
export function formatLongDate(date: CalendarDate): string {
  return `${MONTH_NAMES[date.month - 1]} ${date.day}, ${date.year}`;
}

/**
 * Days since 1970-01-01 in the proleptic Gregorian calendar (the
 * days-from-civil algorithm: shift the year to start in March so the leap
 * day is last, then count 400-year eras).
 */
export function toEpochDay(date: CalendarDate): number {
  const shiftedYear = date.month <= 2 ? date.year - 1 : date.year;
  const era = Math.floor(shiftedYear / 400);
  const yearOfEra = shiftedYear - era * 400;
  const monthFromMarch = (date.month + 9) % 12;
  const dayOfYear = Math.floor((153 * monthFromMarch + 2) / 5) + date.day - 1;
  const dayOfEra =
    yearOfEra * 365 +
    Math.floor(yearOfEra / 4) -
    Math.floor(yearOfEra / 100) +
    dayOfYear;
  return era * 146097 + dayOfEra - 719468;
}

/** The inverse of toEpochDay. */
export function fromEpochDay(epochDay: number): CalendarDate {
  const shifted = epochDay + 719468;
  const era = Math.floor(shifted / 146097);
  const dayOfEra = shifted - era * 146097;
  const yearOfEra = Math.floor(
    (dayOfEra -
      Math.floor(dayOfEra / 1460) +
      Math.floor(dayOfEra / 36524) -
      Math.floor(dayOfEra / 146096)) /
      365,
  );
  const dayOfYear =
    dayOfEra -
    (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const monthFromMarch = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * monthFromMarch + 2) / 5) + 1;
  const month = monthFromMarch < 10 ? monthFromMarch + 3 : monthFromMarch - 9;
  const year = yearOfEra + era * 400 + (month <= 2 ? 1 : 0);
  return { year, month, day };
}

export function addDays(date: CalendarDate, days: number): CalendarDate {
  return fromEpochDay(toEpochDay(date) + days);
}

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: CalendarDate, to: CalendarDate): number {
  return toEpochDay(to) - toEpochDay(from);
}

/** Negative, zero, or positive, like a sort comparator. */
export function compareDates(a: CalendarDate, b: CalendarDate): number {
  return Math.sign(toEpochDay(a) - toEpochDay(b));
}

/**
 * Add calendar months, clamping the day to the target month's length:
 * January 31 plus one month is February 28 (29 in a leap year), and
 * February 29 plus twelve months is February 28. Clamping always lands on
 * the earlier day, which is the safe direction for a reminder.
 */
export function addMonthsClamped(date: CalendarDate, months: number): CalendarDate {
  const monthIndex = date.year * 12 + (date.month - 1) + months;
  const year = Math.floor(monthIndex / 12);
  const month = monthIndex - year * 12 + 1;
  return { year, month, day: Math.min(date.day, daysInMonth(year, month)) };
}

export const MINUTES_PER_DAY = 24 * 60;

/** A wall-clock moment on the device: the calendar date and the minutes since its midnight. */
export interface LocalMoment {
  readonly date: CalendarDate;
  /** 0 to 1439. */
  readonly minutes: number;
}

/**
 * The calendar date and wall-clock minutes an instant falls on in an IANA
 * time zone. This is the only place a zone enters the tracker: "today" for
 * a person in Charlotte at 11:30 PM on December 31 is December 31, whatever
 * UTC says. Throws a RangeError for a zone the runtime does not know.
 */
export function localMomentInTimeZone(instant: Date, timeZone: string): LocalMoment {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    calendar: "gregory",
    numberingSystem: "latn",
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
  });
  const parts: Record<string, number> = {};
  for (const part of formatter.formatToParts(instant)) {
    parts[part.type] = Number(part.value);
  }
  const date = { year: parts.year ?? 0, month: parts.month ?? 0, day: parts.day ?? 0 };
  const hour = parts.hour ?? -1;
  const minute = parts.minute ?? -1;
  if (
    !isValidCalendarDate(date) ||
    !Number.isInteger(hour) ||
    !Number.isInteger(minute) ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    throw new RangeError(`could not read a local time in time zone ${timeZone}`);
  }
  return { date, minutes: hour * 60 + minute };
}

/** The same moment from the runtime's own local clock, which needs no zone name. */
export function localMomentFromDateGetters(instant: Date): LocalMoment {
  return {
    date: { year: instant.getFullYear(), month: instant.getMonth() + 1, day: instant.getDate() },
    minutes: instant.getHours() * 60 + instant.getMinutes(),
  };
}

/**
 * The device's IANA zone, or undefined when the runtime cannot name a zone
 * it can also use (some runtimes report "Etc/Unknown" when TZ is unset).
 */
export function deviceTimeZone(): string | undefined {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (typeof zone !== "string" || zone.length === 0) {
      return undefined;
    }
    // Throws a RangeError for a zone this runtime cannot format in.
    new Intl.DateTimeFormat("en-US", { timeZone: zone }).format(0);
    return zone;
  } catch {
    return undefined;
  }
}

/**
 * The device's wall-clock moment. Never throws: when the zone is unknown or
 * unusable, the runtime's local Date getters answer instead, which still
 * follow the device's offset. `zoneOf` is injectable for tests.
 */
export function deviceLocalMoment(
  instant: Date = new Date(),
  zoneOf: () => string | undefined = deviceTimeZone,
): LocalMoment {
  try {
    const zone = zoneOf();
    if (zone !== undefined) {
      return localMomentInTimeZone(instant, zone);
    }
  } catch {
    // Fall through to the local clock.
  }
  return localMomentFromDateGetters(instant);
}

/** The device's calendar date: what "today" means everywhere in the tracker. */
export function deviceToday(
  instant: Date = new Date(),
  zoneOf: () => string | undefined = deviceTimeZone,
): CalendarDate {
  return deviceLocalMoment(instant, zoneOf).date;
}

/**
 * Milliseconds until the device's next local midnight, at least one second.
 * Wall-clock arithmetic: on a day a clock change makes 23 or 25 hours long
 * it is an hour off, so schedule checks with msUntilNextDayCheck.
 */
export function msUntilNextLocalMidnight(instant: Date, moment: LocalMoment): number {
  const elapsedMs = moment.minutes * 60_000 + instant.getSeconds() * 1000 + instant.getMilliseconds();
  return Math.max(1000, MINUTES_PER_DAY * 60_000 - elapsedMs);
}

/** The longest the tracker waits between checks of the device's date. */
export const MAX_DAY_CHECK_MS = 60 * 60_000;

/**
 * When to check the device's date next: at the next local midnight, but
 * never more than an hour away (second review fix). On the night a clock
 * springs forward, the wall-clock wait from midnight is 24 hours while the
 * real day is 23, so a single timer saw the new day an hour late. Checking
 * at least hourly re-reads the wall clock within the last hour before
 * midnight, so the check lands on the new day on that night too. A night
 * that falls back is longer, and an early check just schedules again.
 */
export function msUntilNextDayCheck(instant: Date, moment: LocalMoment): number {
  return Math.min(msUntilNextLocalMidnight(instant, moment), MAX_DAY_CHECK_MS);
}
