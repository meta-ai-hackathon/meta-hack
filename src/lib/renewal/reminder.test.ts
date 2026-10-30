import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  addDays,
  compareDates,
  daysBetween,
  formatIsoDate,
  fromEpochDay,
  localMomentInTimeZone,
  parseIsoDate,
  toEpochDay,
  type CalendarDate,
} from "./calendar-date";
import { AGE_ANSWERS } from "./estimate";
import {
  CALENDAR_ID_RE,
  MAX_REMINDER_REVISION,
  REMINDER_WINDOW_DAYS,
  RENEWAL_REMINDER_VERSION,
  bannerIsDue,
  newCalendarId,
  parseReportedDate,
  reminderDates,
  reminderStatus,
  validateReminder,
} from "./reminder";
import { PILOT_RENEWAL_FACTS } from "./renewal-facts";

// The in-app reminder trigger (HACK-50): a banner from 30 days before a
// date, on the day, and from the moment any date has passed until the
// person changes it; nothing earlier.

const d = (iso: string): CalendarDate => parseIsoDate(iso)!;
const ENTRY_ID = PILOT_RENEWAL_FACTS.entryId;
const SCHEDULES = PILOT_RENEWAL_FACTS.schedules;
const CALENDAR_ID = "0123456789abcdef0123456789abcdef";

const day = fc
  .integer({ min: toEpochDay(d("2024-01-01")), max: toEpochDay(d("2032-12-31")) })
  .map(fromEpochDay);
const dates = fc.array(day, { minLength: 1, maxLength: 4 });

describe("reminderStatus: the 30-day window", () => {
  const target = d("2027-04-30");
  const statusOn = (today: string) => reminderStatus(d(today), [target]);

  it("stays quiet 31 days out and speaks from 30 days out", () => {
    expect(statusOn("2027-03-30")).toMatchObject({ phase: "later", daysUntil: 31 });
    expect(statusOn("2027-03-31")).toMatchObject({ phase: "soon", daysUntil: REMINDER_WINDOW_DAYS });
    expect(statusOn("2027-04-29")).toMatchObject({ phase: "soon", daysUntil: 1 });
    expect(statusOn("2027-04-30")).toMatchObject({ phase: "today", daysUntil: 0 });
    expect(statusOn("2027-05-01")).toMatchObject({ phase: "passed", daysUntil: -1 });
    expect(bannerIsDue(statusOn("2027-03-30"))).toBe(false);
    expect(bannerIsDue(statusOn("2027-03-31"))).toBe(true);
    expect(bannerIsDue(statusOn("2027-05-01"))).toBe(true);
  });

  it("has nothing to say without dates", () => {
    expect(reminderStatus(d("2027-01-01"), [])).toBeNull();
    expect(bannerIsDue(null)).toBe(false);
  });

  it("lets the device's zone decide the day at the window edge", () => {
    // 10 PM on March 30 in Charlotte is already March 31 in UTC.
    const instant = new Date("2027-03-31T02:00:00Z");
    const charlotte = reminderStatus(localMomentInTimeZone(instant, "America/New_York").date, [target]);
    const utc = reminderStatus(localMomentInTimeZone(instant, "UTC").date, [target]);
    expect(charlotte).toMatchObject({ phase: "later", daysUntil: 31 });
    expect(utc).toMatchObject({ phase: "soon", daysUntil: 30 });
  });

  it("is due exactly when a date is inside the window or any date has passed", () => {
    // Review fix: before, a passed date was ignored while a later date was
    // still more than 30 days out, so the banner went quiet for months.
    fc.assert(
      fc.property(day, dates, (today, list) => {
        const status = reminderStatus(today, list)!;
        const anyPassed = list.some((date) => compareDates(date, today) < 0);
        const anyInWindow = list.some((date) => {
          const away = daysBetween(today, date);
          return away >= 0 && away <= REMINDER_WINDOW_DAYS;
        });
        expect(bannerIsDue(status)).toBe(anyPassed || anyInWindow);
      }),
      { numRuns: 500 },
    );
  });

  it("names the right date in every phase", () => {
    fc.assert(
      fc.property(day, dates, (today, list) => {
        const status = reminderStatus(today, list)!;
        const sorted = [...list].sort(compareDates);
        const upcoming = sorted.filter((date) => compareDates(date, today) >= 0);
        const passed = sorted.filter((date) => compareDates(date, today) < 0);
        expect(list).toContainEqual(status.target);
        expect(status.daysUntil).toBe(daysBetween(today, status.target));
        switch (status.phase) {
          case "today":
            expect(status.target).toEqual(today);
            break;
          case "soon":
            expect(status.target).toEqual(upcoming[0]);
            expect(status.daysUntil).toBeGreaterThanOrEqual(1);
            expect(status.daysUntil).toBeLessThanOrEqual(REMINDER_WINDOW_DAYS);
            break;
          case "later":
            expect(passed).toEqual([]);
            expect(status.target).toEqual(upcoming[0]);
            expect(status.daysUntil).toBeGreaterThan(REMINDER_WINDOW_DAYS);
            break;
          case "passed":
            // The most recent passed date, and the next date still ahead.
            expect(status.target).toEqual(passed.at(-1));
            expect(status.daysUntil).toBeLessThan(0);
            expect(status.next).toEqual(upcoming[0]);
            break;
        }
        if (status.phase !== "passed") {
          expect(status.next).toBeUndefined();
        }
        // A date today always wins: the person hears "today", not "passed".
        expect(status.phase === "today").toBe(list.some((date) => compareDates(date, today) === 0));
      }),
      { numRuns: 500 },
    );
  });

  it("never goes quiet once the first reminder window opens", () => {
    fc.assert(
      fc.property(dates, fc.integer({ min: 0, max: 2000 }), (list, offset) => {
        const first = [...list].sort(compareDates)[0]!;
        const today = addDays(first, offset - REMINDER_WINDOW_DAYS);
        expect(bannerIsDue(reminderStatus(today, list))).toBe(true);
      }),
      { numRuns: 400 },
    );
  });

  it("depends only on the distance between days (month, year, and leap boundaries included)", () => {
    fc.assert(
      fc.property(day, dates, fc.integer({ min: -4000, max: 4000 }), (today, list, shift) => {
        const before = reminderStatus(today, list)!;
        const after = reminderStatus(
          addDays(today, shift),
          list.map((date) => addDays(date, shift)),
        )!;
        expect(after.phase).toBe(before.phase);
        expect(after.daysUntil).toBe(before.daysUntil);
        expect(after.target).toEqual(addDays(before.target, shift));
        expect(after.next).toEqual(before.next ? addDays(before.next, shift) : undefined);
      }),
    );
  });

  it("keeps an approval date's reminder speaking after the first estimate passes (the review's timeline)", () => {
    // Approval 2026-07-01: estimates 2027-01-01 (6 months) and 2027-07-01 (yearly).
    const list = reminderDates({ kind: "approval", reportedDate: "2026-07-01" }, SCHEDULES);
    expect(list.map(formatIsoDate)).toEqual(["2027-01-01", "2027-07-01"]);
    const on = (iso: string) => reminderStatus(d(iso), list)!;
    expect(on("2026-12-15")).toMatchObject({ phase: "soon", target: d("2027-01-01") });
    expect(on("2027-01-01")).toMatchObject({ phase: "today", target: d("2027-01-01") });
    expect(on("2027-01-15")).toMatchObject({ phase: "passed", target: d("2027-01-01"), next: d("2027-07-01") });
    expect(on("2027-04-01")).toMatchObject({ phase: "passed", target: d("2027-01-01"), next: d("2027-07-01") });
    expect(on("2027-06-15")).toMatchObject({ phase: "soon", target: d("2027-07-01") });
    expect(on("2027-07-05")).toMatchObject({ phase: "passed", target: d("2027-07-01") });
    expect(on("2027-07-05").next).toBeUndefined();
    for (let today = d("2026-12-02"); compareDates(today, d("2027-07-10")) <= 0; today = addDays(today, 1)) {
      expect(bannerIsDue(reminderStatus(today, list)), formatIsoDate(today)).toBe(true);
    }
  });
});

describe("reminderDates", () => {
  it("reminds about a reported due date exactly as given", () => {
    expect(reminderDates({ kind: "renewal_due", reportedDate: "2027-04-30" }, SCHEDULES)).toEqual([
      d("2027-04-30"),
    ]);
  });

  it("reminds about the schedule estimates for an approval date", () => {
    expect(
      reminderDates({ kind: "approval", reportedDate: "2026-10-15" }, SCHEDULES).map(formatIsoDate),
    ).toEqual(["2027-04-15", "2027-10-15"]);
  });

  it("leaves the 19-64 estimate out when the person says they are outside those ages", () => {
    const ageAnswer = { min: 19, max: 64, answer: "no" as const };
    expect(
      reminderDates({ kind: "approval", reportedDate: "2026-10-15", ageAnswer }, SCHEDULES).map(formatIsoDate),
    ).toEqual(["2027-10-15"]);
  });

  it("returns nothing for an invalid date or when no schedule applies", () => {
    expect(reminderDates({ kind: "renewal_due", reportedDate: "2027-02-30" }, SCHEDULES)).toEqual([]);
    expect(reminderDates({ kind: "approval", reportedDate: "2026-10-15" }, [])).toEqual([]);
  });
});

describe("newCalendarId", () => {
  it("is 32 lowercase hex characters from the CSPRNG, different every time", () => {
    const id = newCalendarId((array) => crypto.getRandomValues(array));
    expect(id).toMatch(CALENDAR_ID_RE);
    expect(newCalendarId((array) => crypto.getRandomValues(array))).not.toBe(id);
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 16, maxLength: 16 }), (bytes) => {
        const fixed = newCalendarId((array) => {
          array.set(bytes);
          return array;
        });
        expect(fixed).toMatch(CALENDAR_ID_RE);
        expect(Buffer.from(fixed, "hex")).toEqual(Buffer.from(bytes));
      }),
    );
  });
});

describe("validateReminder: nothing read back is trusted", () => {
  const valid = {
    version: RENEWAL_REMINDER_VERSION,
    entryId: ENTRY_ID,
    kind: "renewal_due",
    reportedDate: "2027-04-30",
    calendarId: CALENDAR_ID,
    revision: 0,
  };
  const approval = { ...valid, kind: "approval", ageAnswer: { min: 19, max: 64, answer: "no" } };

  it("accepts exactly a current-version reminder for a known entry", () => {
    expect(validateReminder(valid, [ENTRY_ID])).toEqual(valid);
    expect(validateReminder({ ...valid, kind: "approval" }, [ENTRY_ID])).toEqual({ ...valid, kind: "approval" });
    expect(validateReminder(approval, [ENTRY_ID])).toEqual(approval);
    expect(validateReminder({ ...valid, revision: MAX_REMINDER_REVISION }, [ENTRY_ID])).not.toBeNull();
  });

  it("rejects every other shape", () => {
    const rejects: unknown[] = [
      null,
      "2027-04-30",
      [valid],
      { ...valid, version: 2 },
      { ...valid, version: "1" },
      { ...valid, entryId: "someone_else" },
      { ...valid, kind: "unknown" },
      { ...valid, reportedDate: "2027-02-30" },
      { ...valid, reportedDate: "1999-12-31" },
      { ...valid, reportedDate: "2101-01-01" },
      { ...valid, reportedDate: " 2027-04-30" },
      { ...valid, extra: "field" },
      { version: 1, entryId: ENTRY_ID, kind: "renewal_due", reportedDate: "2027-04-30" },
      { ...valid, calendarId: "ABCDEF0123456789abcdef0123456789" },
      { ...valid, calendarId: CALENDAR_ID.slice(1) },
      { ...valid, revision: -1 },
      { ...valid, revision: 1.5 },
      { ...valid, revision: MAX_REMINDER_REVISION + 1 },
      // An age answer only shapes estimates, so a due date never carries one.
      { ...valid, ageAnswer: { min: 19, max: 64, answer: "no" } },
      { ...approval, ageAnswer: undefined },
      { ...approval, ageAnswer: { min: 19, max: 64, answer: "maybe" } },
      { ...approval, ageAnswer: { min: 65, max: 64, answer: "no" } },
      { ...approval, ageAnswer: { min: 19, max: 131, answer: "no" } },
      { ...approval, ageAnswer: { min: 19, answer: "no" } },
      { ...approval, ageAnswer: { min: 19, max: 64, answer: "no", age: 70 } },
    ];
    for (const raw of rejects) {
      expect(validateReminder(raw, [ENTRY_ID]), JSON.stringify(raw)).toBeNull();
    }
  });

  it("never throws, and only passes values that are exactly valid", () => {
    fc.assert(
      fc.property(fc.anything(), (raw) => {
        const result = validateReminder(raw, [ENTRY_ID]);
        if (result !== null) {
          expect(raw).toEqual(result);
        }
      }),
      { numRuns: 300 },
    );
  });

  it("round-trips every valid reminder", () => {
    const ageAnswer = fc
      .tuple(fc.integer({ min: 0, max: 130 }), fc.integer({ min: 0, max: 130 }), fc.constantFrom(...AGE_ANSWERS))
      .map(([a, b, answer]) => ({ min: Math.min(a, b), max: Math.max(a, b), answer }));
    const record = fc
      .record({
        version: fc.constant(RENEWAL_REMINDER_VERSION),
        entryId: fc.constant(ENTRY_ID),
        kind: fc.constantFrom("renewal_due" as const, "approval" as const),
        reportedDate: fc
          .integer({ min: toEpochDay(d("2000-01-01")), max: toEpochDay(d("2100-12-31")) })
          .map((epochDay) => formatIsoDate(fromEpochDay(epochDay))),
        calendarId: fc.uint8Array({ minLength: 16, maxLength: 16 }).map((bytes) => Buffer.from(bytes).toString("hex")),
        revision: fc.integer({ min: 0, max: MAX_REMINDER_REVISION }),
        ageAnswer: fc.option(ageAnswer, { nil: undefined }),
      })
      .map(({ ageAnswer: answer, ...rest }) =>
        rest.kind === "approval" && answer !== undefined ? { ...rest, ageAnswer: answer } : rest,
      );
    fc.assert(
      fc.property(record, (reminder) => {
        expect(validateReminder(JSON.parse(JSON.stringify(reminder)), [ENTRY_ID])).toEqual(reminder);
      }),
    );
  });

  it("bounds reported years to 2000 through 2100", () => {
    expect(parseReportedDate("2000-01-01")).toEqual(d("2000-01-01"));
    expect(parseReportedDate("2100-12-31")).toEqual(d("2100-12-31"));
    expect(parseReportedDate("1999-12-31")).toBeNull();
    expect(parseReportedDate("2101-01-01")).toBeNull();
  });
});
