import fc from "fast-check";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { KbAgeRange, KbCadenceFact } from "../kb";
import {
  addMonthsClamped,
  compareDates,
  formatIsoDate,
  fromEpochDay,
  parseIsoDate,
  toEpochDay,
  type CalendarDate,
} from "./calendar-date";
import {
  AGE_ANSWERS,
  ageQuestionRange,
  estimateRenewals,
  excludedByAge,
  type AgeAnswer,
  type AgeRange,
  type RenewalSchedule,
} from "./estimate";
import { PILOT_RENEWAL_FACTS } from "./renewal-facts";

describe("one age range type for the knowledge base and the estimates (third review)", () => {
  it("is the knowledge base's own type, so the two layers cannot drift", () => {
    expectTypeOf<AgeRange>().toEqualTypeOf<KbAgeRange>();
    expectTypeOf<NonNullable<RenewalSchedule["ages"]>>().toEqualTypeOf<NonNullable<KbCadenceFact["ages"]>>();
    expectTypeOf<Pick<AgeAnswer, "min" | "max">>().toEqualTypeOf<Pick<KbAgeRange, "min" | "max">>();
  });
});

// Renewal estimates (HACK-50): the reported date plus each published
// schedule, kept only when the schedule has started by then. The cutover
// that matters for the pilot: from January 1, 2027, most adults ages 19
// through 64 renew every 6 months instead of once a year.

const NC_SCHEDULES = PILOT_RENEWAL_FACTS.schedules;
const CUTOVER = parseIsoDate("2027-01-01")!;

const d = (iso: string): CalendarDate => parseIsoDate(iso)!;
const isoList = (dates: readonly { date: CalendarDate; scheduleId: string }[]) =>
  dates.map((estimate) => `${formatIsoDate(estimate.date)} ${estimate.scheduleId}`);

const reportedDate = fc
  .integer({ min: toEpochDay(d("2020-01-01")), max: toEpochDay(d("2035-12-31")) })
  .map(fromEpochDay);

/** Age ranges built directly as ordered pairs (no filtering). */
const ageRange = fc
  .tuple(fc.integer({ min: 0, max: 130 }), fc.integer({ min: 0, max: 130 }))
  .map(([a, b]) => ({ min: Math.min(a, b), max: Math.max(a, b) }));

const schedule: fc.Arbitrary<RenewalSchedule> = fc.record(
  {
    id: fc.stringMatching(/^[a-z][a-z0-9_]{0,10}$/),
    intervalMonths: fc.integer({ min: 1, max: 24 }),
    label: fc.constant("Every so often"),
    appliesTo: fc.constant("Some people"),
    startsOn: fc
      .integer({ min: toEpochDay(d("2020-01-01")), max: toEpochDay(d("2035-12-31")) })
      .map((day) => formatIsoDate(fromEpochDay(day))),
    ages: fc.oneof(ageRange, fc.constantFrom({ min: 19, max: 64 })),
  },
  { requiredKeys: ["id", "intervalMonths", "label", "appliesTo"] },
);

const ageAnswer: fc.Arbitrary<AgeAnswer | undefined> = fc.option(
  fc
    .record({ range: fc.oneof(ageRange, fc.constant({ min: 19, max: 64 })), answer: fc.constantFrom(...AGE_ANSWERS) })
    .map(({ range, answer }) => ({ ...range, answer })),
  { nil: undefined },
);

describe("the pilot's published schedules", () => {
  it("are every 6 months from 2027-01-01 for ages 19 through 64, and once a year", () => {
    expect(
      NC_SCHEDULES.map((item) => [item.id, item.intervalMonths, item.startsOn ?? null, item.ages ?? null]),
    ).toEqual([
      ["every_6_months", 6, "2027-01-01", { min: 19, max: 64 }],
      ["once_a_year", 12, null, null],
    ]);
    expect(ageQuestionRange(NC_SCHEDULES)).toEqual({ min: 19, max: 64 });
  });
});

describe("the age question (review fix: the 6-month schedule is not for everyone)", () => {
  const approval = d("2026-10-15");

  it("leaves the 19-64 schedule out only when the person says they are outside those ages", () => {
    const ids = (answer: AgeAnswer | undefined) =>
      estimateRenewals(approval, NC_SCHEDULES, answer).map((item) => item.scheduleId);
    expect(ids({ min: 19, max: 64, answer: "no" })).toEqual(["once_a_year"]);
    for (const answer of ["yes", "unsure"] as const) {
      expect(ids({ min: 19, max: 64, answer })).toEqual(["every_6_months", "once_a_year"]);
    }
    expect(ids(undefined)).toEqual(["every_6_months", "once_a_year"]);
    // An answer about some other range never applies to this schedule.
    expect(ids({ min: 18, max: 64, answer: "no" })).toEqual(["every_6_months", "once_a_year"]);
  });

  it("removes exactly the schedules the answer rules out, and nothing else (any schedules)", () => {
    fc.assert(
      fc.property(
        reportedDate,
        fc.uniqueArray(schedule, { selector: (item) => item.id, maxLength: 5 }),
        ageAnswer,
        (reported, schedules, answer) => {
          const kept = schedules.filter((item) => !excludedByAge(item, answer));
          expect(estimateRenewals(reported, schedules, answer)).toEqual(estimateRenewals(reported, kept));
          for (const item of schedules) {
            if (excludedByAge(item, answer)) {
              expect(answer?.answer).toBe("no");
              expect(item.ages).toEqual({ min: answer!.min, max: answer!.max });
            }
          }
          if (answer === undefined || answer.answer !== "no") {
            expect(estimateRenewals(reported, schedules, answer)).toEqual(estimateRenewals(reported, schedules));
          }
        },
      ),
    );
  });

  it("asks about the first schedule that names an age range, or not at all", () => {
    fc.assert(
      fc.property(fc.uniqueArray(schedule, { selector: (item) => item.id, maxLength: 5 }), (schedules) => {
        const first = schedules.find((item) => item.ages !== undefined);
        expect(ageQuestionRange(schedules)).toEqual(first?.ages ?? null);
      }),
    );
  });
});

describe("estimateRenewals across the 2027 cutover", () => {
  it("offers only the yearly estimate while 6 months out is before the cutover", () => {
    expect(isoList(estimateRenewals(d("2026-06-30"), NC_SCHEDULES))).toEqual([
      "2027-06-30 once_a_year",
    ]);
    expect(isoList(estimateRenewals(d("2025-03-15"), NC_SCHEDULES))).toEqual([
      "2026-03-15 once_a_year",
    ]);
  });

  it("adds the 6-month estimate from the first date that lands on or after it", () => {
    expect(isoList(estimateRenewals(d("2026-07-01"), NC_SCHEDULES))).toEqual([
      "2027-01-01 every_6_months",
      "2027-07-01 once_a_year",
    ]);
    expect(isoList(estimateRenewals(d("2026-10-15"), NC_SCHEDULES))).toEqual([
      "2027-04-15 every_6_months",
      "2027-10-15 once_a_year",
    ]);
  });

  it("clamps month ends and leap days to the earlier day", () => {
    expect(isoList(estimateRenewals(d("2026-08-31"), NC_SCHEDULES))).toEqual([
      "2027-02-28 every_6_months",
      "2027-08-31 once_a_year",
    ]);
    expect(isoList(estimateRenewals(d("2028-02-29"), NC_SCHEDULES))).toEqual([
      "2028-08-29 every_6_months",
      "2029-02-28 once_a_year",
    ]);
  });

  it("includes the 6-month estimate exactly when the reported date is on or after 2026-07-01", () => {
    const threshold = d("2026-07-01");
    fc.assert(
      fc.property(reportedDate, (reported) => {
        const ids = estimateRenewals(reported, NC_SCHEDULES).map((item) => item.scheduleId);
        expect(ids.includes("every_6_months")).toBe(compareDates(reported, threshold) >= 0);
        expect(ids.includes("once_a_year")).toBe(true);
      }),
      { numRuns: 400 },
    );
  });

  it("never estimates a 6-month renewal before the cutover", () => {
    fc.assert(
      fc.property(reportedDate, (reported) => {
        for (const estimate of estimateRenewals(reported, NC_SCHEDULES)) {
          if (estimate.scheduleId === "every_6_months") {
            expect(compareDates(estimate.date, CUTOVER)).toBeGreaterThanOrEqual(0);
          }
        }
      }),
    );
  });
});

describe("estimateRenewals properties (any schedules)", () => {
  it("keeps a schedule iff its candidate is on or after its start, sorted earliest first", () => {
    fc.assert(
      fc.property(reportedDate, fc.uniqueArray(schedule, { selector: (item) => item.id, maxLength: 5 }), (reported, schedules) => {
        const estimates = estimateRenewals(reported, schedules);
        const expected = schedules.filter((item) => {
          const candidate = addMonthsClamped(reported, item.intervalMonths);
          return item.startsOn === undefined || compareDates(candidate, d(item.startsOn)) >= 0;
        });
        expect(estimates.map((item) => item.scheduleId).sort()).toEqual(
          expected.map((item) => item.id).sort(),
        );
        for (const estimate of estimates) {
          const source = schedules.find((item) => item.id === estimate.scheduleId)!;
          expect(estimate.date).toEqual(addMonthsClamped(reported, source.intervalMonths));
          expect(compareDates(estimate.date, reported)).toBe(1);
        }
        for (let index = 1; index < estimates.length; index += 1) {
          expect(compareDates(estimates[index - 1]!.date, estimates[index]!.date)).toBeLessThanOrEqual(0);
        }
      }),
    );
  });

  it("rejects a malformed start date instead of guessing", () => {
    expect(() =>
      estimateRenewals(d("2026-07-01"), [
        { id: "bad", intervalMonths: 6, label: "x", appliesTo: "y", startsOn: "2027-02-30" },
      ]),
    ).toThrow(RangeError);
  });
});
