import { describe, expect, it } from "vitest";
import { PII_QUESTION_IDS } from "../telemetry";
import { QUESTION_BY_ID, QUESTIONS } from "./spec";
import {
  assertNoPiiValues,
  buildClientState,
  type IntakeClientState,
} from "./serialize";
import type { AnswerMap, StoredAnswer } from "./flow";
import {
  DEFAULT_PROGRAM_IDS,
  requiredForPrograms,
} from "./requirements";

// Client-state serialization tests (BN-09): the client-visible payload
// contains ONLY pii:false answer values. pii:true answers surface as their
// tri-state status alone — the value is structurally omitted, proven here
// across the full pii population from the question spec (VAL-INTAKE-004).

/**
 * Distinctive per-field values so a leak of any one of them is detectable.
 * Every sentinel is a string that appears nowhere in the spec's option
 * values or JSON structure, so any containment match is a real leak.
 * Two pii questions cannot carry a distinctive string sentinel:
 * mailing_situation must hold "shelter" (a spec option) so the dependent
 * shelter_mail_consent stays visible, and shelter_mail_consent holds a
 * boolean whose JSON literal collides with structure flags like
 * "required":true — both are covered by the exact answer-shape check below.
 */
function piiSentinels(): Record<string, unknown> {
  return {
    goal_detail: "SENTINEL-GOAL-DETAIL-VALUE",
    county: "SENTINEL-COUNTY-VALUE",
    housing_status: "SENTINEL-HOUSING-VALUE",
    id_issue_detail: "SENTINEL-ID-ISSUE-VALUE",
    date_of_birth: "1990-01-01",
    citizenship_status: "SENTINEL-CITIZENSHIP-VALUE",
    disability_status: "SENTINEL-DISABILITY-VALUE",
    phone_contact: "555-010-0000",
    email_contact: "sentinel@example.com",
  };
}

function fullAnswers(): AnswerMap {
  const sentinels = piiSentinels();
  const answers: Record<string, { status: "known" | "unknown"; value: unknown }> = {};
  for (const question of QUESTIONS) {
    const value = sentinels[question.id] ?? "answer-for-" + question.id;
    answers[question.id] = { status: "known", value };
  }
  // Keep every pii question visible: main_goal = other asks goal_detail,
  // mailing_situation = shelter asks shelter_mail_consent, and contact
  // unknown (fail-open) asks phone_contact + email_contact.
  answers.main_goal = { status: "known", value: "other" };
  answers.mailing_situation = { status: "known", value: "shelter" };
  answers.shelter_mail_consent = { status: "known", value: true };
  answers.contact_preference = { status: "unknown", value: null };
  // Income-kind branch (HACK-85): income_kind = both keeps the whole branch
  // visible, and prior_employer_current = no_longer_there keeps the pii:true
  // prior_employer_last_month visible too.
  answers.income_kind = { status: "known", value: "both" };
  answers.prior_employer_current = { status: "known", value: "no_longer_there" };
  return answers;
}

describe("buildClientState", () => {
  it("includes only visible questions, in spec order", () => {
    // main_goal = food skips goal_detail entirely.
    const answers: AnswerMap = { main_goal: { status: "known", value: "food" } };
    const state = buildClientState(answers);
    const ids = state.questions.map((question) => question.id);
    expect(ids).not.toContain("goal_detail");
    expect(ids).toEqual(
      QUESTIONS.filter((question) => question.id !== "goal_detail").map(
        (question) => question.id,
      ),
    );
  });

  it("carries spec prompts, help, options, and flags for the client", () => {
    const state = buildClientState({});
    const income = state.questions.find((question) => question.id === "income_sources");
    expect(income?.prompt).toBe("Where does money come from for your household?");
    expect(income?.help).toContain("Pick every source that fits.");
    expect(income?.options).toEqual(QUESTION_BY_ID.income_sources?.options);
    const county = state.questions.find((question) => question.id === "county");
    expect(county?.pii).toBe(true);
    expect(county?.options).toBeUndefined();
  });

  it("includes values only for pii:false answers", () => {
    const answers: AnswerMap = {
      application_role: { status: "known", value: "self" },
      housing_status: { status: "known", value: "car" },
      county: { status: "unknown", value: null },
    };
    const state = buildClientState(answers);
    expect(state.answers.application_role).toEqual({ status: "known", value: "self" });
    expect(state.answers.housing_status).toEqual({ status: "known" });
    expect(state.answers.county).toEqual({ status: "unknown" });
  });

  it("omits answers for skipped questions entirely", () => {
    const answers: AnswerMap = {
      main_goal: { status: "known", value: "food" },
      goal_detail: { status: "known", value: "SENTINEL-ORPHANED" },
    };
    const state = buildClientState(answers);
    expect(state.answers.goal_detail).toBeUndefined();
  });

  it("reports progress and completion over visible questions", () => {
    const empty = buildClientState({});
    expect(empty.complete).toBe(false);
    expect(empty.currentIndex).toBe(0);
    expect(empty.progress.answered).toBe(0);
    expect(empty.progress.total).toBe(empty.questions.length);
    expect(empty.progress.remaining).toBe(empty.questions.length);

    const all = fullAnswers();
    const complete = buildClientState(all);
    expect(complete.complete).toBe(true);
    expect(complete.currentIndex).toBeNull();
    expect(complete.progress.remaining).toBe(0);
    expect(complete.progress.answered).toBe(complete.progress.total);
  });
});

describe("no pii reaches the client payload (VAL-INTAKE-004)", () => {
  it("every pii:true question's value is absent from the serialized state", () => {
    const state = buildClientState(fullAnswers());
    const json = JSON.stringify(state);
    for (const [questionId, value] of Object.entries(piiSentinels())) {
      expect(PII_QUESTION_IDS, questionId).toContain(questionId);
      expect(json, `leak check for ${questionId}`).not.toContain(String(value));
    }
  });

  it("still exposes pii question structure (ids, prompts) so the flow can render", () => {
    const state = buildClientState(fullAnswers());
    const json = JSON.stringify(state);
    for (const id of PII_QUESTION_IDS) {
      expect(json, id).toContain(id);
    }
  });

  it("keeps statuses for pii answers visible to the badge", () => {
    const state = buildClientState(fullAnswers());
    for (const id of PII_QUESTION_IDS) {
      expect(state.answers[id]?.status, id).toBe("known");
    }
  });
});

describe("income in the client payload (milestone income-capture, VAL-QQ-011/INC-003)", () => {
  it("exposes the income gate unhandled on a fresh session", () => {
    const state = buildClientState({});
    expect(state.income.totalCount).toBe(7);
    expect(state.income.answeredCount).toBe(0);
    expect(state.income.confirmedCount).toBe(0);
    expect(state.income.handled).toBe(false);
  });

  it("derives handled from the answers' provenances over the visible set", () => {
    // user_supplied income answers (the QQ/talk paths) answer the
    // questions but never satisfy the gate — the income stage's paths
    // (user | tax_return) must capture or confirm income once.
    const base: AnswerMap = {
      income_sources: { status: "known", value: ["job"] },
      income_kind: { status: "known", value: "prior_employer_only" },
      job_income_amount: { status: "known", value: 2400 },
      job_income_frequency: { status: "known", value: "biweekly" },
    };
    const supplied = buildClientState(base);
    expect(supplied.income.answeredCount).toBe(supplied.income.totalCount);
    expect(supplied.income.handled).toBe(false);

    const confirmed = buildClientState({
      ...base,
      job_income_amount: {
        status: "known",
        value: 4017,
        provenance: "tax_return",
      },
    });
    expect(confirmed.income.confirmedCount).toBe(1);
    expect(confirmed.income.handled).toBe(true);
  });

  it("carries the provenance field only when it is not the default user_supplied", () => {
    const state = buildClientState({
      application_role: { status: "known", value: "self" },
      job_income_amount: {
        status: "known",
        value: 4017,
        provenance: "tax_return",
      },
      job_income_frequency: {
        status: "known",
        value: "monthly",
        provenance: "user",
      },
    });
    // The default path's shape is byte-identical to its historical one.
    expect(state.answers.application_role).toEqual({
      status: "known",
      value: "self",
    });
    // The income stage's badges read provenance where it carries meaning.
    expect(state.answers.job_income_amount).toEqual({
      status: "known",
      value: 4017,
      provenance: "tax_return",
    });
    expect(state.answers.job_income_frequency).toEqual({
      status: "known",
      value: "monthly",
      provenance: "user",
    });
  });
});

describe("quick questions in the client payload (VAL-QQ-004)", () => {
  it("exposes the computed N-of-M counter for the default programs", () => {
    const state = buildClientState({});
    expect(state.quickQuestions.programs).toEqual(DEFAULT_PROGRAM_IDS);
    expect(state.quickQuestions.requiredCount).toBe(
      requiredForPrograms(DEFAULT_PROGRAM_IDS).length,
    );
    // A fresh session: nothing answered, nothing skippable yet — N = M.
    expect(state.quickQuestions.remainingCount).toBe(
      state.quickQuestions.requiredCount,
    );
    expect(state.quickQuestions.complete).toBe(false);
  });

  it("matches the engine's computation over real answer maps", () => {
    const samples: AnswerMap[] = [
      {},
      fullAnswers(),
      { income_sources: { status: "known", value: ["none"] } },
      { income_sources: { status: "unknown", value: null } },
      {
        housing_status: { status: "known", value: "rental_or_own" },
        household_children: { status: "known", value: 2 },
      },
    ];
    for (const answers of samples) {
      const state = buildClientState(answers);
      expect(state.quickQuestions.remainingIds).toEqual(
        requiredForPrograms(DEFAULT_PROGRAM_IDS).filter(
          (id) =>
            answers[id] === undefined &&
            state.questions.some((question) => question.id === id),
        ),
      );
      expect(state.quickQuestions.requiredCount).toBe(
        requiredForPrograms(DEFAULT_PROGRAM_IDS).length,
      );
      expect(state.quickQuestions.remainingCount).toBe(
        state.quickQuestions.remainingIds.length,
      );
    }
  });

  it("decrements N as the universe is answered and never exceeds M", () => {
    // A greedy walk of the real flow: answer the first still-to-ask
    // question each round (skips handled by the engine, fail-open), until
    // nothing remains. N strictly decreases each round; M never moves.
    const answers: Record<string, StoredAnswer> = {};
    let view = buildClientState(answers).quickQuestions;
    const M = view.requiredCount;
    expect(view.remainingCount).toBe(M);
    while (view.remainingIds.length > 0) {
      const previous = view.remainingCount;
      const next = view.remainingIds[0]!;
      answers[next] = { status: "known", value: "answer-for-" + next };
      view = buildClientState(answers).quickQuestions;
      expect(view.requiredCount).toBe(M);
      expect(view.remainingCount, next).toBeLessThan(previous);
      expect(view.remainingCount).toBeLessThanOrEqual(view.requiredCount);
    }
    expect(view.remainingCount).toBe(0);
    expect(view.complete).toBe(true);
  });

  it("carries only ids and counts — never an answer value", () => {
    const state = buildClientState(fullAnswers());
    const json = JSON.stringify(state.quickQuestions);
    expect(json).not.toContain("SENTINEL");
    expect(json).not.toContain("answer-for-");
    // Every remaining id has a client-safe definition in the payload for
    // the stage to render.
    const ids = new Set(state.questions.map((question) => question.id));
    for (const id of state.quickQuestions.remainingIds) {
      expect(ids.has(id), id).toBe(true);
    }
  });
});

describe("assertNoPiiValues (defense in depth)", () => {
  it("passes on a legitimately built state", () => {
    expect(() => assertNoPiiValues(buildClientState(fullAnswers()))).not.toThrow();
  });

  it("throws when a pii answer would carry a value", () => {
    const poisoned: IntakeClientState = {
      ...buildClientState({}),
      answers: {
        housing_status: { status: "known", value: "car" },
      },
    };
    expect(() => assertNoPiiValues(poisoned)).toThrow();
  });

  it("passes when a pii answer carries only a status", () => {
    const safe: IntakeClientState = {
      ...buildClientState({}),
      answers: {
        housing_status: { status: "unknown" },
      },
    };
    expect(() => assertNoPiiValues(safe)).not.toThrow();
  });
});
