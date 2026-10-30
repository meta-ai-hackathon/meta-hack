import { ANSWER_STATUS_LABELS } from "../honesty";
import { formatLongDate, type CalendarDate } from "./calendar-date";
import type { AgeAnswer, AgeAnswerValue, AgeRange } from "./estimate";
import {
  REMINDER_WINDOW_DAYS,
  type ReminderStatus,
  type ReportedDateKind,
} from "./reminder";

/**
 * Every sentence the renewal tracker shows or writes into a calendar file
 * (BN-22 / HACK-50), in one place so the honesty gate can scan all of it
 * (copy.test.ts). Rules for this copy:
 * - A renewal "may be due". Only a date the person reported is stated as
 *   what they told us; an estimate always says it is an estimate.
 * - Nothing about staying covered, staying eligible, or being approved.
 * - Program specifics (offices, portals, phone lines) are never written
 *   here: they come from knowledge-base facts, rendered with their source.
 * - The calendar file never names the program or links to its pages, in
 *   its title, notes, or alerts: titles and alerts show on lock screens
 *   and shared calendars, and a calendar that syncs keeps its own copy of
 *   the notes (third review).
 * - Plain language, short sentences.
 */

/** Where a date or fact came from. Every rendered date carries one. */
export type DateOrigin = "official" | "user" | "estimate";

export function originLabel(origin: DateOrigin, programName: string): string {
  switch (origin) {
    case "official":
      return `From ${programName}`;
    case "user":
      return ANSWER_STATUS_LABELS.known;
    case "estimate":
      return "Estimate, not an official date";
  }
}

export type DateChoice = ReportedDateKind | "unknown";

export const DATE_CHOICE_LABELS: Readonly<Record<DateChoice, string>> = {
  renewal_due: "A due date or deadline on a renewal letter or notice",
  approval: "The date on a letter that said my coverage was approved or renewed",
  unknown: "I don't know the date",
};

export const DATE_CHOICE_LEGEND = "Which date do you have?";

/**
 * Review fix: a renewal notice or a request for information carries a
 * deadline, which is a due date, not an approval date.
 */
export const DATE_CHOICE_HELP =
  "Got a renewal notice or a letter asking for more information? Choose the " +
  "first option and enter the deadline printed on the letter.";

export const DATE_FIELD_LABEL = "Date on your letter or notice";

export const DATE_FIELD_HELP =
  "Use the newest letter or notice you have. If your browser asks for a format, use year-month-day, like 2027-04-30.";

export function ageQuestionLegend(): string {
  return "How old is the person this renewal is for?";
}

export function ageChoiceLabels(range: AgeRange): Readonly<Record<AgeAnswerValue, string>> {
  return {
    yes: `Between ${range.min} and ${range.max}`,
    no: `Younger than ${range.min} or older than ${range.max}`,
    unsure: "I'm not sure",
  };
}

export const AGE_QUESTION_HELP =
  "Some renewal schedules are only for some ages, so your answer changes " +
  "which estimates you see. You can skip it. Your answer stays on this device.";

export const SECTION_HEADING = "Your renewal date";

export const NO_DATE_INTRO =
  "Do you have a letter or notice with a date on it? Save it here to see a " +
  "reminder on this site as the date gets close, and download a calendar " +
  "file for a reminder that lasts. Saving here sends nothing anywhere.";

export const UNKNOWN_DATE_NOTE =
  "That's okay. Watch your mail for letters about your renewal, and use " +
  "the official steps on this page. You can come back and add a date any " +
  "time.";

/**
 * The calendar file is a plain copy of the date the person chooses to make
 * (second review fix), so the note says what leaves with it. Since the
 * third review the file names no program and links nowhere, so a synced
 * event carries only the neutral title, the date, and a pointer back here.
 */
export const PRIVACY_NOTE =
  "This site keeps your date only on this device. It is saved encrypted in " +
  "this browser and is never sent to us. Anyone who uses this browser could " +
  "see the reminder, so remove it if you share this device. The calendar " +
  "file is marked private, and its title, notes, and alerts do not name " +
  "the program or link to it. A calendar that syncs or that others can see " +
  "keeps its own copy of the date.";

/** Review fix: browsers can clear site data on their own, Safari after about a week. */
export const BROWSER_CAN_CLEAR_NOTE =
  "This browser can clear the saved date on its own. Some browsers do it " +
  "after about a week without a visit to this site. The calendar file is " +
  "the reminder that lasts.";

export const STORAGE_UNAVAILABLE_NOTE =
  "This browser can't save a private reminder right now (it may be in " +
  "private mode or blocking storage). You can still download a calendar " +
  "file.";

export const LOADING_NOTE = "Checking this device for a saved date…";

export const NOSCRIPT_NOTE =
  "Saving a reminder and making a calendar file need JavaScript, which is " +
  "off in this browser. The official facts below work without it.";

export const SAVE_BUTTON = "Save a reminder on this device";
export const DOWNLOAD_BUTTON = "Download a calendar file (.ics)";
export const CHANGE_BUTTON = "Change the date";
export const REMOVE_BUTTON = "Remove the reminder from this device";

/** What saving did, for the kind of date saved (review fix: approval dates are in the past). */
export function savedNotice(kind: ReportedDateKind): string {
  const when =
    kind === "renewal_due"
      ? `starting ${REMINDER_WINDOW_DAYS} days before the date`
      : `starting ${REMINDER_WINDOW_DAYS} days before each estimate`;
  return (
    `Your date is saved on this device. A reminder shows on this site ${when}. ` +
    "Download the calendar file too: it keeps reminding you even if this " +
    "browser clears the date."
  );
}

export const REMOVED_NOTICE = "The reminder is removed from this device.";
export const DOWNLOADED_NOTICE =
  "Your calendar file is ready. Open it to add the date to your calendar " +
  "app, then check that the event has a reminder alert, because some " +
  "calendar apps drop them. The event does not name the program, so the " +
  "official steps stay on this page. If you added a file before, delete " +
  "any old event it left.";
/** Third review fix: a failed download used to say nothing. */
export const DOWNLOAD_FAILED_NOTICE =
  "The calendar file could not be made in this browser. You can add the " +
  "date to your calendar by hand, or try again in another browser.";
export const DISCARDED_NOTICE =
  "A saved reminder on this device could not be read, so it was removed. " +
  "You can save your date again.";
export const UNSUPPORTED_NOTICE =
  "A reminder on this device was saved by a newer version of this site, " +
  "so it is not shown here.";
export const SAVE_FAILED_NOTICE =
  "The reminder could not be saved on this device. You can still download " +
  "a calendar file.";
/** Second review fix: a failed remove used to say nothing. */
export const REMOVE_FAILED_NOTICE =
  "The reminder could not be removed from this device. To remove it " +
  "yourself, clear this site's data in your browser's settings.";

/** The banner's line when a saved reminder cannot be read; the tracker then removes it and says so. */
export const UNREADABLE_BANNER_MESSAGE =
  "A renewal reminder saved on this device could not be read.";

export const ERROR_CHOOSE_KIND = "Choose which date you have, or choose I don't know the date.";
export const ERROR_INVALID_DATE =
  "Enter a real date between the years 2000 and 2100, like 2027-04-30.";
export const ERROR_APPROVAL_IN_FUTURE =
  "A letter that says the coverage was approved or renewed is dated today " +
  "or earlier. If this date is a due date or a deadline, choose the first " +
  "option instead.";

export const ESTIMATE_EXPLAINER =
  "These are estimates, not official dates. They come from the date you " +
  "told us and the published schedules below. If your renewal moves to a " +
  "new schedule, the change may start at your next scheduled renewal, so " +
  "either date could be the one that applies. A letter about your renewal " +
  "has the real date.";

/** Second review fix: with one estimate on screen there is no "either date". */
export const ONE_ESTIMATE_EXPLAINER =
  "This is an estimate, not an official date. It comes from the date you " +
  "told us and the published schedule below. A letter about your renewal " +
  "has the real date.";

/** The explainer for the number of estimates shown, or null when none is (NO_ESTIMATE_NOTE says why). */
export function estimateExplainer(count: number): string | null {
  if (count <= 0) {
    return null;
  }
  return count === 1 ? ONE_ESTIMATE_EXPLAINER : ESTIMATE_EXPLAINER;
}

export const NO_ESTIMATE_NOTE =
  "No published schedule gives an estimate from this date. Watch your mail " +
  "for letters about your renewal.";

/** Shown with estimates from a stale knowledge-base entry (BN-29): never silent. */
export const STALE_ESTIMATE_NOTE =
  "The published schedule behind this estimate may be out of date. Check " +
  "the source links on the renewal tracker before you rely on it.";

export const PASSED_ADVICE =
  "If you have not renewed yet, use the official steps on this page. If " +
  "you got a newer letter or notice, change the date to the one on it.";

export const PASSED_ESTIMATE_ADVICE =
  "Your renewal may have been due around then. Check your mail for a " +
  "letter about your renewal and answer it right away. If you got a newer " +
  "letter or notice, change the date to the one on it.";

export const IF_COVERAGE_ENDS_HEADING = "If your coverage ends";

export const OPEN_TRACKER_LINK = "Open your renewal tracker";

/** Review fix: people who are only applying have no coverage to renew yet. */
export const TRACKER_LINK_HEADING = "Already have coverage? Keep track of your renewal";

export const TRACKER_LINK_TEXT =
  "If you have coverage, the program checks your information again on a " +
  "schedule. Save the date from your letter or notice to get a reminder " +
  "on this device.";

export const PAGE_TITLE = "Keep track of your renewal";

export function pageIntro(programName: string): string {
  return (
    `Renewal is when your information is checked again to decide whether ` +
    `your ${programName} continues. Facts labeled "From ${programName}" ` +
    `come from official pages. A date labeled "You told us" is one you ` +
    `entered, and this site keeps it only on this device. Your own letters ` +
    `about your renewal have the dates that apply to you.`
  );
}

export function factsHeading(programName: string): string {
  return `What ${programName} says about renewal`;
}

export function factsIntro(programName: string): string {
  return (
    `Each item below comes from ${programName}, with a link to the page it ` +
    `came from and the date we read it.`
  );
}

export const FACTS_SUBHEADINGS = {
  schedules: "How often renewal happens",
  keyDates: "Dates to know",
  steps: "What to do now",
  documents: "If a letter comes",
  rules: "How renewal works",
  ifCoverageEnds: IF_COVERAGE_ENDS_HEADING,
  links: "Official links",
} as const;

/** The visible flag on a stale or withdrawn entry (BN-29): never silent. */
export function entryStatusFlag(
  status: "stale" | "withdrawn",
  reason: string | undefined,
): string {
  const why = reason ? ` Reason: ${reason}` : "";
  return status === "stale"
    ? `This information may be out of date.${why} Check the source links before you rely on it.`
    : `This information was withdrawn and is not shown.${why}`;
}

function dayCount(days: number): string {
  return days === 1 ? "1 day" : `${days} days`;
}

/**
 * The sentence after the "You told us" label. It does not repeat the
 * label (review a11y fix: screen readers read "You told us You told us").
 */
export function reportedDateSentence(kind: ReportedDateKind, date: CalendarDate): string {
  return kind === "renewal_due"
    ? `Your renewal is due on ${formatLongDate(date)}.`
    : `The letter that said the coverage was approved or renewed is dated ${formatLongDate(date)}.`;
}

/** The sentence after the "You told us" label for the age answer. */
export function ageAnswerSentence(answer: AgeAnswer): string {
  switch (answer.answer) {
    case "yes":
      return `The person this renewal is for is between ages ${answer.min} and ${answer.max}.`;
    case "no":
      return `The person this renewal is for is younger than ${answer.min} or older than ${answer.max}.`;
    case "unsure":
      return `You weren't sure whether the person this renewal is for is between ages ${answer.min} and ${answer.max}.`;
  }
}

/** Why a schedule's estimate is missing, so nothing is dropped silently. */
export function ageLeftOutNote(scheduleLabel: string, range: AgeRange): string {
  return (
    `You said the person is younger than ${range.min} or older than ` +
    `${range.max}, so there is no "${scheduleLabel}" estimate. That ` +
    `schedule is for ages ${range.min} through ${range.max}.`
  );
}

/** One estimate line, naming the schedule it assumes. */
export function estimateSentence(scheduleLabel: string, date: CalendarDate): string {
  return (
    `If your renewal comes ${scheduleLabel.toLowerCase()}, it may be due ` +
    `around ${formatLongDate(date)}.`
  );
}

/**
 * The reminder line for a status: for the banner, the tracker, and the
 * live announcement. `fromEstimate` marks dates worked out from schedules.
 */
export function reminderMessage(
  status: ReminderStatus,
  programName: string,
  fromEstimate: boolean,
): string {
  const when = formatLongDate(status.target);
  const estimate = fromEstimate ? " This is an estimate." : "";
  switch (status.phase) {
    case "later":
      // Only the tracker shows this phase, right under the date itself, so
      // it adds the distance and the promise of a reminder, not the date.
      return fromEstimate
        ? `The next estimate is ${dayCount(status.daysUntil)} from today. A reminder shows on this site starting ${REMINDER_WINDOW_DAYS} days before it.`
        : `That is ${dayCount(status.daysUntil)} from today. A reminder shows on this site starting ${REMINDER_WINDOW_DAYS} days before.`;
    case "soon":
      return fromEstimate
        ? `Reminder: your ${programName} renewal may be due in about ${dayCount(status.daysUntil)}, around ${when}.${estimate}`
        : `Reminder: you told us your ${programName} renewal is due in ${dayCount(status.daysUntil)}, on ${when}.`;
    case "today":
      return fromEstimate
        ? `Reminder: your ${programName} renewal may be due around today, ${when}.${estimate}`
        : `Reminder: you told us your ${programName} renewal is due today, ${when}.`;
    case "passed":
      if (!fromEstimate) {
        return `The ${programName} renewal date you told us, ${when}, has passed.`;
      }
      return status.next
        ? `An estimated ${programName} renewal date, ${when}, has passed. The next estimate is ${formatLongDate(status.next)}.`
        : `The estimated ${programName} renewal date, ${when}, has passed.`;
  }
}

/** Calendar-file text: SUMMARY (no program name: titles show on shared calendars). */
export function calendarSummary(fromEstimate: boolean): string {
  return fromEstimate ? "Check on your renewal (estimate)" : "Check on your renewal";
}

/** Where the calendar notes send the person for the official steps. */
export const CALENDAR_TRACKER_POINTER =
  "The renewal tracker on the device where you made this file has the official steps.";

/**
 * Calendar-file text: DESCRIPTION. Like the title and the alerts, it names
 * no program and carries no link (third review: a calendar that syncs
 * keeps a copy of the notes), only the date and a pointer to the tracker.
 */
export function calendarDescription(date: CalendarDate, fromEstimate: boolean): string {
  const what = fromEstimate
    ? `Estimate, not an official date: your renewal may be due around ${formatLongDate(date)}. A letter about your renewal has the real date.`
    : `You told us your renewal is due on ${formatLongDate(date)}.`;
  const next = "Check your mail for letters about your renewal and answer them right away.";
  return `${what}\n${next} ${CALENDAR_TRACKER_POINTER}`;
}

/** The alert line (no program name: alerts show on lock screens). */
export function calendarAlarmText(date: CalendarDate, fromEstimate: boolean): string {
  return fromEstimate
    ? `Your renewal may be due around ${formatLongDate(date)} (estimate).`
    : `You told us your renewal is due on ${formatLongDate(date)}.`;
}

/** Every fixed string above, for the honesty scan. */
export const STATIC_RENEWAL_COPY: readonly string[] = [
  ...Object.values(DATE_CHOICE_LABELS),
  DATE_CHOICE_LEGEND,
  DATE_CHOICE_HELP,
  DATE_FIELD_LABEL,
  DATE_FIELD_HELP,
  ageQuestionLegend(),
  AGE_QUESTION_HELP,
  SECTION_HEADING,
  NO_DATE_INTRO,
  UNKNOWN_DATE_NOTE,
  PRIVACY_NOTE,
  BROWSER_CAN_CLEAR_NOTE,
  STORAGE_UNAVAILABLE_NOTE,
  LOADING_NOTE,
  NOSCRIPT_NOTE,
  SAVE_BUTTON,
  DOWNLOAD_BUTTON,
  CHANGE_BUTTON,
  REMOVE_BUTTON,
  savedNotice("renewal_due"),
  savedNotice("approval"),
  REMOVED_NOTICE,
  DOWNLOADED_NOTICE,
  DOWNLOAD_FAILED_NOTICE,
  DISCARDED_NOTICE,
  UNSUPPORTED_NOTICE,
  SAVE_FAILED_NOTICE,
  REMOVE_FAILED_NOTICE,
  UNREADABLE_BANNER_MESSAGE,
  ERROR_CHOOSE_KIND,
  ERROR_INVALID_DATE,
  ERROR_APPROVAL_IN_FUTURE,
  ESTIMATE_EXPLAINER,
  ONE_ESTIMATE_EXPLAINER,
  NO_ESTIMATE_NOTE,
  STALE_ESTIMATE_NOTE,
  PASSED_ADVICE,
  PASSED_ESTIMATE_ADVICE,
  IF_COVERAGE_ENDS_HEADING,
  OPEN_TRACKER_LINK,
  TRACKER_LINK_HEADING,
  TRACKER_LINK_TEXT,
  PAGE_TITLE,
  calendarSummary(false),
  calendarSummary(true),
  CALENDAR_TRACKER_POINTER,
  ...Object.values(FACTS_SUBHEADINGS),
];
