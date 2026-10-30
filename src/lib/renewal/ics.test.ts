import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  addDays,
  daysBetween,
  formatIsoDate,
  fromEpochDay,
  parseIsoDate,
  toEpochDay,
  type CalendarDate,
} from "./calendar-date";
import {
  ICS_ALARM_HOUR,
  ICS_MAX_LINE_OCTETS,
  ICS_PRODUCT_ID,
  alarmIsAhead,
  alarmTrigger,
  buildIcsCalendar,
  escapeIcsText,
  foldIcsLine,
  formatIcsDate,
  formatIcsUtc,
  utf8Length,
  type IcsAllDayEvent,
} from "./ics";

// RFC 5545 calendar file (HACK-50). The oracles below are written from the
// RFC, independently of the module: unfolding (3.1), TEXT unescaping
// (3.3.11), and the DURATION grammar (3.3.6). Octets are counted with
// Node's Buffer, not the module's own counter.

const d = (iso: string): CalendarDate => parseIsoDate(iso)!;

/** RFC 5545 3.1: remove every CRLF that is followed by one space or tab. */
function unfold(text: string): string[] {
  const body = text.endsWith("\r\n") ? text.slice(0, -2) : text;
  return body.replace(/\r\n[ \t]/g, "").split("\r\n");
}

/** RFC 5545 3.3.11 TEXT unescaping. */
function unescapeText(value: string): string {
  return value.replace(/\\([\\;,nN])/g, (_, char: string) =>
    char === "n" || char === "N" ? "\n" : char,
  );
}

/** What escaping is allowed to change: newline forms, controls, lone surrogates. */
function normalizeText(value: string): string {
  let out = "";
  for (const char of value.replace(/\r\n?/g, "\n")) {
    const code = char.codePointAt(0)!;
    if (code >= 0xd800 && code <= 0xdfff) {
      out += "�";
    } else if (char === "\n" || char === "\t") {
      out += char;
    } else if (code < 0x20 || code === 0x7f) {
      out += " ";
    } else {
      out += char;
    }
  }
  return out;
}

/** RFC 5545 3.3.6 dur-value to signed minutes (days, hours, minutes only). */
function durationMinutes(value: string): number {
  const match = /^([+-])?P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(value);
  if (!match || value === "-P" || value === "P" || value.endsWith("T")) {
    throw new Error(`not an RFC 5545 duration: ${value}`);
  }
  const minutes =
    Number(match[2] ?? 0) * 24 * 60 + Number(match[3] ?? 0) * 60 + Number(match[4] ?? 0);
  return match[1] === "-" ? -minutes : minutes;
}

const anyText = fc.string({ unit: "binary", maxLength: 300 });
const anyLine = anyText.map((text) => text.replace(/[\r\n]/g, " "));
const eventDay = fc
  .integer({ min: toEpochDay(d("2026-01-01")), max: toEpochDay(d("2030-12-31")) })
  .map(fromEpochDay);

let counter = 0;
const nextUid = () => {
  counter += 1;
  return `test-${counter}@renewal.benefits-navigator`;
};

/** 9 AM in minutes since local midnight. */
const ALARM_MINUTE = ICS_ALARM_HOUR * 60;

describe("line folding (RFC 5545 3.1)", () => {
  it("keeps every physical line within 75 octets and unfolds to the original", () => {
    fc.assert(
      fc.property(anyLine, (line) => {
        const physical = foldIcsLine(line).split("\r\n");
        for (const [index, part] of physical.entries()) {
          expect(Buffer.byteLength(part, "utf8")).toBeLessThanOrEqual(ICS_MAX_LINE_OCTETS);
          if (index > 0) {
            expect(part.startsWith(" ")).toBe(true);
          }
          // Never split inside a character: each piece is well-formed text.
          expect(part.isWellFormed()).toBe(true);
        }
        expect(unfold(foldIcsLine(line)).join("\r\n")).toBe(line);
      }),
      { numRuns: 500 },
    );
  });

  it("does not split surrogate pairs or multi-byte characters", () => {
    const line = `DESCRIPTION:${"é".repeat(40)}${"😀".repeat(30)}`;
    const physical = foldIcsLine(line).split("\r\n");
    expect(physical.length).toBeGreaterThan(1);
    for (const part of physical) {
      expect(part.isWellFormed()).toBe(true);
      expect(Buffer.byteLength(part, "utf8")).toBeLessThanOrEqual(75);
    }
    expect(unfold(foldIcsLine(line))).toEqual([line]);
  });

  it("leaves a short line alone", () => {
    expect(foldIcsLine("VERSION:2.0")).toBe("VERSION:2.0");
    expect(utf8Length("a€😀")).toBe(1 + 3 + 4);
  });
});

describe("TEXT escaping (RFC 5545 3.3.11)", () => {
  it("round-trips through RFC unescaping, up to newline and control normalization", () => {
    fc.assert(
      fc.property(anyText, (text) => {
        expect(unescapeText(escapeIcsText(text))).toBe(normalizeText(text));
      }),
      { numRuns: 500 },
    );
  });

  it("leaves no raw line break, control character, or unescaped separator", () => {
    fc.assert(
      fc.property(anyText, (text) => {
        const escaped = escapeIcsText(text);
        expect(/[\u0000-\u0008\u000a-\u001f\u007f]/.test(escaped)).toBe(false);
        const withoutEscapes = escaped.replace(/\\[\\;,nN]/g, "");
        expect(/[\\;,]/.test(withoutEscapes)).toBe(false);
      }),
      { numRuns: 500 },
    );
  });

  it("escapes the RFC's examples", () => {
    expect(escapeIcsText("Answer letters; check mail, then renew\\done\r\nnext")).toBe(
      "Answer letters\\; check mail\\, then renew\\\\done\\nnext",
    );
  });

  it("replaces text that has no UTF-8 form and drops control characters", () => {
    expect(escapeIcsText("a\uD800b\uDC00c")).toBe("a�b�c");
    expect(escapeIcsText("tab\there\u0007bell\rcr")).toBe("tab\there bell\\ncr");
  });
});

describe("values", () => {
  it("formats DATE and UTC DATE-TIME values", () => {
    expect(formatIcsDate(d("2027-01-05"))).toBe("20270105");
    expect(formatIcsUtc(new Date("2026-10-29T22:15:09.999Z"))).toBe("20261029T221509Z");
  });

  it("writes alert triggers for 9 AM on the day 30, 7, and 1 days before", () => {
    expect(alarmTrigger(1)).toBe("-PT15H");
    expect(alarmTrigger(7)).toBe("-P6DT15H");
    expect(alarmTrigger(30)).toBe("-P29DT15H");
    expect(ICS_ALARM_HOUR).toBe(9);
  });

  it("produces a valid negative duration that lands on the asked day and hour", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 400 }), fc.integer({ min: 0, max: 23 }), (days, hour) => {
        const minutes = durationMinutes(alarmTrigger(days, hour));
        expect(minutes).toBe(-(days * 24 * 60 - hour * 60));
      }),
    );
    expect(() => alarmTrigger(0)).toThrow(RangeError);
    expect(() => alarmTrigger(1, 24)).toThrow(RangeError);
  });

  it("keeps an alert exactly while its 9 AM is still ahead (review fix)", () => {
    // Independent oracle: minutes from today's local midnight to the alert.
    fc.assert(
      fc.property(
        eventDay,
        fc.integer({ min: 1, max: 40 }),
        fc.integer({ min: -60, max: 60 }),
        fc.integer({ min: 0, max: 24 * 60 - 1 }),
        (date, daysBefore, offset, minutes) => {
          const today = addDays(date, -daysBefore + offset);
          const alertMinute = (daysBetween(today, date) - daysBefore) * 24 * 60 + ALARM_MINUTE;
          expect(alarmIsAhead(date, daysBefore, today, minutes)).toBe(alertMinute > minutes);
        },
      ),
      { numRuns: 500 },
    );
    // The review's case: due 2026-11-28, file built 2026-10-29 at 6 PM. The
    // 30-day alert is 2026-10-29 9 AM, already gone.
    expect(alarmIsAhead(d("2026-11-28"), 30, d("2026-10-29"), 18 * 60)).toBe(false);
    expect(alarmIsAhead(d("2026-11-28"), 30, d("2026-10-29"), 8 * 60 + 59)).toBe(true);
    expect(alarmIsAhead(d("2026-11-28"), 30, d("2026-10-29"), ALARM_MINUTE)).toBe(false);
  });
});

describe("buildIcsCalendar", () => {
  const event = (date: CalendarDate, extra: Partial<IcsAllDayEvent> = {}): IcsAllDayEvent => ({
    uid: nextUid(),
    sequence: 0,
    date,
    summary: "Check on your renewal",
    description: "You told us your renewal is due.\nCheck your mail, then answer; right away.",
    url: "https://example.gov/renewal-steps",
    alarmDaysBefore: [30, 7, 1],
    alarmDescription: "Your renewal may be due soon.",
    ...extra,
  });

  it("writes a CRLF-terminated all-day event with three alerts", () => {
    const text = buildIcsCalendar([event(d("2027-04-30"), { sequence: 3 })], {
      now: new Date("2026-10-29T22:15:09Z"),
      today: d("2026-10-29"),
      minutesIntoToday: 18 * 60,
    });
    expect(text.endsWith("\r\n")).toBe(true);
    expect(text.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
    const lines = unfold(text);
    expect(lines.slice(0, 5)).toEqual([
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      `PRODID:${ICS_PRODUCT_ID}`,
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH",
    ]);
    expect(lines.at(-1)).toBe("END:VCALENDAR");
    expect(lines).toContain("DTSTAMP:20261029T221509Z");
    expect(lines).toContain("DTSTART;VALUE=DATE:20270430");
    expect(lines).toContain("DTEND;VALUE=DATE:20270501");
    expect(lines).toContain("URL:https://example.gov/renewal-steps");
    expect(lines).toContain("SEQUENCE:3");
    expect(lines).toContain("CLASS:PRIVATE");
    expect(lines).toContain("TRANSP:TRANSPARENT");
    expect(lines.filter((line) => line.startsWith("TRIGGER:"))).toEqual([
      "TRIGGER:-P29DT15H",
      "TRIGGER:-P6DT15H",
      "TRIGGER:-PT15H",
    ]);
    const description = lines.find((line) => line.startsWith("DESCRIPTION:You told us"))!;
    expect(unescapeText(description.slice("DESCRIPTION:".length))).toBe(
      "You told us your renewal is due.\nCheck your mail, then answer; right away.",
    );
  });

  it("puts the all-day event on the right day across month and year ends", () => {
    for (const [date, end] of [
      ["2026-12-31", "20270101"],
      ["2028-02-28", "20280229"],
      ["2028-02-29", "20280301"],
    ] as const) {
      const lines = unfold(
        buildIcsCalendar([event(d(date))], { now: new Date(0), today: d("2026-01-01"), minutesIntoToday: 0 }),
      );
      expect(lines).toContain(`DTSTART;VALUE=DATE:${date.replace(/-/g, "")}`);
      expect(lines).toContain(`DTEND;VALUE=DATE:${end}`);
    }
  });

  it("leaves out alerts whose time has already passed", () => {
    const triggers = (today: string, minutesIntoToday: number) =>
      unfold(buildIcsCalendar([event(d("2027-04-30"))], { now: new Date(0), today: d(today), minutesIntoToday })).filter(
        (line) => line.startsWith("TRIGGER:"),
      );
    expect(triggers("2027-04-25", 0)).toEqual(["TRIGGER:-PT15H"]);
    // The 7-day alert is 2027-04-23 at 9 AM: kept at 8:59, gone at 9:00 (review fix).
    expect(triggers("2027-04-23", ALARM_MINUTE - 1)).toEqual(["TRIGGER:-P6DT15H", "TRIGGER:-PT15H"]);
    expect(triggers("2027-04-23", ALARM_MINUTE)).toEqual(["TRIGGER:-PT15H"]);
    const passed = unfold(
      buildIcsCalendar([event(d("2027-04-30"))], { now: new Date(0), today: d("2027-05-02"), minutesIntoToday: 0 }),
    );
    expect(passed.some((line) => line.startsWith("BEGIN:VALARM"))).toBe(false);
  });

  it("rejects a non-https URL and a UID with spaces", () => {
    const options = { now: new Date(0), today: d("2026-01-01"), minutesIntoToday: 0 };
    expect(() => buildIcsCalendar([event(d("2027-01-01"), { url: "http://example.gov" })], options)).toThrow(RangeError);
    expect(() => buildIcsCalendar([event(d("2027-01-01"), { url: "https://x.gov/a b" })], options)).toThrow(RangeError);
    expect(() => buildIcsCalendar([event(d("2027-01-01"), { uid: "has space" })], options)).toThrow(RangeError);
    expect(() => buildIcsCalendar([event(d("2027-01-01"), { sequence: -1 })], options)).toThrow(RangeError);
    expect(() => buildIcsCalendar([event(d("2027-01-01"), { sequence: 1.5 })], options)).toThrow(RangeError);
  });

  it("is well-formed for any events and text (property)", () => {
    const eventArb = fc.record({
      date: eventDay,
      summary: anyText,
      description: anyText,
      alarms: fc.subarray([30, 7, 1]),
      sequence: fc.nat({ max: 1000 }),
    });
    const minutes = fc.integer({ min: 0, max: 24 * 60 - 1 });
    fc.assert(
      fc.property(fc.array(eventArb, { minLength: 1, maxLength: 3 }), eventDay, minutes, (specs, today, minutesIntoToday) => {
        const events = specs.map((spec) =>
          event(spec.date, {
            summary: spec.summary,
            description: spec.description,
            alarmDaysBefore: spec.alarms,
            sequence: spec.sequence,
          }),
        );
        const text = buildIcsCalendar(events, { now: new Date("2026-10-29T12:00:00Z"), today, minutesIntoToday });
        // CRLF only, every physical line within 75 octets.
        expect(text.endsWith("\r\n")).toBe(true);
        expect(text.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
        for (const physical of text.slice(0, -2).split("\r\n")) {
          expect(Buffer.byteLength(physical, "utf8")).toBeLessThanOrEqual(75);
        }
        const lines = unfold(text);
        // Components nest and close properly.
        const stack: string[] = [];
        for (const line of lines) {
          if (line.startsWith("BEGIN:")) {
            stack.push(line.slice(6));
          } else if (line.startsWith("END:")) {
            expect(stack.pop()).toBe(line.slice(4));
          }
        }
        expect(stack).toEqual([]);
        // Per event: required properties, the right dates, the right alerts.
        const veventStarts = lines.flatMap((line, index) => (line === "BEGIN:VEVENT" ? [index] : []));
        expect(veventStarts.length).toBe(events.length);
        veventStarts.forEach((start, eventIndex) => {
          const end = lines.indexOf("END:VEVENT", start);
          const block = lines.slice(start, end);
          const spec = specs[eventIndex]!;
          expect(block.filter((line) => line.startsWith("UID:")).length).toBe(1);
          expect(block.filter((line) => /^DTSTAMP:\d{8}T\d{6}Z$/.test(line)).length).toBe(1);
          expect(block.filter((line) => line === `SEQUENCE:${spec.sequence}`).length).toBe(1);
          expect(block.filter((line) => line === "CLASS:PRIVATE").length).toBe(1);
          expect(block).toContain(`DTSTART;VALUE=DATE:${formatIcsDate(spec.date)}`);
          expect(block).toContain(`DTEND;VALUE=DATE:${formatIcsDate(addDays(spec.date, 1))}`);
          const summary = block.find((line) => line.startsWith("SUMMARY:"))!;
          expect(unescapeText(summary.slice(8))).toBe(normalizeText(spec.summary));
          // Oracle: an alert stays only while its local minute is still ahead.
          const away = daysBetween(today, spec.date);
          const expectedTriggers = [...new Set(spec.alarms)]
            .filter((days) => (away - days) * 24 * 60 + ALARM_MINUTE > minutesIntoToday)
            .sort((a, b) => b - a)
            .map((days) => -(days * 24 * 60 - ICS_ALARM_HOUR * 60));
          const triggers = block
            .filter((line) => line.startsWith("TRIGGER:"))
            .map((line) => durationMinutes(line.slice(8)));
          expect(triggers).toEqual(expectedTriggers);
          // Every alert fires on or after today (its day is not in the past).
          for (const minutes of triggers) {
            const alertDay = addDays(spec.date, -Math.ceil(-minutes / (24 * 60)));
            expect(daysBetween(today, alertDay)).toBeGreaterThanOrEqual(0);
          }
          expect(block.filter((line) => line === "BEGIN:VALARM").length).toBe(triggers.length);
          expect(block.filter((line) => line === "ACTION:DISPLAY").length).toBe(triggers.length);
        });
        expect(formatIsoDate(today)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }),
      { numRuns: 150 },
    );
  });
});
