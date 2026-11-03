import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { canonicalAnswerValue } from "./answer-input";
import {
  AGE_BAND_VALUES,
  draftMembers,
  RELATIONSHIP_VALUES,
  addMember,
  emptyMember,
  memberOptions,
  nextMemberId,
  parseRoster,
  removeMember,
  rosterFromAnswers,
  updateMember,
  type HouseholdMember,
} from "./roster";
import { QUESTION_BY_ID } from "./spec";

const memberArb: fc.Arbitrary<HouseholdMember> = fc.record({
  id: fc.stringMatching(/^member-[a-z0-9]{1,8}$/),
  displayName: fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim() !== ""),
  relationship: fc.constantFrom(...RELATIONSHIP_VALUES.filter((v) => v !== "self")),
  ageBand: fc.constantFrom(...AGE_BAND_VALUES),
});
const rosterArb = fc.uniqueArray(memberArb, { minLength: 1, maxLength: 6, selector: (m) => m.id });

describe("household roster (HACK-134)", () => {
  it("round-trips any valid roster through parse and canonicalAnswerValue", () => {
    fc.assert(fc.property(rosterArb, (roster) => {
      expect(parseRoster(roster)).toEqual(roster.map((m) => ({ ...m, displayName: m.displayName.trim() })));
      const q = QUESTION_BY_ID["household_roster"];
      expect(q?.type).toBe("roster");
      expect(q?.pii).toBe(true);
      expect(canonicalAnswerValue(q!, roster)).not.toBeNull();
    }));
  });
  it("rejects duplicate ids, blank names, unknown bands, and non-arrays", () => {
    const m = { ...emptyMember("member-1"), displayName: "Ada" };
    expect(parseRoster([m, m])).toBeNull();
    expect(parseRoster([{ ...m, displayName: "  " }])).toBeNull();
    expect(parseRoster([{ ...m, ageBand: "old" }])).toBeNull();
    expect(parseRoster([{ ...m, relationship: "cousin" }])).toBeNull();
    expect(parseRoster([{ ...m, id: "x".repeat(33) }])).toBeNull();
    expect(parseRoster("Ada")).toBeNull();
    expect(parseRoster([])).toBeNull();
  });
  it("add/update/remove never lose other members and ids stay unique", () => {
    fc.assert(fc.property(rosterArb, (roster) => {
      const added = addMember(roster, { ...emptyMember(nextMemberId(roster)), displayName: "New" });
      expect(added).toHaveLength(roster.length + 1);
      expect(new Set(added.map((m) => m.id)).size).toBe(added.length);
      const updated = updateMember(added, added[0].id, { displayName: "Renamed" });
      expect(updated[0].displayName).toBe("Renamed");
      expect(updated.slice(1)).toEqual(added.slice(1));
      const removed = removeMember(updated, updated[0].id);
      expect(removed).toHaveLength(updated.length - 1);
      expect(removed.some((m) => m.id === updated[0].id)).toBe(false);
      expect(memberOptions(removed).map((o) => o.value)).toEqual(removed.map((m) => m.id));
    }));
  });
  it("keeps blank and untrimmed draft names for the editor, and rejects two self members", () => {
    expect(draftMembers([{ id: "member-1", displayName: "Mary ", relationship: "self", ageBand: "18_to_54" }])[0].displayName).toBe("Mary ");
    expect(draftMembers([{ id: "member-1", displayName: "", relationship: "self", ageBand: "18_to_54" }])).toHaveLength(1);
    expect(draftMembers(undefined)).toEqual([emptyMember("member-1", "self")]);
    const twoSelf = [{ ...emptyMember("member-1", "self"), displayName: "A" }, { ...emptyMember("member-2", "self"), displayName: "B" }];
    expect(parseRoster(twoSelf)).toBeNull();
  });
  it("single member roster works and rosterFromAnswers ignores unknown", () => {
    const solo = [{ ...emptyMember("member-1"), displayName: "Sam" }];
    expect(memberOptions(solo)).toEqual([{ value: "member-1", label: "Sam" }]);
    expect(rosterFromAnswers({ household_roster: { status: "known", value: solo } })).toEqual(solo);
    expect(rosterFromAnswers({ household_roster: { status: "unknown", value: null } })).toEqual([]);
    expect(rosterFromAnswers({})).toEqual([]);
  });
});
