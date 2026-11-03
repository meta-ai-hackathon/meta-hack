import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { formatIsoDate, fromEpochDay, parseIsoDate, toEpochDay, type CalendarDate } from "./calendar-date";
import { findBannedClaims } from "../honesty";
import type { AgeAnswer } from "./estimate";
import { newCalendarId } from "./reminder";
import {
  CALENDAR_SEQUENCE_EPOCH_MS,
  DUE_DATE_EVENT_KEY,
  MAX_ICS_INTEGER,
  RENEWAL_CALENDAR_FILENAME,
  buildReminderCalendar,
  calendarEventUid,
  calendarSequence,
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
  options: { today?: string; now?: Date; calendarId?: string; ageAnswer?: AgeAnswer; minutes?: number } = {},
) {
  return buildReminderCalendar({
    facts: PILOT_RENEWAL_FACTS,
    kind,
    reportedDate,
    ...(options.ageAnswer !== undefined ? { ageAnswer: options.ageAnswer } : {}),
    calendarId: options.calendarId ?? CALENDAR_ID,
    now: options.now ?? new Date("2026-10-29T22:00:00Z"),
    today: d(options.today ?? "2026-10-29"),
    minutesIntoToday: options.minutes ?? 18 * 60,
  });
}

const linesOf = (text: string, prefix: string) => unfold(text).filter((line) => line.startsWith(prefix));

/** The one SEQUENCE every event in a file carries. */
function sequenceOf(file: { readonly text: string }): number {
  const values = new Set(linesOf(file.text, "SEQUENCE:").map((line) => Number(line.slice("SEQUENCE:".length))));
  expect(values.size).toBe(1);
  return [...values][0]!;
}

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
    // Third review: no link to the program's pages, and notes that point
    // back to the tracker instead.
    expect(lines.filter((line) => line.startsWith("URL"))).toEqual([]);
    expect(lines.find((line) => line.startsWith("DESCRIPTION:"))).toMatch(/has the official steps\.$/);
    expect(lines).toContain(`UID:${calendarEventUid(CALENDAR_ID, DUE_DATE_EVENT_KEY)}`);
  });

  it("never names the program or links to its pages anywhere in the file (third review, property)", () => {
    // A calendar that syncs keeps a copy of every event, so the file must
    // carry only the neutral title, the date, and a pointer to the tracker.
    const day = fc
      .integer({ min: toEpochDay(d("2024-01-01")), max: toEpochDay(d("2030-12-31")) })
      .map((epochDay) => formatIsoDate(fromEpochDay(epochDay)));
    const answer = fc.option(fc.constantFrom("yes" as const, "no" as const, "unsure" as const), { nil: undefined });
    fc.assert(
      fc.property(fc.constantFrom("renewal_due" as const, "approval" as const), day, answer, (kind, reported, value) => {
        const file = build(kind, reported, {
          today: "2024-01-01",
          ...(value !== undefined ? { ageAnswer: { min: 19, max: 64, answer: value } } : {}),
        });
        if (file === null) {
          return;
        }
        const text = unfold(file.text).join("\n");
        expect(text).not.toContain(PILOT_RENEWAL_FACTS.programName);
        expect(text).not.toMatch(/medicaid|https?:|ncdhhs|\.gov\b/i);
        expect(text).not.toMatch(/^URL[;:]/m);
      }),
      { numRuns: 200 },
    );
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
    // SEQUENCE is the seconds since 2026-01-01 UTC when the file is made
    // (second review fix). It was the saved revision, so this test pinned
    // SEQUENCE:0 and SEQUENCE:1; that rule let an abandoned edit's file
    // outrank every later one, below.
    const first = build("renewal_due", "2027-04-30", { now: new Date("2026-10-29T22:00:00Z") })!;
    const again = build("renewal_due", "2027-04-30", { now: new Date("2026-10-29T22:05:00Z") })!;
    const changed = build("renewal_due", "2027-05-30", { now: new Date("2026-10-30T09:00:00Z") })!;
    expect(linesOf(again.text, "UID:")).toEqual(linesOf(first.text, "UID:"));
    expect(linesOf(changed.text, "UID:")).toEqual(linesOf(first.text, "UID:"));
    expect(sequenceOf(first)).toBe((Date.UTC(2026, 9, 29, 22) - Date.UTC(2026, 0, 1)) / 1000);
    expect(sequenceOf(again)).toBeGreaterThan(sequenceOf(first));
    expect(sequenceOf(changed)).toBeGreaterThan(sequenceOf(again));
    expect(linesOf(changed.text, "DTSTART")).toEqual(["DTSTART;VALUE=DATE:20270530"]);
    // The second review's case: a file from the edit form for a date that
    // was never saved, then, after a reload, the saved date's file. Same
    // UID, different date, and the later file now has the higher SEQUENCE.
    const unsaved = build("approval", "2025-11-20", { now: new Date("2026-10-30T05:23:00Z") })!;
    const savedDate = build("approval", "2025-11-10", { now: new Date("2026-10-30T05:23:15Z") })!;
    expect(savedDate.uids).toEqual(unsaved.uids);
    expect(linesOf(savedDate.text, "DTSTART")).not.toEqual(linesOf(unsaved.text, "DTSTART"));
    expect(sequenceOf(savedDate)).toBeGreaterThan(sequenceOf(unsaved));
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
      fc.property(id, day, day, fc.nat({ max: 50_000_000 }), (calendarId, first, second, later) => {
        const a = build("approval", first, { calendarId, today: "2026-01-01" });
        const b = build("approval", second, {
          calendarId,
          now: new Date(Date.UTC(2026, 9, 29, 22) + later * 1000),
          today: "2026-01-01",
        });
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

  it("never gives a later file a lower SEQUENCE for the same event, whatever the dates (property)", () => {
    const instant = fc.integer({ min: CALENDAR_SEQUENCE_EPOCH_MS, max: Date.UTC(2035, 0, 1) });
    const day = fc
      .integer({ min: toEpochDay(d("2026-01-01")), max: toEpochDay(d("2030-12-31")) })
      .map((epochDay) => formatIsoDate(fromEpochDay(epochDay)));
    fc.assert(
      fc.property(instant, instant, day, day, (a, b, firstDay, secondDay) => {
        const [early, late] = a <= b ? [a, b] : [b, a];
        const before = build("renewal_due", firstDay, { now: new Date(early), today: "2026-01-01" })!;
        const after = build("renewal_due", secondDay, { now: new Date(late), today: "2026-01-01" })!;
        expect(after.uids).toEqual(before.uids);
        expect(sequenceOf(after)).toBeGreaterThanOrEqual(sequenceOf(before));
        if (late - early >= 1000) {
          expect(sequenceOf(after)).toBeGreaterThan(sequenceOf(before));
        }
      }),
      { numRuns: 300 },
    );
  });

  it("keeps SEQUENCE a whole RFC 5545 INTEGER, and refuses a time that is not a real instant", () => {
    expect(calendarSequence(new Date(CALENDAR_SEQUENCE_EPOCH_MS))).toBe(0);
    expect(calendarSequence(new Date(CALENDAR_SEQUENCE_EPOCH_MS + 1999))).toBe(1);
    // A device clock set before 2026 or far ahead stays inside the INTEGER range.
    expect(calendarSequence(new Date(Date.UTC(2020, 0, 1)))).toBe(0);
    expect(calendarSequence(new Date(Date.UTC(2200, 0, 1)))).toBe(MAX_ICS_INTEGER);
    expect(() => calendarSequence(new Date(Number.NaN))).toThrow(RangeError);
  });

  it("drops an alert whose 9 AM has already gone today (review fix)", () => {
    // Due 2026-11-28, built 2026-10-29: the 30-day alert is today at 9 AM.
    expect(linesOf(build("renewal_due", "2026-11-28", { minutes: 18 * 60 })!.text, "TRIGGER:")).toHaveLength(2);
    expect(linesOf(build("renewal_due", "2026-11-28", { minutes: 8 * 60 })!.text, "TRIGGER:")).toHaveLength(3);
  });

  it("returns nothing for a date it cannot use, and refuses a bad calendar id or file time", () => {
    expect(build("renewal_due", "2027-02-30")).toBeNull();
    expect(build("renewal_due", "1999-01-01")).toBeNull();
    expect(
      buildReminderCalendar({
        facts: { ...PILOT_RENEWAL_FACTS, schedules: [] },
        kind: "approval",
        reportedDate: "2026-10-15",
        calendarId: CALENDAR_ID,
        now: new Date(0),
        today: d("2026-10-29"),
        minutesIntoToday: 0,
      }),
    ).toBeNull();
    expect(() => build("renewal_due", "2027-04-30", { calendarId: "not-hex" })).toThrow(RangeError);
    // The revision no longer reaches the file; the time it is made does.
    expect(() => build("renewal_due", "2027-04-30", { now: new Date(Number.NaN) })).toThrow(RangeError);
  });

  it("writes only honest text into the file", () => {
    for (const file of [build("renewal_due", "2027-04-30")!, build("approval", "2026-10-15")!]) {
      const text = unfold(file.text).join("\n").replace(/\\n/g, " ").replace(/\\([;,\\])/g, "$1");
      expect(findBannedClaims(text)).toEqual([]);
    }
  });
});
