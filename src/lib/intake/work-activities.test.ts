import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { canonicalAnswerValue } from "./answer-input";
import { activityTypes, currentWorkRows, draftWorkRows, parseWorkRows, removeWorkRow, setWorkRow, suggestedWorkRows, type WorkRow } from "./work-activities";
import { QUESTION_BY_ID } from "./spec";
import type { AnswerMap } from "./flow";

const activities = activityTypes().map((a) => a.value);
const rowArb: fc.Arbitrary<WorkRow> = fc
  .record({
    memberId: fc.constantFrom("member-1", "member-2"),
    activity: fc.constantFrom(...activities),
    hoursPart: fc.oneof(
      fc.constant({ hours: null, hoursNotSure: true }),
      fc.integer({ min: 0, max: 744 }).map((hours) => ({ hours })),
    ),
  })
  .map(({ memberId, activity, hoursPart }) => ({ memberId, activity, ...hoursPart }));
const rowsArb = fc.uniqueArray(rowArb, { minLength: 1, maxLength: 6, selector: (r) => `${r.memberId}|${r.activity}` });

const members = [
  { id: "member-1", displayName: "Sam", relationship: "self" as const, ageBand: "18_to_54" as const },
  { id: "member-2", displayName: "Jo", relationship: "child" as const, ageBand: "under_14" as const },
];

describe("per-person work rows (HACK-128)", () => {
  it("round-trips rows and never sums hours across people", () => {
    fc.assert(fc.property(rowsArb, (rows) => {
      expect(parseWorkRows(rows)).toEqual(rows);
      const q = QUESTION_BY_ID["wr_work_rows"];
      expect(q?.type).toBe("work_activity");
      expect(q?.pii).toBe(true);
      expect(canonicalAnswerValue(q!, rows)).toEqual(rows);
      // Per-person totals stay per person: each member keeps only their rows.
      for (const m of members) {
        const mine = rows.filter((r) => r.memberId === m.id);
        expect(draftWorkRows(rows, new Set([m.id]))).toEqual(mine);
      }
    }));
  });
  it("rejects duplicates, unknown activities, and negative hours", () => {
    const r = { memberId: "member-1", activity: "job_internship", hours: 10 };
    expect(parseWorkRows([r, r])).toBeNull();
    expect(parseWorkRows([{ ...r, activity: "nope" }])).toBeNull();
    expect(parseWorkRows([{ ...r, hours: -1 }])).toBeNull();
    expect(parseWorkRows([])).toBeNull();
    expect(parseWorkRows([{ ...r, hours: 745 }])).toBeNull();
    expect(parseWorkRows([{ ...r, hours: null }])).toBeNull();
    expect(parseWorkRows([{ ...r, hours: null, hoursNotSure: true }])).toEqual([{ ...r, hours: null, hoursNotSure: true }]);
  });
  it("set/remove touch only the indexed row", () => {
    const rows: WorkRow[] = [
      { memberId: "member-1", activity: "job_internship", hours: 10 },
      { memberId: "member-2", activity: "community_service", hours: null },
    ];
    expect(setWorkRow(rows, 1, { hours: 5 })[0]).toEqual(rows[0]);
    expect(removeWorkRow(rows, 0)).toEqual([rows[1]]);
  });
  it("prefills job and self-employment rows from income sources, and prunes removed members", () => {
    const answers: AnswerMap = {
      household_roster: { status: "known", value: members },
      income_sources: { status: "known", value: ["job", "self_employed"] },
      wr_work_rows: { status: "known", value: [
        { memberId: "member-1", activity: "job_internship", hours: 40 },
        { memberId: "member-9", activity: "job_internship", hours: 10 },
      ] },
    };
    expect(suggestedWorkRows(answers, members)).toEqual([
      { memberId: "member-1", activity: "job_internship", hours: null, hoursNotSure: false },
      { memberId: "member-1", activity: "self_employment", hours: null, hoursNotSure: false },
    ]);
    expect(currentWorkRows(answers)).toEqual([{ memberId: "member-1", activity: "job_internship", hours: 40 }]);
    expect(suggestedWorkRows({}, members)).toEqual([]);
  });
});
