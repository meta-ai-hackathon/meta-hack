import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  addDays,
  addMonthsClamped,
  calendarDateInTimeZone,
  compareDates,
  daysBetween,
  daysInMonth,
  deviceLocalMoment,
  deviceTimeZone,
  deviceToday,
  formatIsoDate,
  formatLongDate,
  fromEpochDay,
  isLeapYear,
  isValidCalendarDate,
  localMomentFromDateGetters,
  localMomentInTimeZone,
  msUntilNextLocalMidnight,
  parseIsoDate,
  toEpochDay,
  type CalendarDate,
} from "./calendar-date";

// Calendar-date math for the renewal tracker (HACK-50). Dates are pure
// (year, month, day) values; these properties pin the arithmetic against
// independent oracles (Date.UTC for epoch days, a month-length table for
// validity), and the fixtures pin the cases that matter for renewals:
// month ends, leap days, the 2027 year boundary, and DST in Charlotte.

/** Independent oracle: month lengths from a table, not from the module. */
function oracleDaysInMonth(year: number, month: number): number {
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
}

/** Any real calendar date in the given years, built directly (no filtering). */
function dateIn(minYear: number, maxYear: number): fc.Arbitrary<CalendarDate> {
  return fc
    .record({
      year: fc.integer({ min: minYear, max: maxYear }),
      month: fc.integer({ min: 1, max: 12 }),
      dayIndex: fc.integer({ min: 0, max: 30 }),
    })
    .map(({ year, month, dayIndex }) => ({
      year,
      month,
      day: 1 + (dayIndex % oracleDaysInMonth(year, month)),
    }));
}

const anyDate = dateIn(1, 9999);

/** Dates in the range renewals actually use, where Date.UTC is exact. */
const nearDate: fc.Arbitrary<CalendarDate> = fc
  .integer({ min: toEpochDay({ year: 1990, month: 1, day: 1 }), max: toEpochDay({ year: 2150, month: 12, day: 31 }) })
  .map(fromEpochDay);

const d = (year: number, month: number, day: number): CalendarDate => ({ year, month, day });

describe("epoch days", () => {
  it("round-trips every real date in years 1..9999", () => {
    fc.assert(
      fc.property(anyDate, (date) => {
        expect(fromEpochDay(toEpochDay(date))).toEqual(date);
      }),
      { numRuns: 500 },
    );
  });

  it("agrees with Date.UTC (an independent oracle) for years 100..9999", () => {
    // Date.UTC maps years 0-99 onto 1900-1999, so the oracle starts at 100.
    fc.assert(
      fc.property(dateIn(100, 9999), (date) => {
        const utc = Date.UTC(date.year, date.month - 1, date.day) / 86_400_000;
        expect(toEpochDay(date)).toBe(utc);
      }),
      { numRuns: 500 },
    );
  });

  it("anchors 1970-01-01 at zero and counts a leap year as 366 days", () => {
    expect(toEpochDay(d(1970, 1, 1))).toBe(0);
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 9998 }), (year) => {
        expect(daysBetween(d(year, 1, 1), d(year + 1, 1, 1))).toBe(isLeapYear(year) ? 366 : 365);
      }),
    );
  });

  it("addDays and daysBetween are inverses", () => {
    fc.assert(
      fc.property(nearDate, fc.integer({ min: -2000, max: 2000 }), (date, days) => {
        const moved = addDays(date, days);
        expect(isValidCalendarDate(moved)).toBe(true);
        expect(daysBetween(date, moved)).toBe(days);
        expect(Math.sign(compareDates(moved, date))).toBe(Math.sign(days));
      }),
    );
  });
});

describe("leap years and month lengths", () => {
  it("follows the Gregorian rule, including centuries", () => {
    expect([2024, 2028, 2000, 2400].map(isLeapYear)).toEqual([true, true, true, true]);
    expect([2026, 2027, 1900, 2100].map(isLeapYear)).toEqual([false, false, false, false]);
  });

  it("matches the oracle table for every month", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 9999 }), fc.integer({ min: 1, max: 12 }), (year, month) => {
        expect(daysInMonth(year, month)).toBe(oracleDaysInMonth(year, month));
      }),
    );
  });
});

describe("addMonthsClamped", () => {
  it("moves exactly the asked number of months and clamps the day", () => {
    fc.assert(
      fc.property(nearDate, fc.integer({ min: -48, max: 48 }), (date, months) => {
        const moved = addMonthsClamped(date, months);
        expect(isValidCalendarDate(moved)).toBe(true);
        expect(moved.year * 12 + moved.month - (date.year * 12 + date.month)).toBe(months);
        expect(moved.day).toBe(Math.min(date.day, oracleDaysInMonth(moved.year, moved.month)));
      }),
    );
  });

  it("is strictly increasing in the number of months", () => {
    fc.assert(
      fc.property(
        nearDate,
        fc.integer({ min: -24, max: 24 }),
        fc.integer({ min: 1, max: 24 }),
        (date, months, more) => {
          expect(compareDates(addMonthsClamped(date, months), addMonthsClamped(date, months + more))).toBe(-1);
        },
      ),
    );
  });

  it("never lands later than the same day-of-month would (clamps earlier, never rolls over)", () => {
    fc.assert(
      fc.property(nearDate, fc.integer({ min: 1, max: 24 }), (date, months) => {
        const moved = addMonthsClamped(date, months);
        expect(moved.day).toBeLessThanOrEqual(date.day);
      }),
    );
  });

  it("handles the month ends a renewal can hit", () => {
    expect(addMonthsClamped(d(2027, 1, 31), 1)).toEqual(d(2027, 2, 28));
    expect(addMonthsClamped(d(2028, 1, 31), 1)).toEqual(d(2028, 2, 29));
    expect(addMonthsClamped(d(2026, 8, 31), 6)).toEqual(d(2027, 2, 28));
    expect(addMonthsClamped(d(2027, 8, 31), 6)).toEqual(d(2028, 2, 29));
    expect(addMonthsClamped(d(2027, 3, 31), 6)).toEqual(d(2027, 9, 30));
    expect(addMonthsClamped(d(2026, 12, 31), 12)).toEqual(d(2027, 12, 31));
    expect(addMonthsClamped(d(2026, 7, 15), 6)).toEqual(d(2027, 1, 15));
  });

  it("moves a leap day to February 28 in a common year and keeps it in a leap year", () => {
    expect(addMonthsClamped(d(2028, 2, 29), 12)).toEqual(d(2029, 2, 28));
    expect(addMonthsClamped(d(2028, 2, 29), 6)).toEqual(d(2028, 8, 29));
    expect(addMonthsClamped(d(2028, 2, 29), 48)).toEqual(d(2032, 2, 29));
  });
});

describe("ISO dates", () => {
  it("parses exactly the real calendar dates", () => {
    const raw = fc.record({
      year: fc.integer({ min: 1, max: 9999 }),
      month: fc.integer({ min: 0, max: 13 }),
      day: fc.integer({ min: 0, max: 32 }),
    });
    fc.assert(
      fc.property(raw, ({ year, month, day }) => {
        const text = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
        const real = month >= 1 && month <= 12 && day >= 1 && day <= oracleDaysInMonth(year, month);
        expect(parseIsoDate(text)).toEqual(real ? { year, month, day } : null);
      }),
      { numRuns: 500 },
    );
  });

  it("round-trips through formatIsoDate", () => {
    fc.assert(
      fc.property(anyDate, (date) => {
        expect(parseIsoDate(formatIsoDate(date))).toEqual(date);
      }),
    );
  });

  it("rejects near misses", () => {
    for (const text of ["2027-1-01", "2027-01-1", " 2027-01-01", "2027-01-01T00:00", "27-01-01", "2027/01/01", "0000-01-01", "2027-02-29"]) {
      expect(parseIsoDate(text), text).toBeNull();
    }
  });

  it("formats plain-language dates", () => {
    expect(formatLongDate(d(2027, 1, 1))).toBe("January 1, 2027");
    expect(formatLongDate(d(2028, 2, 29))).toBe("February 29, 2028");
  });
});

describe("calendarDateInTimeZone: what 'today' is on the device", () => {
  const charlotte = "America/New_York";
  const at = (iso: string) => new Date(iso);

  it("puts the New Year's Eve evening in Charlotte on December 31, whatever UTC says", () => {
    expect(calendarDateInTimeZone(at("2027-01-01T04:59:59Z"), charlotte)).toEqual(d(2026, 12, 31));
    expect(calendarDateInTimeZone(at("2027-01-01T05:00:00Z"), charlotte)).toEqual(d(2027, 1, 1));
    expect(calendarDateInTimeZone(at("2027-01-01T04:59:59Z"), "UTC")).toEqual(d(2027, 1, 1));
  });

  it("rolls the date at local midnight on both sides of the DST changes", () => {
    // Spring forward 2027-03-14: local midnight after it is 04:00Z (EDT).
    expect(calendarDateInTimeZone(at("2027-03-15T03:59:59Z"), charlotte)).toEqual(d(2027, 3, 14));
    expect(calendarDateInTimeZone(at("2027-03-15T04:00:00Z"), charlotte)).toEqual(d(2027, 3, 15));
    // Fall back 2026-11-01: local midnight after it is 05:00Z (EST).
    expect(calendarDateInTimeZone(at("2026-11-02T04:59:59Z"), charlotte)).toEqual(d(2026, 11, 1));
    expect(calendarDateInTimeZone(at("2026-11-02T05:00:00Z"), charlotte)).toEqual(d(2026, 11, 2));
  });

  it("handles the zones furthest from UTC", () => {
    expect(calendarDateInTimeZone(at("2026-12-31T10:00:00Z"), "Pacific/Kiritimati")).toEqual(d(2027, 1, 1));
    expect(calendarDateInTimeZone(at("2027-01-01T10:59:59Z"), "Pacific/Pago_Pago")).toEqual(d(2026, 12, 31));
  });

  it("equals the UTC date in UTC and stays within one day of it anywhere", () => {
    const instant = fc
      .integer({ min: Date.UTC(1990, 0, 1), max: Date.UTC(2150, 0, 1) })
      .map((ms) => new Date(ms));
    const zone = fc.constantFrom(
      "UTC",
      charlotte,
      "America/Los_Angeles",
      "Pacific/Kiritimati",
      "Pacific/Pago_Pago",
      "Asia/Kolkata",
      "Australia/Lord_Howe",
    );
    fc.assert(
      fc.property(instant, zone, (moment, timeZone) => {
        const utcDate = d(moment.getUTCFullYear(), moment.getUTCMonth() + 1, moment.getUTCDate());
        const local = calendarDateInTimeZone(moment, timeZone);
        if (timeZone === "UTC") {
          expect(local).toEqual(utcDate);
        }
        expect(Math.abs(daysBetween(utcDate, local))).toBeLessThanOrEqual(1);
      }),
      { numRuns: 300 },
    );
  });
});

describe("the device's local moment (review fix: an unknown zone never stalls the tracker)", () => {
  const instant = fc
    .integer({ min: Date.UTC(1990, 0, 1), max: Date.UTC(2150, 0, 1) })
    .map((ms) => new Date(ms));

  it("reads the wall-clock minutes in a zone: exactly the UTC clock in UTC", () => {
    fc.assert(
      fc.property(instant, (moment) => {
        const local = localMomentInTimeZone(moment, "UTC");
        expect(local.minutes).toBe(moment.getUTCHours() * 60 + moment.getUTCMinutes());
        expect(local.date).toEqual(d(moment.getUTCFullYear(), moment.getUTCMonth() + 1, moment.getUTCDate()));
      }),
      { numRuns: 300 },
    );
    // 11:30 PM on New Year's Eve in Charlotte is 04:30Z the next day.
    expect(localMomentInTimeZone(new Date("2027-01-01T04:30:00Z"), "America/New_York")).toEqual({
      date: d(2026, 12, 31),
      minutes: 23 * 60 + 30,
    });
    // Midnight is minute 0, never "24:00".
    expect(localMomentInTimeZone(new Date("2027-01-01T05:00:00Z"), "America/New_York").minutes).toBe(0);
  });

  it("throws for a zone the runtime does not know", () => {
    expect(() => localMomentInTimeZone(new Date(0), "Etc/Unknown")).toThrow(RangeError);
  });

  it("falls back to the runtime's local clock when the zone is unknown, unusable, or the lookup throws", () => {
    const unusable: (() => string | undefined)[] = [
      () => undefined,
      () => "Etc/Unknown",
      () => "Not/A_Zone",
      () => {
        throw new Error("no Intl here");
      },
    ];
    fc.assert(
      fc.property(instant, fc.constantFrom(...unusable), (moment, zoneOf) => {
        expect(deviceLocalMoment(moment, zoneOf)).toEqual(localMomentFromDateGetters(moment));
        expect(deviceToday(moment, zoneOf)).toEqual(localMomentFromDateGetters(moment).date);
      }),
      { numRuns: 200 },
    );
  });

  it("uses the named zone whenever it is usable", () => {
    fc.assert(
      fc.property(instant, fc.constantFrom("UTC", "America/New_York", "Pacific/Kiritimati"), (moment, zone) => {
        expect(deviceLocalMoment(moment, () => zone)).toEqual(localMomentInTimeZone(moment, zone));
      }),
      { numRuns: 200 },
    );
  });

  it("reports only a zone this runtime can format in", () => {
    const zone = deviceTimeZone();
    if (zone !== undefined) {
      expect(() => localMomentInTimeZone(new Date(), zone)).not.toThrow();
    }
    expect(() => deviceToday()).not.toThrow();
  });

  it("schedules the next check for the next local midnight, never sooner than a second", () => {
    fc.assert(
      fc.property(instant, (moment) => {
        const local = localMomentInTimeZone(moment, "UTC");
        const wait = msUntilNextLocalMidnight(moment, local);
        expect(wait).toBeGreaterThanOrEqual(1000);
        expect(wait).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
        // In UTC (no clock changes) the wait lands on the next day's midnight,
        // or within the one-second floor of it.
        const after = new Date(moment.getTime() + wait);
        const nextDay = addDays(local.date, 1);
        const landed = localMomentInTimeZone(after, "UTC");
        expect(landed.date).toEqual(nextDay);
        expect(landed.minutes).toBe(0);
      }),
      { numRuns: 300 },
    );
  });
});
