import type { KbAgeRange } from "../kb";
import {
  addMonthsClamped,
  compareDates,
  parseIsoDate,
  type CalendarDate,
} from "./calendar-date";

/**
 * Renewal estimates (BN-22 / HACK-50).
 *
 * An estimate is the date a person reported plus one of the program's
 * published renewal schedules. It is never presented as an official date:
 * every surface labels it as an estimate and shows the schedule and source
 * it came from. The schedules are knowledge-base facts (the
 * renewal_cadence group), passed in as plain data so this module stays
 * client-safe.
 */

/**
 * An inclusive age range a published schedule names: the knowledge base's
 * own type, so the schedule data and the age answer it is compared with
 * cannot drift apart (third review: this was a field-for-field twin).
 * A type-only import, erased at build time, so this module stays
 * client-safe.
 */
export type AgeRange = KbAgeRange;

/** One published schedule, as plain serializable data. */
export interface RenewalSchedule {
  readonly id: string;
  readonly intervalMonths: number;
  /** Plain-language schedule, e.g. "Every 6 months". */
  readonly label: string;
  /** Who the source says the schedule covers. */
  readonly appliesTo: string;
  /** YYYY-MM-DD: first date a renewal under this schedule can fall on. */
  readonly startsOn?: string;
  /** The ages the source says the schedule covers, when it names a range. */
  readonly ages?: AgeRange;
}

export const AGE_ANSWERS = ["yes", "no", "unsure"] as const;

/** yes: inside the range; no: outside it; unsure: the person does not know. */
export type AgeAnswerValue = (typeof AGE_ANSWERS)[number];

export function isAgeAnswerValue(value: unknown): value is AgeAnswerValue {
  return typeof value === "string" && (AGE_ANSWERS as readonly string[]).includes(value);
}

/**
 * The person's answer to the one age question, kept with the range it was
 * asked about. If the knowledge base later changes that range, the answer
 * no longer matches any schedule and every estimate shows again, rather
 * than an old answer silently applying to a new question.
 */
export interface AgeAnswer extends AgeRange {
  readonly answer: AgeAnswerValue;
}

export interface RenewalEstimate {
  readonly date: CalendarDate;
  readonly scheduleId: string;
}

function sameRange(a: AgeRange, b: AgeRange): boolean {
  return a.min === b.min && a.max === b.max;
}

/** The age range the tracker asks about: the first schedule that names one, or null. */
export function ageQuestionRange(schedules: readonly RenewalSchedule[]): AgeRange | null {
  const scoped = schedules.find((schedule) => schedule.ages !== undefined);
  return scoped?.ages ? { min: scoped.ages.min, max: scoped.ages.max } : null;
}

/**
 * A schedule is left out only when the person said they are outside the
 * very range it names. No answer, "yes", and "unsure" keep every schedule:
 * an estimate too many is safer than a reminder that never comes.
 */
export function excludedByAge(schedule: RenewalSchedule, ageAnswer: AgeAnswer | undefined): boolean {
  return (
    schedule.ages !== undefined &&
    ageAnswer !== undefined &&
    ageAnswer.answer === "no" &&
    sameRange(schedule.ages, ageAnswer)
  );
}

/**
 * The next renewal date under each schedule that could produce it: the
 * reported date plus the schedule's interval (month ends clamp to the
 * earlier day), kept only when it falls on or after the schedule's start
 * and the person's age answer does not rule the schedule out. A schedule
 * that has not started by the candidate date cannot have set it. Sorted
 * earliest first; ties by schedule id.
 */
export function estimateRenewals(
  reported: CalendarDate,
  schedules: readonly RenewalSchedule[],
  ageAnswer?: AgeAnswer,
): readonly RenewalEstimate[] {
  const estimates: RenewalEstimate[] = [];
  for (const schedule of schedules) {
    const date = addMonthsClamped(reported, schedule.intervalMonths);
    if (schedule.startsOn !== undefined) {
      const startsOn = parseIsoDate(schedule.startsOn);
      if (startsOn === null) {
        throw new RangeError(
          `schedule ${schedule.id} has an invalid startsOn ${schedule.startsOn}`,
        );
      }
      if (compareDates(date, startsOn) < 0) {
        continue;
      }
    }
    if (excludedByAge(schedule, ageAnswer)) {
      continue;
    }
    estimates.push({ date, scheduleId: schedule.id });
  }
  return estimates.sort(
    (a, b) =>
      compareDates(a.date, b.date) ||
      (a.scheduleId < b.scheduleId ? -1 : a.scheduleId > b.scheduleId ? 1 : 0),
  );
}
