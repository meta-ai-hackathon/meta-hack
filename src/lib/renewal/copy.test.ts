import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { findBannedClaims } from "../honesty";
import { addDays, fromEpochDay, parseIsoDate, toEpochDay, type CalendarDate } from "./calendar-date";
import {
  DATE_CHOICE_HELP,
  DATE_CHOICE_LABELS,
  NO_DATE_INTRO,
  PRIVACY_NOTE,
  STATIC_RENEWAL_COPY,
  ageAnswerSentence,
  ageChoiceLabels,
  ageLeftOutNote,
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
    reminderMessage(status, name, true),
    reminderMessage(status, name, false),
    reminderMessage(passedWithNext, name, true),
    calendarSummary(true),
    calendarSummary(false),
    calendarDescription(name, date, true, "https://medicaid.ncdhhs.gov/medicaid-recertification"),
    calendarDescription(name, date, false, undefined),
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
        const estimate = reminderMessage(status, PROGRAM, true);
        const reported = reminderMessage(status, PROGRAM, false);
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

  it("sends a renewal notice's deadline to the due-date choice, not the approval choice (review fix)", () => {
    expect(DATE_CHOICE_LABELS.renewal_due).toMatch(/deadline on a renewal letter or notice/);
    expect(DATE_CHOICE_LABELS.approval).toMatch(/said my coverage was approved or renewed/);
    expect(DATE_CHOICE_LABELS.approval).not.toMatch(/renewal notice/i);
    expect(DATE_CHOICE_HELP).toMatch(/renewal notice or a letter asking for more information/);
    expect(DATE_CHOICE_HELP).toMatch(/Choose the first option and enter the deadline/);
  });

  it("never names the program in a calendar title or alert, and marks estimates (review fix)", () => {
    fc.assert(
      fc.property(anyDay, (date) => {
        for (const fromEstimate of [true, false]) {
          for (const text of [calendarSummary(fromEstimate), calendarAlarmText(date, fromEstimate)]) {
            expect(text).not.toContain(PROGRAM);
            expect(text).not.toMatch(/medicaid/i);
          }
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
    // The note's claim about the file's notes matches what the file holds.
    expect(PRIVACY_NOTE).toMatch(/its notes do, with a link to the official page/);
    expect(PRIVACY_NOTE).toMatch(/keeps its own copy of the date and the notes/);
    const description = calendarDescription(PROGRAM, d("2027-04-30"), false, "https://medicaid.ncdhhs.gov/medicaid-recertification");
    expect(description).toContain(PROGRAM);
    expect(description).toContain("https://medicaid.ncdhhs.gov/");
  });

  it("says when the reminder starts for each kind of date (review fix: approval dates are in the past)", () => {
    expect(savedNotice("renewal_due")).toMatch(/30 days before the date/);
    expect(savedNotice("approval")).toMatch(/30 days before each estimate/);
    for (const kind of ["renewal_due", "approval"] as const) {
      expect(savedNotice(kind)).toMatch(/calendar file/);
    }
  });

  it("names the next estimate once an earlier one has passed, and never calls it the earliest", () => {
    fc.assert(
      fc.property(anyDay, fc.integer({ min: 1, max: 400 }), fc.integer({ min: 31, max: 400 }), (date, ago, ahead) => {
        const next = addDays(date, ago + ahead);
        const message = reminderMessage({ phase: "passed", target: date, daysUntil: -ago, next }, PROGRAM, true);
        expect(message).toMatch(/has passed\. The next estimate is /);
        const later = reminderMessage({ phase: "later", target: next, daysUntil: ahead }, PROGRAM, true);
        expect(later).toMatch(/^The next estimate is/);
        expect(`${message} ${later}`).not.toMatch(/earliest/i);
      }),
    );
  });
});
