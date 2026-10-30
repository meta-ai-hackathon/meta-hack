import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { formatIsoDate, fromEpochDay, parseIsoDate, toEpochDay, type CalendarDate } from "./calendar-date";
import { findBannedClaims } from "../honesty";
import type { AgeAnswer } from "./estimate";
import { newCalendarId } from "./reminder";
import {
  DUE_DATE_EVENT_KEY,
  RENEWAL_CALENDAR_FILENAME,
  buildReminderCalendar,
  calendarEventUid,
} from "./reminder-calendar";
import { PILOT_RENEWAL_FACTS } from "./renewal-facts";

// The calendar file for a reported date (HACK-50): the reported due date
// as one event, or one event per schedule estimate for an approval date,
// with honest text, a filename that does not leak the date, and event
// identities that survive a second download or a changed date.

const d = (iso: string): CalendarDate => parseIsoDate(iso)!;
const CALENDAR_ID = "0123456789abcdef0123456789abcdef";

function unfold(text: string): string[] {
  return text.slice(0, -2).replace(/\r\n[ \t]/g, "").split("\r\n");
}

function build(
  kind: "renewal_due" | "approval",
  reportedDate: string,
  options: { today?: string; revision?: number; calendarId?: string; ageAnswer?: AgeAnswer; minutes?: number } = {},
) {
  return buildReminderCalendar({
    facts: PILOT_RENEWAL_FACTS,
    kind,
    reportedDate,
    ...(options.ageAnswer !== undefined ? { ageAnswer: options.ageAnswer } : {}),
    calendarId: options.calendarId ?? CALENDAR_ID,
    revision: options.revision ?? 0,
    now: new Date("2026-10-29T22:00:00Z"),
    today: d(options.today ?? "2026-10-29"),
    minutesIntoToday: options.minutes ?? 18 * 60,
  });
}

const linesOf = (text: string, prefix: string) => unfold(text).filter((line) => line.startsWith(prefix));

describe("buildReminderCalendar", () => {
  it("makes one all-day event on a reported due date, labeled as what the person told us", () => {
    const file = build("renewal_due", "2027-04-30")!;
    expect(file.filename).toBe(RENEWAL_CALENDAR_FILENAME);
    expect(file.filename).not.toMatch(/\d/);
    expect(file.dates.map(formatIsoDate)).toEqual(["2027-04-30"]);
    const lines = unfold(file.text);
    expect(lines.filter((line) => line === "BEGIN:VEVENT")).toHaveLength(1);
    expect(lines).toContain("DTSTART;VALUE=DATE:20270430");
    expect(lines).toContain("SUMMARY:Check on your renewal");
    expect(lines).toContain("CLASS:PRIVATE");
    expect(lines.find((line) => line.startsWith("DESCRIPTION:You told us"))).toBeDefined();
    expect(lines.filter((line) => line.startsWith("TRIGGER:"))).toHaveLength(3);
    expect(lines).toContain("URL:https://medicaid.ncdhhs.gov/beneficiaries/medicaid-is-changing");
    expect(lines).toContain(`UID:${calendarEventUid(CALENDAR_ID, DUE_DATE_EVENT_KEY)}`);
  });

  it("makes one event per estimate for an approval date, each labeled as an estimate", () => {
    const file = build("approval", "2026-10-15")!;
    expect(file.dates.map(formatIsoDate)).toEqual(["2027-04-15", "2027-10-15"]);
    const lines = unfold(file.text);
    expect(lines.filter((line) => line === "BEGIN:VEVENT")).toHaveLength(2);
    const descriptions = lines.filter((line) => line.startsWith("DESCRIPTION:Estimate"));
    expect(descriptions).toHaveLength(2);
    for (const line of descriptions) {
      expect(line).toContain("not an official date");
    }
    expect(lines.filter((line) => line === "SUMMARY:Check on your renewal (estimate)")).toHaveLength(2);
    expect(new Set(linesOf(file.text, "UID:")).size).toBe(2);
    expect(file.uids).toEqual([
      calendarEventUid(CALENDAR_ID, "every_6_months"),
      calendarEventUid(CALENDAR_ID, "once_a_year"),
    ]);
  });

  it("leaves out the 19-64 estimate when the person said they are outside those ages", () => {
    const file = build("approval", "2026-10-15", { ageAnswer: { min: 19, max: 64, answer: "no" } })!;
    expect(file.dates.map(formatIsoDate)).toEqual(["2027-10-15"]);
  });

  it("keeps each event's identity across downloads and date changes, with a rising SEQUENCE (review fix)", () => {
    const first = build("renewal_due", "2027-04-30")!;
    const again = build("renewal_due", "2027-04-30")!;
    const changed = build("renewal_due", "2027-05-30", { revision: 1 })!;
    expect(linesOf(again.text, "UID:")).toEqual(linesOf(first.text, "UID:"));
    expect(linesOf(changed.text, "UID:")).toEqual(linesOf(first.text, "UID:"));
    expect(linesOf(first.text, "SEQUENCE:")).toEqual(["SEQUENCE:0"]);
    expect(linesOf(changed.text, "SEQUENCE:")).toEqual(["SEQUENCE:1"]);
    expect(linesOf(changed.text, "DTSTART")).toEqual(["DTSTART;VALUE=DATE:20270530"]);
    // A different reminder never collides with this one.
    expect(linesOf(build("renewal_due", "2027-04-30", { calendarId: "f".repeat(32) })!.text, "UID:")).not.toEqual(
      linesOf(first.text, "UID:"),
    );
  });

  it("gives every event of every reminder a distinct, stable UID (property)", () => {
    const id = fc.uint8Array({ minLength: 16, maxLength: 16 }).map((bytes) =>
      newCalendarId((array) => {
        array.set(bytes);
        return array;
      }),
    );
    const day = fc
      .integer({ min: toEpochDay(d("2026-01-01")), max: toEpochDay(d("2030-12-31")) })
      .map((epochDay) => formatIsoDate(fromEpochDay(epochDay)));
    fc.assert(
      fc.property(id, day, day, fc.nat({ max: 50 }), (calendarId, first, second, revision) => {
        const a = build("approval", first, { calendarId, today: "2026-01-01" });
        const b = build("approval", second, { calendarId, revision, today: "2026-01-01" });
        if (a && b) {
          // Same reminder, same schedules: the same UIDs, whatever the dates.
          const shared = a.uids.filter((uid) => b.uids.includes(uid));
          expect(shared.length).toBe(Math.min(a.uids.length, b.uids.length));
          expect(new Set(a.uids).size).toBe(a.uids.length);
        }
      }),
      { numRuns: 100 },
    );
  });

  it("drops an alert whose 9 AM has already gone today (review fix)", () => {
    // Due 2026-11-28, built 2026-10-29: the 30-day alert is today at 9 AM.
    expect(linesOf(build("renewal_due", "2026-11-28", { minutes: 18 * 60 })!.text, "TRIGGER:")).toHaveLength(2);
    expect(linesOf(build("renewal_due", "2026-11-28", { minutes: 8 * 60 })!.text, "TRIGGER:")).toHaveLength(3);
  });

  it("returns nothing for a date it cannot use, and refuses a bad calendar id or revision", () => {
    expect(build("renewal_due", "2027-02-30")).toBeNull();
    expect(build("renewal_due", "1999-01-01")).toBeNull();
    expect(
      buildReminderCalendar({
        facts: { ...PILOT_RENEWAL_FACTS, schedules: [] },
        kind: "approval",
        reportedDate: "2026-10-15",
        calendarId: CALENDAR_ID,
        revision: 0,
        now: new Date(0),
        today: d("2026-10-29"),
        minutesIntoToday: 0,
      }),
    ).toBeNull();
    expect(() => build("renewal_due", "2027-04-30", { calendarId: "not-hex" })).toThrow(RangeError);
    expect(() => build("renewal_due", "2027-04-30", { revision: -1 })).toThrow(RangeError);
  });

  it("writes only honest text into the file", () => {
    for (const file of [build("renewal_due", "2027-04-30")!, build("approval", "2026-10-15")!]) {
      const text = unfold(file.text).join("\n").replace(/\\n/g, " ").replace(/\\([;,\\])/g, "$1");
      expect(findBannedClaims(text)).toEqual([]);
    }
  });
});
