import { describe, expect, it } from "vitest";
import { QUESTION_BY_ID, QUESTIONS } from "./spec";
import type { AnswerMap } from "./flow";
import type { AnswerProvenance } from "../honesty";
import {
  INCOME_STAGE_QUESTION_IDS,
  incomeClientState,
} from "./income";

// The income stage's client-state block (milestone income-capture part 3;
// VAL-QQ-011 / VAL-INC-001): the journey's results gate needs a deliberate,
// state-derived definition of "income handled". The derivation is pure and
// lives beside the other intake engines so the served payload, the journey
// UI, and any HTTP walkthrough all read the SAME numbers.

/** All seven income questions as the visible list (fresh session). */
function visibleIncomeAll() {
  return QUESTIONS.filter((q) =>
    (INCOME_STAGE_QUESTION_IDS as readonly string[]).includes(q.id),
  );
}

/**
 * The visible income set for an income_sources = [job] session: sources,
 * kind, and the job branch — the flow engine skips the benefits/other
 * branches for that answer.
 */
function visibleIncomeJobShape() {
  return visibleIncomeAll().filter(
    (q) =>
      q.id === "income_sources" ||
      q.id === "income_kind" ||
      q.id.startsWith("job_income_"),
  );
}

/**
 * Income answers for the [job] shape: the four visible questions answered
 * user_supplied (the default provenance the QQ/talk stages write).
 * Overlays any per-question overrides (status/value/provenance).
 */
function incomeAnswers(
  overrides: Record<
    string,
    {
      status: "known" | "unknown";
      value: unknown;
      provenance?: AnswerProvenance;
    }
  > = {},
): AnswerMap {
  const answers: Record<
    string,
    {
      status: "known" | "unknown";
      value: unknown;
      provenance?: AnswerProvenance;
    }
  > = {
    income_sources: { status: "known", value: ["job"] },
    income_kind: { status: "known", value: "prior_employer_only" },
    job_income_amount: { status: "known", value: 2400 },
    job_income_frequency: { status: "known", value: "biweekly" },
  };
  for (const [id, answer] of Object.entries(overrides)) {
    answers[id] = answer;
  }
  return answers;
}

describe("INCOME_STAGE_QUESTION_IDS", () => {
  it("is exactly the seven income spec questions, all pii:false", () => {
    expect([...INCOME_STAGE_QUESTION_IDS]).toEqual([
      "income_sources",
      "income_kind",
      "job_income_amount",
      "job_income_frequency",
      "benefits_income_amount",
      "benefits_income_frequency",
      "other_income_amount",
    ]);
    for (const id of INCOME_STAGE_QUESTION_IDS) {
      expect(QUESTION_BY_ID[id], id).toBeDefined();
      expect(QUESTION_BY_ID[id]?.pii, id).toBe(false);
    }
  });
});

describe("incomeClientState (the results gate's income conjunct)", () => {
  it("is unhandled on a fresh session: nothing answered, nothing confirmed", () => {
    const view = incomeClientState(visibleIncomeAll(), {});
    expect(view.totalCount).toBe(7);
    expect(view.answeredCount).toBe(0);
    expect(view.confirmedCount).toBe(0);
    expect(view.handled).toBe(false);
  });

  it("is unhandled when every visible income answer is user_supplied — the income stage must still be visited", () => {
    // The QQ/talk stages save income answers as user_supplied; that alone
    // never satisfies the gate — the income stage's own paths (provenance
    // user | tax_return) must capture or confirm income at least once
    // (VAL-INC-001: the stage sits between talk-complete and results, so a
    // fresh journey reliably shows it).
    const view = incomeClientState(
      visibleIncomeJobShape(),
      incomeAnswers(),
    );
    expect(view.totalCount).toBe(4);
    expect(view.answeredCount).toBe(view.totalCount);
    expect(view.confirmedCount).toBe(0);
    expect(view.handled).toBe(false);
  });

  it("is handled once at least one visible income answer carries an income-stage provenance", () => {
    const answers = incomeAnswers({
      job_income_amount: { status: "known", value: 2400, provenance: "user" },
    });
    const view = incomeClientState(visibleIncomeJobShape(), answers);
    expect(view.confirmedCount).toBe(1);
    expect(view.handled).toBe(true);
  });

  it("counts a tax_return confirmation the same as a manual save", () => {
    const answers = incomeAnswers({
      job_income_amount: {
        status: "known",
        value: 4017,
        provenance: "tax_return",
      },
    });
    expect(incomeClientState(visibleIncomeJobShape(), answers).handled).toBe(
      true,
    );
  });

  it("is unhandled while any visible income question lacks a stored answer", () => {
    const answers = incomeAnswers({
      job_income_amount: { status: "known", value: 2400, provenance: "user" },
    });
    const partial: Record<string, { status: "known"; value: unknown }> = {};
    for (const [id, answer] of Object.entries(answers)) {
      if (id !== "job_income_frequency") {
        partial[id] = answer as { status: "known"; value: unknown };
      }
    }
    const view = incomeClientState(visibleIncomeJobShape(), partial);
    expect(view.answeredCount).toBe(view.totalCount - 1);
    expect(view.handled).toBe(false);
  });

  it("never counts a non-visible income answer toward the gate", () => {
    // The benefits/other branches are skipped for [job]: their stale rows
    // (even tax_return ones) must not satisfy the gate — the visible,
    // relevant income set decides. The visible confirmation here is the
    // person's manual job-income save (provenance user).
    const answers = incomeAnswers({
      job_income_amount: { status: "known", value: 2400, provenance: "user" },
      benefits_income_amount: {
        status: "known",
        value: 500,
        provenance: "tax_return",
      },
      benefits_income_frequency: {
        status: "known",
        value: "monthly",
        provenance: "tax_return",
      },
      other_income_amount: {
        status: "known",
        value: 100,
        provenance: "tax_return",
      },
    });
    const view = incomeClientState(visibleIncomeJobShape(), answers);
    expect(view.totalCount).toBe(4);
    expect(view.confirmedCount).toBe(1);
    expect(view.handled).toBe(true);
  });

  it("is vacuously handled when no income question is visible — the stage never blocks on nothing", () => {
    const visible = QUESTIONS.filter(
      (q) => !(INCOME_STAGE_QUESTION_IDS as readonly string[]).includes(q.id),
    );
    const view = incomeClientState(visible, {});
    expect(view.totalCount).toBe(0);
    expect(view.handled).toBe(true);
  });
});
