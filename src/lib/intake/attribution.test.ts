import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  allSituationIds,
  applicableSituations,
  currentAttribution,
  draftAttribution,
  pruneAttribution,
  entriesForMember,
  parseAttribution,
  setAttribution,
  MONTH_VALUES,
  type AttributionEntry,
} from "./attribution";
import { canonicalAnswerValue } from "./answer-input";
import { QUESTION_BY_ID } from "./spec";
import type { AnswerMap } from "./flow";

const situations = [...allSituationIds()];
const entryArb: fc.Arbitrary<AttributionEntry> = fc.record({
  memberId: fc.constantFrom("member-1", "member-2", "member-3"),
  situationId: fc.constantFrom(...situations),
  months: fc.constantFrom(...MONTH_VALUES),
});
const entriesArb = fc.uniqueArray(entryArb, { minLength: 1, maxLength: 8, selector: (e) => `${e.memberId}|${e.situationId}` });

describe("per-person attribution (HACK-135)", () => {
  it("round-trips valid entries through parse and canonicalAnswerValue", () => {
    fc.assert(fc.property(entriesArb, (entries) => {
      expect(parseAttribution(entries)).toEqual(entries);
      const q = QUESTION_BY_ID["wr_who_months"];
      expect(q?.type).toBe("attribution");
      expect(q?.pii).toBe(true);
      expect(canonicalAnswerValue(q!, entries)).toEqual(entries);
    }));
  });
  it("rejects duplicates, unknown situations, unknown months, and empty lists", () => {
    const e = { memberId: "member-1", situationId: "wr_income_580", months: "both" as const };
    expect(parseAttribution([e, e])).toBeNull();
    expect(parseAttribution([{ ...e, situationId: "nope" }])).toBeNull();
    expect(parseAttribution([{ ...e, months: "year" }])).toBeNull();
    expect(parseAttribution([])).toBeNull();
  });
  it("setAttribution replaces per (member, situation) and never touches other people", () => {
    fc.assert(fc.property(entriesArb, (entries) => {
      const next = setAttribution(entries, "member-1", "wr_income_580", "last_month");
      expect(next.filter((x) => x.memberId === "member-1" && x.situationId === "wr_income_580")).toEqual([
        { memberId: "member-1", situationId: "wr_income_580", months: "last_month" },
      ]);
      expect(entriesForMember(next, "member-2")).toEqual(entriesForMember(entries, "member-2"));
      expect(setAttribution(next, "member-1", "wr_income_580", null).some((x) => x.situationId === "wr_income_580" && x.memberId === "member-1")).toBe(false);
    }));
  });
  it("prunes entries for removed members or withdrawn situations", () => {
    const entries = [
      { memberId: "member-1", situationId: "wr_income_580", months: "both" as const },
      { memberId: "member-9", situationId: "wr_income_580", months: "both" as const },
      { memberId: "member-1", situationId: "wr_pregnant", months: "both" as const },
    ];
    const context = {
      members: [{ id: "member-1", displayName: "Sam", relationship: "self" as const, ageBand: "18_to_54" as const }],
      situations: [{ id: "wr_income_580", label: "x" }],
    };
    expect(pruneAttribution(entries, context)).toEqual([entries[0]]);
    expect(draftAttribution(entries, context)).toEqual([entries[0]]);
  });
  it("currentAttribution re-prunes against the current roster and situations on read", () => {
    const answers: AnswerMap = {
      household_roster: { status: "known", value: [{ id: "member-1", displayName: "Sam", relationship: "self", ageBand: "18_to_54" }] },
      wr_income_580: { status: "known", value: "yes" },
      wr_who_months: { status: "known", value: [
        { memberId: "member-1", situationId: "wr_income_580", months: "both" },
        { memberId: "member-9", situationId: "wr_income_580", months: "both" },
        { memberId: "member-1", situationId: "wr_pregnant", months: "both" },
      ] },
    };
    expect(currentAttribution(answers)).toEqual([{ memberId: "member-1", situationId: "wr_income_580", months: "both" }]);
  });
  it("entries survive while their source answer is unknown, and are pruned when it becomes no", () => {
    const base: AnswerMap = {
      household_roster: { status: "known", value: [{ id: "member-1", displayName: "Sam", relationship: "self", ageBand: "18_to_54" }] },
      wr_income_580: { status: "unknown", value: null },
      wr_who_months: { status: "known", value: [{ memberId: "member-1", situationId: "wr_income_580", months: "both" }] },
    };
    expect(currentAttribution(base)).toHaveLength(1);
    const withdrawn: AnswerMap = { ...base, wr_income_580: { status: "known", value: "no" } };
    expect(currentAttribution(withdrawn)).toEqual([]);
    // An unknown exempt list retains only its own options, not the $580 id.
    const unknownExempt: AnswerMap = { ...base, wr_exempt_situations: { status: "unknown", value: null } };
    expect(currentAttribution(unknownExempt)).toEqual([]);
  });
  it("applicable situations come only from yes answers and selected situations", () => {
    const answers: AnswerMap = {
      wr_pregnant: { status: "known", value: "yes" },
      wr_disability_hard_work: { status: "known", value: "no" },
      wr_income_580: { status: "known", value: "yes" },
      wr_exempt_situations: { status: "known", value: ["parent_child_under_18", "none"] },
    };
    const ids = applicableSituations(answers).map((s) => s.id);
    expect(ids).toContain("wr_pregnant");
    expect(ids).toContain("wr_income_580");
    expect(ids).toContain("parent_child_under_18");
    expect(ids).not.toContain("wr_disability_hard_work");
    expect(ids).not.toContain("none");
    expect(applicableSituations({ wr_pregnant: { status: "unverified", value: "yes" } }).map((s) => s.id)).toContain("wr_pregnant");
    expect(applicableSituations({})).toEqual([]);
    expect(draftAttribution("junk")).toEqual([]);
  });
});
