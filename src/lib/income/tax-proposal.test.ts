import { describe, expect, it } from "vitest";
import { QUESTIONS } from "../intake/spec";
import {
  TAX_RETURN_PROPOSED_QUESTION_IDS,
  proposalsFromMonthlyDerived,
} from "./tax-proposal";

// The stage UI's proposal mapping (milestone income-capture part 3): the
// ONE figure the UI proposes for confirm-or-correct from a parsed tax
// return is the PRIOR-YEAR monthly figure (AGI ÷ 12 — the documented
// deterministic rule) proposed onto job_income_amount, with the matching
// monthly frequency. These proposals are the ONLY ids the confirm route
// admits action:"confirm" for (the orchestrator note from the part-2
// review: tax_return provenance is otherwise client-asserted by design —
// the UI's actual proposal set closes that gap).

describe("TAX_RETURN_PROPOSED_QUESTION_IDS", () => {
  it("is exactly the two ids the stage UI proposes, both income spec questions", () => {
    expect([...TAX_RETURN_PROPOSED_QUESTION_IDS]).toEqual([
      "job_income_amount",
      "job_income_frequency",
    ]);
    for (const id of TAX_RETURN_PROPOSED_QUESTION_IDS) {
      expect(QUESTIONS.find((q) => q.id === id), id).toBeDefined();
    }
  });
});

describe("proposalsFromMonthlyDerived", () => {
  it("proposes the prior-year monthly figure for job_income_amount with a monthly frequency", () => {
    const proposals = proposalsFromMonthlyDerived(4017);
    expect(proposals).toEqual([
      {
        questionId: "job_income_amount",
        value: 4017,
        origin: "tax_return",
      },
      {
        questionId: "job_income_frequency",
        value: "monthly",
        origin: "tax_return",
      },
    ]);
  });

  it("proposes NOTHING when no monthly figure was derived (never a confident 0)", () => {
    // A negative/non-finite AGI yields monthlyDerived null — the proposal
    // list is empty, so nothing is confirmable and nothing can masquerade
    // as a derived zero income.
    expect(proposalsFromMonthlyDerived(null)).toEqual([]);
  });

  it("never proposes for any other income question", () => {
    const proposals = proposalsFromMonthlyDerived(1234);
    expect(proposals.every((p) =>
      (TAX_RETURN_PROPOSED_QUESTION_IDS as readonly string[]).includes(
        p.questionId,
      ),
    )).toBe(true);
  });
});
