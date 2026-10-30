import type { CalendarDate } from "./calendar-date";
import {
  calendarAlarmText,
  calendarDescription,
  calendarSummary,
} from "./copy";
import { estimateRenewals, type AgeAnswer } from "./estimate";
import { buildIcsCalendar, type IcsAllDayEvent } from "./ics";
import {
  CALENDAR_ALARM_DAYS_BEFORE,
  CALENDAR_ID_RE,
  MAX_REMINDER_REVISION,
  parseReportedDate,
  type ReportedDateKind,
} from "./reminder";
import type { RenewalBannerFacts, RenewalFactsView } from "./renewal-facts";

/**
 * The calendar file for a reported date (BN-22 / HACK-50): one all-day
 * event for a reported due date, or one per schedule estimate for an
 * approval date, each with alerts 30, 7, and 1 days before. Pure: the
 * caller supplies the clock and the device's local moment.
 *
 * Every event's UID comes from the reminder's calendar id plus a fixed key
 * (the due date, or the schedule an estimate assumes), and SEQUENCE is the
 * reminder's revision. So downloading again, or after changing the date,
 * gives a calendar app the same events with a higher sequence to update,
 * not new copies next to old alerts on the wrong date (review fix).
 */

export const RENEWAL_CALENDAR_FILENAME = "renewal-reminder.ics";

/** The event key for a reported due date; estimates use their schedule id. */
export const DUE_DATE_EVENT_KEY = "due";

export interface ReminderCalendarInput {
  readonly facts: Pick<RenewalFactsView, "programName" | "steps" | "links"> &
    Pick<RenewalBannerFacts, "schedules">;
  readonly kind: ReportedDateKind;
  readonly reportedDate: string;
  /** Approval dates only: shapes which estimates become events. */
  readonly ageAnswer?: AgeAnswer;
  /** The reminder's calendar id (32 hex characters). */
  readonly calendarId: string;
  /** The reminder's revision, written as each event's SEQUENCE. */
  readonly revision: number;
  readonly now: Date;
  readonly today: CalendarDate;
  /** Minutes since the device's local midnight: alerts already gone are left out. */
  readonly minutesIntoToday: number;
}

export interface ReminderCalendarFile {
  readonly filename: string;
  readonly text: string;
  /** The event dates, earliest first. */
  readonly dates: readonly CalendarDate[];
  /** The event UIDs, in the same order. */
  readonly uids: readonly string[];
}

/** One event's UID: stable for the same reminder and the same date or schedule. */
export function calendarEventUid(calendarId: string, eventKey: string): string {
  if (!CALENDAR_ID_RE.test(calendarId)) {
    throw new RangeError("calendar id must be 32 lowercase hex characters");
  }
  if (!/^[a-z0-9_]+$/.test(eventKey)) {
    throw new RangeError("event key must be a snake_case id");
  }
  return `${calendarId}-${eventKey}@renewal.benefits-navigator`;
}

/** Null when the reported date is invalid or no estimate exists. */
export function buildReminderCalendar(
  input: ReminderCalendarInput,
): ReminderCalendarFile | null {
  const reported = parseReportedDate(input.reportedDate);
  if (reported === null) {
    return null;
  }
  if (
    !Number.isInteger(input.revision) ||
    input.revision < 0 ||
    input.revision > MAX_REMINDER_REVISION
  ) {
    throw new RangeError("revision must be a whole number from 0 to the maximum");
  }
  const fromEstimate = input.kind === "approval";
  const planned: { readonly date: CalendarDate; readonly key: string }[] = fromEstimate
    ? estimateRenewals(reported, input.facts.schedules, input.ageAnswer).map((estimate) => ({
        date: estimate.date,
        key: estimate.scheduleId,
      }))
    : [{ date: reported, key: DUE_DATE_EVENT_KEY }];
  if (planned.length === 0) {
    return null;
  }
  const stepsUrl = input.facts.steps[0]?.source.sourceUrl ?? input.facts.links[0]?.url;
  const officialUrl =
    stepsUrl !== undefined && stepsUrl.startsWith("https://") ? stepsUrl : undefined;
  const events: IcsAllDayEvent[] = planned.map(({ date, key }) => ({
    uid: calendarEventUid(input.calendarId, key),
    sequence: input.revision,
    date,
    summary: calendarSummary(fromEstimate),
    description: calendarDescription(input.facts.programName, date, fromEstimate, officialUrl),
    ...(officialUrl !== undefined ? { url: officialUrl } : {}),
    alarmDaysBefore: CALENDAR_ALARM_DAYS_BEFORE,
    alarmDescription: calendarAlarmText(date, fromEstimate),
  }));
  return {
    // No date in the name: a shared device's downloads folder stays bland.
    filename: RENEWAL_CALENDAR_FILENAME,
    text: buildIcsCalendar(events, {
      now: input.now,
      today: input.today,
      minutesIntoToday: input.minutesIntoToday,
    }),
    dates: planned.map((event) => event.date),
    uids: events.map((event) => event.uid),
  };
}
