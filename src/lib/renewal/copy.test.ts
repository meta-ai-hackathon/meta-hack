import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { findBannedClaims } from "../honesty";
import { addDays, formatLongDate, fromEpochDay, parseIsoDate, toEpochDay, type CalendarDate } from "./calendar-date";
import {
  DATE_CHOICE_HELP,
  CALENDAR_TRACKER_POINTER,
  DATE_CHOICE_LABELS,
  DOWNLOADED_NOTICE,
  DOWNLOAD_FAILED_NOTICE,
  KEEP_SAVED_BUTTON,
  NO_DATE_INTRO,
  PRIVACY_NOTE,
  REMOVE_FAILED_NOTICE,
  PASSED_BANNER_NOTE,
  SAVE_CHANGED_NOTICE,
  STATIC_RENEWAL_COPY,
  UNKNOWN_DATE_NOTE,
  UNKNOWN_DATE_WHILE_SAVED_NOTE,
  ageAnswerSentence,
  ageChoiceLabels,
  ageLeftOutNote,
  bannerMessage,
  calendarAlarmText,
  calendarDescription,
  calendarSummary,
  entryStatusFlag,
  estimateSentence,
  factsHeading,
  factsIntro,
  originLabel,
  pageIntro,
  reminderMessage,
  reportedDateSentence,
  savedNotice,
  unknownDateNote,
} from "./copy";
import { AGE_ANSWERS } from "./estimate";
import type { ReminderPhase } from "./reminder";
import { PILOT_RENEWAL_FACTS } from "./renewal-facts";

// The honesty gate on every renewal sentence (HACK-50). All copy, fixed and
// generated, passes the banned-claim detector (BN-05), a renewal "may be
// due" unless the person told us the date, estimates always say so, and
// the poisoned fixtures prove the gate bites on renewal-shaped promises.

const PROGRAM = PILOT_RENEWAL_FACTS.programName;
const d = (iso: string): CalendarDate => parseIsoDate(iso)!;

const anyDay = fc
  .integer({ min: toEpochDay(d("2000-01-01")), max: toEpochDay(d("2100-12-31")) })
  .map(fromEpochDay);
const phase = fc.constantFrom<ReminderPhase>("later", "soon", "today", "passed");
const programName = fc.constantFrom(PROGRAM, "the program", "Program X");

/** Renewal promises the copy must never make: every one is caught. */
const POISONED_RENEWAL_COPY = [
  "You will stay covered as long as you renew on time.",
  "You'll stay eligible after this renewal.",
  "You'll keep your coverage after you renew.",
  "You won't lose your health coverage.",
  "Your renewal will be approved.",
  "Your coverage will continue after you renew.",
  "You are eligible to renew online.",
  "You will be approved again this year.",
  "Renewal is guaranteed.",
];

const RANGE = { min: 19, max: 64 };

function generatedCopy(name: string, date: CalendarDate, days: number, which: ReminderPhase): string[] {
  const daysUntil = which === "today" ? 0 : which === "passed" ? -Math.max(1, days) : Math.max(1, days);
  const status = { phase: which, target: date, daysUntil };
  // A passed estimate with a later one still ahead (review fix).
  const passedWithNext = { phase: "passed" as const, target: date, daysUntil: -Math.max(1, days), next: addDays(date, 180) };
  return [
    originLabel("official", name),
    originLabel("user", name),
    originLabel("estimate", name),
    reportedDateSentence("renewal_due", date),
    reportedDateSentence("approval", date),
    estimateSentence("Every 6 months", date),
    estimateSentence("Once a year", date),
    reminderMessage(status, true),
    reminderMessage(status, false),
    reminderMessage(passedWithNext, true),
    bannerMessage(status, true),
    bannerMessage(status, false),
    bannerMessage(passedWithNext, true),
    calendarSummary(true),
    calendarSummary(false),
    calendarDescription(date, true),
    calendarDescription(date, false),
    calendarAlarmText(date, true),
    calendarAlarmText(date, false),
    pageIntro(name),
    factsHeading(name),
    factsIntro(name),
    entryStatusFlag("stale", "The page changed."),
    entryStatusFlag("withdrawn", undefined),
    ...Object.values(ageChoiceLabels(RANGE)),
    ...AGE_ANSWERS.map((answer) => ageAnswerSentence({ ...RANGE, answer })),
    ageLeftOutNote("Every 6 months", RANGE),
    savedNotice("renewal_due"),
    savedNotice("approval"),
  ];
}

describe("renewal copy passes the banned-claim gate", () => {
  it("every fixed string", () => {
    for (const text of STATIC_RENEWAL_COPY) {
      expect(findBannedClaims(text), text).toEqual([]);
    }
    expect(STATIC_RENEWAL_COPY.length).toBeGreaterThan(30);
  });

  it("every generated sentence, for any program name, date, and reminder state", () => {
    fc.assert(
      fc.property(programName, anyDay, fc.integer({ min: 1, max: 400 }), phase, (name, date, days, which) => {
        for (const text of generatedCopy(name, date, days, which)) {
          expect(findBannedClaims(text), text).toEqual([]);
        }
      }),
      { numRuns: 300 },
    );
  });

  it("every knowledge-base fact the tracker renders", () => {
    const facts = PILOT_RENEWAL_FACTS;
    const texts = [
      ...facts.schedules.flatMap((item) => [item.label, item.appliesTo]),
      ...facts.keyDates.map((item) => item.label),
      ...facts.deadlineNotes.map((item) => `${item.label}: ${item.due}`),
      ...facts.rules.map((item) => item.text),
      ...facts.documents.map((item) => item.text),
      ...facts.steps.map((item) => item.text),
      ...facts.ifCoverageEnds.map((item) => item.text),
      ...facts.links.map((item) => item.label),
    ];
    expect(facts.ifCoverageEnds.length).toBeGreaterThan(0);
    for (const text of texts) {
      expect(findBannedClaims(text), text).toEqual([]);
    }
  });

  it("bites: every poisoned renewal fixture is flagged", () => {
    for (const text of POISONED_RENEWAL_COPY) {
      expect(findBannedClaims(text).length, text).toBeGreaterThan(0);
    }
  });
});

describe("renewal copy stays hedged and labeled", () => {
  it("never says the program itself carries on or that the person keeps it", () => {
    const promise = new RegExp(
      `(keep|keeps|kept)\\s+(your\\s+)?${PROGRAM}|${PROGRAM}\\s+(will|'ll)\\s+(continue|renew|stay)|stay(s)?\\s+(eligible|covered|enrolled)`,
      "i",
    );
    fc.assert(
      fc.property(anyDay, fc.integer({ min: 1, max: 400 }), phase, (date, days, which) => {
        for (const text of [...STATIC_RENEWAL_COPY, ...generatedCopy(PROGRAM, date, days, which)]) {
          expect(promise.test(text), text).toBe(false);
        }
      }),
    );
  });

  it("says an estimate is an estimate, and a reported date is what the person told us", () => {
    fc.assert(
      fc.property(anyDay, fc.integer({ min: 1, max: 400 }), phase, (date, days, which) => {
        const daysUntil = which === "today" ? 0 : which === "passed" ? -days : days;
        const status = { phase: which, target: date, daysUntil };
        const estimate = reminderMessage(status, true);
        const reported = reminderMessage(status, false);
        expect(/estimate|may be due/i.test(estimate), estimate).toBe(true);
        expect(/\bis due\b/i.test(estimate), estimate).toBe(false);
        if (which === "later") {
          // Shown only in the tracker, directly under the "You told us"
          // line it refers to; it states a distance, never a new date.
          expect(reported).toMatch(/^That is \d+ days? from today\./);
        } else {
          // Banner messages stand alone, so they carry the origin themselves.
          expect(/you told us/i.test(reported), reported).toBe(true);
        }
      }),
    );
  });

  it("labels the three origins differently, using the app's own 'You told us'", () => {
    const labels = (["official", "user", "estimate"] as const).map((origin) => originLabel(origin, PROGRAM));
    expect(labels).toEqual(["From NC Medicaid", "You told us", "Estimate, not an official date"]);
    expect(new Set(labels).size).toBe(3);
  });

  it("offers an honest way out for people who do not know the date", () => {
    expect(DATE_CHOICE_LABELS.unknown).toBe("I don't know the date");
    expect(ageChoiceLabels(RANGE).unsure).toBe("I'm not sure");
  });

  it("says a saved reminder stays when the person changing it picks I don't know, and how to go back (third review fix)", () => {
    expect(unknownDateNote(false)).toBe(UNKNOWN_DATE_NOTE);
    expect(unknownDateNote(true)).toBe(UNKNOWN_DATE_WHILE_SAVED_NOTE);
    // No saved date: come back and add one any time.
    expect(UNKNOWN_DATE_NOTE).toMatch(/come back and add a date any time/);
    // A saved date being changed: it and its reminder stay until changed
    // or removed, and the note names the button that goes back to it.
    expect(UNKNOWN_DATE_WHILE_SAVED_NOTE).toMatch(/stay on this device until you change or remove them/);
    expect(UNKNOWN_DATE_WHILE_SAVED_NOTE).toContain(`choose ${KEEP_SAVED_BUTTON}.`);
    expect(UNKNOWN_DATE_WHILE_SAVED_NOTE).not.toMatch(/add a date/);
    expect(STATIC_RENEWAL_COPY).toEqual(expect.arrayContaining([UNKNOWN_DATE_WHILE_SAVED_NOTE, KEEP_SAVED_BUTTON]));
  });

  it("sends a renewal notice's deadline to the due-date choice, not the approval choice (review fix)", () => {
    expect(DATE_CHOICE_LABELS.renewal_due).toMatch(/deadline on a renewal letter or notice/);
    expect(DATE_CHOICE_LABELS.approval).toMatch(/said my coverage was approved or renewed/);
    expect(DATE_CHOICE_LABELS.approval).not.toMatch(/renewal notice/i);
    expect(DATE_CHOICE_HELP).toMatch(/renewal notice or a letter asking for more information/);
    expect(DATE_CHOICE_HELP).toMatch(/Choose the first option and enter the deadline/);
  });

  it("never names the program or links to it in a calendar title, alert, or note, and marks estimates (review fixes)", () => {
    fc.assert(
      fc.property(anyDay, (date) => {
        for (const fromEstimate of [true, false]) {
          const texts = [calendarSummary(fromEstimate), calendarAlarmText(date, fromEstimate), calendarDescription(date, fromEstimate)];
          for (const text of texts) {
            expect(text).not.toContain(PROGRAM);
            expect(text).not.toMatch(/medicaid|https?:|www\.|\.gov/i);
          }
          // Third review: the notes carry the date and a pointer back to
          // the tracker, nothing else that names where the person is enrolled.
          expect(calendarDescription(date, fromEstimate)).toContain(formatLongDate(date));
          expect(calendarDescription(date, fromEstimate)).toMatch(new RegExp(`${CALENDAR_TRACKER_POINTER}$`));
        }
        expect(calendarSummary(true)).toMatch(/\(estimate\)$/);
        expect(calendarAlarmText(date, true)).toMatch(/around .*\(estimate\)\.$/);
        expect(calendarAlarmText(date, false)).toMatch(/^You told us/);
      }),
    );
  });

  it("does not repeat the 'You told us' label in the sentence after it (review a11y fix)", () => {
    fc.assert(
      fc.property(anyDay, (date) => {
        for (const kind of ["renewal_due", "approval"] as const) {
          expect(reportedDateSentence(kind, date)).not.toMatch(/you told us/i);
        }
      }),
    );
  });

  it("never says the date goes nowhere, and says what the calendar file carries (second review fix)", () => {
    // The calendar file is a plain copy the person chooses to make, so no
    // line may say the date is never sent or never leaves the device.
    for (const text of [...STATIC_RENEWAL_COPY, pageIntro(PROGRAM)]) {
      expect(text).not.toMatch(/nothing is sent anywhere|(your date|it) stays on this device/i);
    }
    expect(NO_DATE_INTRO).toMatch(/Saving here sends nothing anywhere\.$/);
    expect(PRIVACY_NOTE).toMatch(/^This site keeps your date only on this device\./);
    // The note's claim about the file matches what the file holds: since
    // the third review its notes name no program and link nowhere.
    expect(PRIVACY_NOTE).toMatch(/its title, notes, and alerts do not name the program or link to it\./);
    expect(PRIVACY_NOTE).toMatch(/keeps its own copy of the date\.$/);
    expect(PRIVACY_NOTE).not.toMatch(/notes do/);
    const description = calendarDescription(d("2027-04-30"), false);
    expect(description).not.toContain(PROGRAM);
    expect(description).not.toMatch(/https?:/);
    expect(DOWNLOADED_NOTICE).toMatch(/The event does not name the program, so the official steps stay on this page\./);
  });

  it("says when removing the reminder fails, and how to remove it by hand (second review fix)", () => {
    expect(STATIC_RENEWAL_COPY).toContain(REMOVE_FAILED_NOTICE);
    expect(REMOVE_FAILED_NOTICE).toMatch(/^The reminder could not be removed from this device\./);
    expect(REMOVE_FAILED_NOTICE).toMatch(/clear this site's data/);
  });

  it("says when another tab changed the reminder during a save, and that saving again keeps the date (third review fix)", () => {
    expect(STATIC_RENEWAL_COPY).toContain(SAVE_CHANGED_NOTICE);
    expect(SAVE_CHANGED_NOTICE).toMatch(/^The reminder was removed or changed in another tab/);
    expect(SAVE_CHANGED_NOTICE).toMatch(/Save again to keep this date\.$/);
  });

    it("says when the calendar file cannot be made, and what to do instead (third review fix)", () => {
    expect(STATIC_RENEWAL_COPY).toContain(DOWNLOAD_FAILED_NOTICE);
    expect(DOWNLOAD_FAILED_NOTICE).toMatch(/^The calendar file could not be made in this browser\./);
    expect(DOWNLOAD_FAILED_NOTICE).toMatch(/add the date to your calendar by hand/);
  });

    it("says when the reminder starts for each kind of date (review fix: approval dates are in the past)", () => {
    expect(savedNotice("renewal_due")).toMatch(/30 days before the date/);
    expect(savedNotice("approval")).toMatch(/30 days before each estimate/);
    for (const kind of ["renewal_due", "approval"] as const) {
      expect(savedNotice(kind)).toMatch(/calendar file/);
    }
  });

  it("never names the program in a reminder line, and says how to stop a passed banner (third review, property)", () => {
    // The banner shows on every page, to anyone who uses the device, so
    // it names no program, like the calendar title. A passed date keeps it
    // speaking until the person acts, so its line says how.
    fc.assert(
      fc.property(anyDay, fc.integer({ min: 1, max: 400 }), phase, fc.boolean(), fc.boolean(), (date, days, which, fromEstimate, withNext) => {
        const daysUntil = which === "today" ? 0 : which === "passed" ? -days : days;
        const status = {
          phase: which,
          target: date,
          daysUntil,
          ...(which === "passed" && withNext ? { next: addDays(date, days + 31) } : {}),
        };
        const banner = bannerMessage(status, fromEstimate);
        for (const text of [banner, reminderMessage(status, fromEstimate)]) {
          expect(text).not.toContain(PROGRAM);
          expect(text).not.toMatch(/medicaid/i);
        }
        expect(banner.startsWith(reminderMessage(status, fromEstimate))).toBe(true);
        expect(banner.endsWith(` ${PASSED_BANNER_NOTE}`)).toBe(which === "passed");
      }),
    );
    expect(PASSED_BANNER_NOTE).toBe(
      "If your renewal is done, you can change the date or remove this reminder in your renewal tracker.",
    );
    expect(STATIC_RENEWAL_COPY).toContain(PASSED_BANNER_NOTE);
  });

  it("names the next estimate once an earlier one has passed, and never calls it the earliest", () => {
    fc.assert(
      fc.property(anyDay, fc.integer({ min: 1, max: 400 }), fc.integer({ min: 31, max: 400 }), (date, ago, ahead) => {
        const next = addDays(date, ago + ahead);
        const message = reminderMessage({ phase: "passed", target: date, daysUntil: -ago, next }, true);
        expect(message).toMatch(/has passed\. The next estimate is /);
        const later = reminderMessage({ phase: "later", target: next, daysUntil: ahead }, true);
        expect(later).toMatch(/^The next estimate is/);
        expect(`${message} ${later}`).not.toMatch(/earliest/i);
      }),
    );
  });
});
