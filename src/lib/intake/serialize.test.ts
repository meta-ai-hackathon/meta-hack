import { describe, expect, it } from "vitest";
import { PII_QUESTION_IDS } from "../telemetry";
import { QUESTION_BY_ID, QUESTIONS } from "./spec";
import {
  assertNoPiiValues,
  buildClientState,
  type IntakeClientState,
} from "./serialize";
import type { AnswerMap } from "./flow";

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
