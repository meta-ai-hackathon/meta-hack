import { addDays, daysBetween, type CalendarDate } from "./calendar-date";

/**
 * Add-to-calendar file (RFC 5545 iCalendar) for the renewal tracker
 * (BN-22 / HACK-50). Built entirely in the browser and handed to the person
 * as a download: the date never leaves the device through this module.
 *
 * What the RFC asks for, and where it is enforced:
 * - CRLF line endings on every content line (3.1) — buildIcsCalendar.
 * - Lines longer than 75 octets folded with CRLF + one space, never inside
 *   a multi-byte UTF-8 character (3.1) — foldIcsLine.
 * - TEXT values escape backslash, semicolon, comma, and newlines, and carry
 *   no other control characters (3.3.11) — escapeIcsText.
 * - Every VEVENT has UID and DTSTAMP (3.6.1); an all-day event is a DATE
 *   DTSTART with DTEND on the next day (3.6.1, 3.8.2.2).
 * - The UID stays the same for the same event across files, and SEQUENCE
 *   goes up when the event changes (3.8.4.7, 3.8.7.4), so a calendar app
 *   can update an event instead of adding a copy.
 * - CLASS:PRIVATE (3.8.1.3) asks a shared calendar to hide the details.
 * - VALARM needs ACTION, TRIGGER, and, for DISPLAY, DESCRIPTION (3.6.6).
 */

export const ICS_MAX_LINE_OCTETS = 75;

/** Alerts fire at this local hour on their day (Apple's all-day convention). */
export const ICS_ALARM_HOUR = 9;

export const ICS_PRODUCT_ID = "-//Benefits Navigator//Renewal reminder//EN";

export interface IcsAllDayEvent {
  readonly uid: string;
  /** SEQUENCE: 0 for a new event, higher each time it changes. */
  readonly sequence: number;
  readonly date: CalendarDate;
  readonly summary: string;
  readonly description: string;
  /** An official https link for the event, when there is one. */
  readonly url?: string;
  /** Alert this many days before `date`, at ICS_ALARM_HOUR local time. */
  readonly alarmDaysBefore: readonly number[];
  readonly alarmDescription: string;
}

export interface IcsCalendarOptions {
  /** DTSTAMP: when the file was made. */
  readonly now: Date;
  /** The device's today. */
  readonly today: CalendarDate;
  /**
   * Minutes since the device's local midnight. With `today`, this decides
   * which alerts are still ahead: an alert whose time has already passed,
   * today included, is left out.
   */
  readonly minutesIntoToday: number;
}

/**
 * Whether an alert `daysBefore` days ahead of an all-day event, at
 * ICS_ALARM_HOUR on its day, is still in the future at the given local
 * moment (review fix: an alert dated today was kept after 9 AM had gone).
 */
export function alarmIsAhead(
  eventDate: CalendarDate,
  daysBefore: number,
  today: CalendarDate,
  minutesIntoToday: number,
): boolean {
  const alarmDayFromToday = daysBetween(today, eventDate) - daysBefore;
  return (
    alarmDayFromToday > 0 ||
    (alarmDayFromToday === 0 && minutesIntoToday < ICS_ALARM_HOUR * 60)
  );
}

/** UTF-8 length of one code point. */
function codePointOctets(codePoint: number): number {
  if (codePoint < 0x80) {
    return 1;
  }
  if (codePoint < 0x800) {
    return 2;
  }
  if (codePoint < 0x10000) {
    return 3;
  }
  return 4;
}

/** UTF-8 length of a string (lone surrogates count as U+FFFD, 3 octets). */
export function utf8Length(value: string): number {
  let octets = 0;
  for (const char of value) {
    octets += codePointOctets(char.codePointAt(0) ?? 0);
  }
  return octets;
}

/** Replace lone UTF-16 surrogates, which have no UTF-8 encoding, with U+FFFD. */
function toWellFormed(value: string): string {
  let out = "";
  for (const char of value) {
    const codePoint = char.codePointAt(0) ?? 0;
    out += codePoint >= 0xd800 && codePoint <= 0xdfff ? "�" : char;
  }
  return out;
}

/**
 * Escape a TEXT value (RFC 5545 3.3.11): backslash, semicolon, and comma get
 * a backslash; CRLF, CR, and LF become the two characters \n. Other control
 * characters are not allowed in TEXT, so they become spaces (HTAB stays).
 */
export function escapeIcsText(value: string): string {
  let out = "";
  const text = toWellFormed(value).replace(/\r\n?/g, "\n");
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (char === "\\" || char === ";" || char === ",") {
      out += `\\${char}`;
    } else if (char === "\n") {
      out += "\\n";
    } else if (code === 0x09) {
      out += char;
    } else if (code < 0x20 || code === 0x7f) {
      out += " ";
    } else {
      out += char;
    }
  }
  return out;
}

/**
 * Fold one content line (RFC 5545 3.1): no physical line exceeds 75 octets,
 * continuation lines start with a single space, and a split never lands
 * inside a character.
 */
export function foldIcsLine(line: string): string {
  const physical: string[] = [];
  let current = "";
  let currentOctets = 0;
  for (const char of line) {
    const octets = codePointOctets(char.codePointAt(0) ?? 0);
    if (currentOctets + octets > ICS_MAX_LINE_OCTETS) {
      physical.push(current);
      current = " ";
      currentOctets = 1;
    }
    current += char;
    currentOctets += octets;
  }
  physical.push(current);
  return physical.join("\r\n");
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

/** DATE value: YYYYMMDD. */
export function formatIcsDate(date: CalendarDate): string {
  return `${pad(date.year, 4)}${pad(date.month, 2)}${pad(date.day, 2)}`;
}

/** UTC DATE-TIME value: YYYYMMDDTHHMMSSZ. */
export function formatIcsUtc(instant: Date): string {
  return (
    `${pad(instant.getUTCFullYear(), 4)}${pad(instant.getUTCMonth() + 1, 2)}` +
    `${pad(instant.getUTCDate(), 2)}T${pad(instant.getUTCHours(), 2)}` +
    `${pad(instant.getUTCMinutes(), 2)}${pad(instant.getUTCSeconds(), 2)}Z`
  );
}

/**
 * TRIGGER for an alert `daysBefore` days ahead of an all-day event, at
 * `atHour` local time on that day: a negative DURATION from the event's
 * start at midnight. One day before at 9 AM is -PT15H; seven days before
 * is -P6DT15H; thirty is -P29DT15H.
 */
export function alarmTrigger(daysBefore: number, atHour: number = ICS_ALARM_HOUR): string {
  if (!Number.isInteger(daysBefore) || daysBefore < 1) {
    throw new RangeError("daysBefore must be a whole number of days, at least 1");
  }
  if (!Number.isInteger(atHour) || atHour < 0 || atHour > 23) {
    throw new RangeError("atHour must be a whole hour from 0 to 23");
  }
  const minutes = daysBefore * 24 * 60 - atHour * 60;
  const days = Math.floor(minutes / (24 * 60));
  const hours = Math.floor((minutes - days * 24 * 60) / 60);
  const datePart = days > 0 ? `${days}D` : "";
  const timePart = hours > 0 ? `T${hours}H` : "";
  return `-P${datePart}${timePart}`;
}

const SAFE_URI_RE = /^https:\/\/[^\s"<>\\^`{|}]+$/;

/**
 * Whether a URL is one an event's URL line can carry as is: https, with no
 * whitespace, quotes, angle brackets, backslash, caret, backtick, braces, or
 * pipe. The renewal facts view holds every URL it shows to the same rule
 * when it loads (renewal-facts.ts), so bad knowledge-base data fails there.
 */
export function isPlainHttpsUrl(value: string): boolean {
  return SAFE_URI_RE.test(value);
}

function eventLines(event: IcsAllDayEvent, options: IcsCalendarOptions): string[] {
  if (!/^[\x21-\x7e]+$/.test(event.uid)) {
    throw new RangeError("event uid must be printable ASCII with no spaces");
  }
  if (!Number.isInteger(event.sequence) || event.sequence < 0) {
    throw new RangeError("event sequence must be a whole number, 0 or more");
  }
  const lines = [
    "BEGIN:VEVENT",
    `UID:${event.uid}`,
    `DTSTAMP:${formatIcsUtc(options.now)}`,
    `SEQUENCE:${event.sequence}`,
    `DTSTART;VALUE=DATE:${formatIcsDate(event.date)}`,
    `DTEND;VALUE=DATE:${formatIcsDate(addDays(event.date, 1))}`,
    `SUMMARY:${escapeIcsText(event.summary)}`,
    `DESCRIPTION:${escapeIcsText(event.description)}`,
  ];
  if (event.url !== undefined) {
    if (!isPlainHttpsUrl(event.url)) {
      throw new RangeError("event url must be a plain https URL");
    }
    lines.push(`URL:${event.url}`);
  }
  lines.push("CLASS:PRIVATE", "TRANSP:TRANSPARENT");
  const alarmDays = [...new Set(event.alarmDaysBefore)]
    .filter(
      (days) =>
        Number.isInteger(days) &&
        days >= 1 &&
        alarmIsAhead(event.date, days, options.today, options.minutesIntoToday),
    )
    .sort((a, b) => b - a);
  for (const days of alarmDays) {
    lines.push(
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      `DESCRIPTION:${escapeIcsText(event.alarmDescription)}`,
      `TRIGGER:${alarmTrigger(days)}`,
      "END:VALARM",
    );
  }
  lines.push("END:VEVENT");
  return lines;
}

/**
 * The whole calendar file: one all-day VEVENT per event, each with its
 * alerts, every line folded and CRLF-terminated.
 */
export function buildIcsCalendar(
  events: readonly IcsAllDayEvent[],
  options: IcsCalendarOptions,
): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${ICS_PRODUCT_ID}`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    ...events.flatMap((event) => eventLines(event, options)),
    "END:VCALENDAR",
  ];
  return lines.map((line) => `${foldIcsLine(line)}\r\n`).join("");
}
