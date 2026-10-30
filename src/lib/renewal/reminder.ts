import {
  compareDates,
  daysBetween,
  parseIsoDate,
  type CalendarDate,
} from "./calendar-date";
import {
  estimateRenewals,
  isAgeAnswerValue,
  type AgeAnswer,
  type RenewalSchedule,
} from "./estimate";

/**
 * The in-app renewal reminder (BN-22 / HACK-50).
 *
 * A reminder is what the person told us, nothing more: which kind of date
 * they have, the date itself, and for an approval date their answer to the
 * one age question. It lives only on their device (see reminder-store.ts).
 * The dates it reminds about are recomputed on every visit, so a
 * knowledge-base schedule change reaches saved reminders without touching
 * them.
 */

/** A banner appears this many days before a reminder date, and on it. */
export const REMINDER_WINDOW_DAYS = 30;

/** Calendar-file alerts: this many days before the date. */
export const CALENDAR_ALARM_DAYS_BEFORE = [30, 7, 1] as const;

/**
 * Which date the person has. `renewal_due` is a due date or deadline
 * printed on a renewal letter, reminded about as given. `approval` is the
 * date on a letter that said their coverage was approved or renewed; the
 * reminder then rests on estimates from the published schedules.
 */
export const REPORTED_DATE_KINDS = ["renewal_due", "approval"] as const;

export type ReportedDateKind = (typeof REPORTED_DATE_KINDS)[number];

export function isReportedDateKind(value: unknown): value is ReportedDateKind {
  return (
    typeof value === "string" &&
    (REPORTED_DATE_KINDS as readonly string[]).includes(value)
  );
}

/** Reported dates outside these years are typing mistakes, not notices. */
export const REPORTED_YEAR_MIN = 2000;
export const REPORTED_YEAR_MAX = 2100;

/**
 * Version 1 is the first shape that ever ships. It gained calendarId,
 * revision, and ageAnswer before release (review fixes), so no reminder of
 * an earlier shape exists outside development browsers; one that turns up
 * fails validation and is discarded with a notice.
 */
export const RENEWAL_REMINDER_VERSION = 1;

/** A calendar id: 16 random bytes as lowercase hex. */
export const CALENDAR_ID_RE = /^[0-9a-f]{32}$/;

/** Revisions above this are not a person changing a date; they are corruption. */
export const MAX_REMINDER_REVISION = 100_000;

/** Age ranges in an answer: the bounds kb/schema.json puts on ages. */
const AGE_BOUND_MIN = 0;
const AGE_BOUND_MAX = 130;

/** The saved reminder: exactly what the person reported, versioned. */
export interface RenewalReminder {
  readonly version: typeof RENEWAL_REMINDER_VERSION;
  /** The knowledge-base entry whose schedules and steps apply. */
  readonly entryId: string;
  readonly kind: ReportedDateKind;
  /** YYYY-MM-DD, as the person entered it. */
  readonly reportedDate: string;
  /**
   * Random id that gives the calendar file's events one identity across
   * downloads and date changes (RFC 5545 UID), so a new file updates the
   * old events instead of adding copies with alerts on the wrong date.
   */
  readonly calendarId: string;
  /** How many times the person changed the reminder: the calendar file's SEQUENCE. */
  readonly revision: number;
  /** Approval dates only: the age answer, when the person gave one. */
  readonly ageAnswer?: AgeAnswer;
}

const REQUIRED_KEYS = ["version", "entryId", "kind", "reportedDate", "calendarId", "revision"] as const;
const OPTIONAL_KEYS = ["ageAnswer"] as const;
const AGE_ANSWER_KEYS = ["answer", "max", "min"] as const;

/** A fresh calendar id from the device's CSPRNG. */
export function newCalendarId(
  getRandomValues: (array: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer>,
): string {
  return [...getRandomValues(new Uint8Array(16))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** A reported date the tracker accepts: a real date within the year bounds. */
export function parseReportedDate(value: string): CalendarDate | null {
  const date = parseIsoDate(value.trim());
  if (
    date === null ||
    date.year < REPORTED_YEAR_MIN ||
    date.year > REPORTED_YEAR_MAX
  ) {
    return null;
  }
  return date;
}

function isAgeBound(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= AGE_BOUND_MIN &&
    value <= AGE_BOUND_MAX
  );
}

function hasExactlyKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const present = Object.keys(record).sort();
  return present.length === keys.length && [...keys].sort().every((key, index) => present[index] === key);
}

function validateAgeAnswer(raw: unknown): AgeAnswer | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  if (
    !hasExactlyKeys(record, AGE_ANSWER_KEYS) ||
    !isAgeBound(record.min) ||
    !isAgeBound(record.max) ||
    record.min > record.max ||
    !isAgeAnswerValue(record.answer)
  ) {
    return null;
  }
  return { min: record.min, max: record.max, answer: record.answer };
}

/**
 * Validate a reminder read back from the device. Anything that is not
 * exactly a current-version reminder for a known entry is rejected (null):
 * stored data is never trusted just because this app wrote it once.
 */
export function validateReminder(
  raw: unknown,
  knownEntryIds: readonly string[],
): RenewalReminder | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const hasAgeAnswer = Object.hasOwn(record, "ageAnswer");
  if (!hasExactlyKeys(record, hasAgeAnswer ? [...REQUIRED_KEYS, ...OPTIONAL_KEYS] : REQUIRED_KEYS)) {
    return null;
  }
  if (record.version !== RENEWAL_REMINDER_VERSION) {
    return null;
  }
  if (typeof record.entryId !== "string" || !knownEntryIds.includes(record.entryId)) {
    return null;
  }
  if (!isReportedDateKind(record.kind)) {
    return null;
  }
  if (
    typeof record.reportedDate !== "string" ||
    parseReportedDate(record.reportedDate) === null ||
    record.reportedDate !== record.reportedDate.trim()
  ) {
    return null;
  }
  if (typeof record.calendarId !== "string" || !CALENDAR_ID_RE.test(record.calendarId)) {
    return null;
  }
  if (
    typeof record.revision !== "number" ||
    !Number.isInteger(record.revision) ||
    record.revision < 0 ||
    record.revision > MAX_REMINDER_REVISION
  ) {
    return null;
  }
  let ageAnswer: AgeAnswer | undefined;
  if (hasAgeAnswer) {
    // Only an approval date has estimates for an age answer to shape.
    const parsed = record.kind === "approval" ? validateAgeAnswer(record.ageAnswer) : null;
    if (parsed === null) {
      return null;
    }
    ageAnswer = parsed;
  }
  return {
    version: RENEWAL_REMINDER_VERSION,
    entryId: record.entryId,
    kind: record.kind,
    reportedDate: record.reportedDate,
    calendarId: record.calendarId,
    revision: record.revision,
    ...(ageAnswer !== undefined ? { ageAnswer } : {}),
  };
}

/**
 * The dates a reminder is about: the reported due date itself, or the
 * schedule estimates from an approval date (shaped by the age answer).
 * Empty when no schedule can produce an estimate (for example, the entry
 * was withdrawn).
 */
export function reminderDates(
  reminder: Pick<RenewalReminder, "kind" | "reportedDate" | "ageAnswer">,
  schedules: readonly RenewalSchedule[],
): readonly CalendarDate[] {
  const reported = parseReportedDate(reminder.reportedDate);
  if (reported === null) {
    return [];
  }
  if (reminder.kind === "renewal_due") {
    return [reported];
  }
  return estimateRenewals(reported, schedules, reminder.ageAnswer).map((estimate) => estimate.date);
}

/**
 * later: no date has passed and the next one is more than
 *   REMINDER_WINDOW_DAYS away.
 * soon: the next date is 1 to REMINDER_WINDOW_DAYS days away.
 * today: a date is today.
 * passed: a date has passed and no date is inside the window. The status
 *   stays here, naming the most recent passed date and any later one,
 *   until the person changes the date: a passed renewal date is exactly
 *   when a reminder must not go quiet (review fix).
 */
export type ReminderPhase = "later" | "soon" | "today" | "passed";

export interface ReminderStatus {
  readonly phase: ReminderPhase;
  /**
   * soon, today, later: the next date on or after today. passed: the most
   * recent date before today.
   */
  readonly target: CalendarDate;
  /** Days from today to target; negative once passed. */
  readonly daysUntil: number;
  /** passed only: the next date still ahead, when there is one. */
  readonly next?: CalendarDate;
}

export function reminderStatus(
  today: CalendarDate,
  dates: readonly CalendarDate[],
): ReminderStatus | null {
  if (dates.length === 0) {
    return null;
  }
  const sorted = [...dates].sort(compareDates);
  const next = sorted.find((date) => compareDates(date, today) >= 0);
  const lastPassed = sorted.findLast((date) => compareDates(date, today) < 0);
  if (next !== undefined) {
    const daysUntil = daysBetween(today, next);
    if (daysUntil <= REMINDER_WINDOW_DAYS || lastPassed === undefined) {
      const phase: ReminderPhase =
        daysUntil === 0 ? "today" : daysUntil <= REMINDER_WINDOW_DAYS ? "soon" : "later";
      return { phase, target: next, daysUntil };
    }
    return { phase: "passed", target: lastPassed, daysUntil: daysBetween(today, lastPassed), next };
  }
  // Every date has passed: lastPassed is the latest date.
  const last = lastPassed!;
  return { phase: "passed", target: last, daysUntil: daysBetween(today, last) };
}

/** A status the in-app banner speaks for: inside the window, on the day, or after. */
export type DueReminderStatus = ReminderStatus & {
  readonly phase: Exclude<ReminderPhase, "later">;
};

/** The in-app banner shows inside the window, on the day, and after. */
export function bannerIsDue(status: ReminderStatus | null): status is DueReminderStatus {
  return status !== null && status.phase !== "later";
}
