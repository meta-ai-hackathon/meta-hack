import { describe, expect, it } from "vitest";
import type { Question } from "./spec";
import { QUESTION_BY_ID, QUESTIONS } from "./spec";
import {
  conditionMatches,
  firstUnansweredIndex,
  isQuestionVisible,
  progressCounts,
  visibleQuestions,
  type AnswerMap,
  type StoredAnswer,
} from "./flow";

// Traversal-contract tests for the intake flow engine (BN-09 / HACK-37):
// OR-semantics skip conditions, operators equals/not_equals/in/not_in/gt,
// multi_select any-overlap splitting, and the fail-open rule — only a known
// answer can satisfy an operator; unknown/unverified/absent answers never
// match, so dependent questions stay asked.

function known(value: unknown): StoredAnswer {
  return { status: "known", value };
}

function notSure(): StoredAnswer {
  return { status: "unknown", value: null };
}

function unverified(value: unknown): StoredAnswer {
  return { status: "unverified", value };
}

function answersFor(spec: AnswerMap): AnswerMap {
  return spec;
}

describe("operator: equals / not_equals (single_select)", () => {
  const equalsOther = {
    question_id: "main_goal",
    operator: "equals" as const,
    value: "other",
  };
  const notEqualsOther = {
    question_id: "main_goal",
    operator: "not_equals" as const,
    value: "other",
  };

  it("equals matches only the exact known value", () => {
    expect(conditionMatches(equalsOther, answersFor({ main_goal: known("other") }))).toBe(true);
    expect(conditionMatches(equalsOther, answersFor({ main_goal: known("food") }))).toBe(false);
  });

  it("not_equals matches a different known value, not the same one", () => {
    expect(conditionMatches(notEqualsOther, answersFor({ main_goal: known("food") }))).toBe(true);
    expect(conditionMatches(notEqualsOther, answersFor({ main_goal: known("other") }))).toBe(false);
  });

  it("compares numbers and booleans by value", () => {
    const childrenZero = {
      question_id: "household_children",
      operator: "equals" as const,
      value: 0,
    };
    const veteranTrue = {
      question_id: "veteran_status",
      operator: "equals" as const,
      value: true,
    };
    expect(conditionMatches(childrenZero, answersFor({ household_children: known(0) }))).toBe(true);
    expect(conditionMatches(childrenZero, answersFor({ household_children: known(2) }))).toBe(false);
    expect(conditionMatches(veteranTrue, answersFor({ veteran_status: known(true) }))).toBe(true);
    expect(conditionMatches(veteranTrue, answersFor({ veteran_status: known(false) }))).toBe(false);
  });
});

describe("operator: gt", () => {
  const gtZero = {
    question_id: "household_children",
    operator: "gt" as const,
    value: 0,
  };

  it("matches only a known numeric value strictly greater", () => {
    expect(conditionMatches(gtZero, answersFor({ household_children: known(1) }))).toBe(true);
    expect(conditionMatches(gtZero, answersFor({ household_children: known(0) }))).toBe(false);
    expect(conditionMatches(gtZero, answersFor({ household_children: known(-1) }))).toBe(false);
  });

  it("fails open on non-numeric values", () => {
    expect(conditionMatches(gtZero, answersFor({ household_children: known("two") }))).toBe(false);
  });
});

describe("operator: in / not_in with multi_select any-overlap", () => {
  const inJobSources = {
    question_id: "income_sources",
    operator: "in" as const,
    value: "job,self_employed",
  };
  const notInJobSources = {
    question_id: "income_sources",
    operator: "not_in" as const,
    value: "job,self_employed",
  };

  it("in matches when at least one listed value is selected", () => {
    expect(conditionMatches(inJobSources, answersFor({ income_sources: known(["job"]) }))).toBe(true);
    expect(
      conditionMatches(inJobSources, answersFor({ income_sources: known(["benefits", "job"]) })),
    ).toBe(true);
    expect(
      conditionMatches(inJobSources, answersFor({ income_sources: known(["benefits"]) })),
    ).toBe(false);
  });

  it("not_in matches when none of the listed values are selected", () => {
    expect(
      conditionMatches(notInJobSources, answersFor({ income_sources: known(["family_friends"]) })),
    ).toBe(true);
    expect(
      conditionMatches(
        notInJobSources,
        answersFor({ income_sources: known(["family_friends", "job"]) }),
      ),
    ).toBe(false);
  });

  it("treats single_select answers as a one-value set", () => {
    expect(conditionMatches(inJobSources, answersFor({ income_sources: known("job") }))).toBe(true);
    expect(
      conditionMatches(notInJobSources, answersFor({ income_sources: known("job") })),
    ).toBe(false);
  });

  it("an empty selection is blank and never matches either operator", () => {
    expect(conditionMatches(inJobSources, answersFor({ income_sources: known([]) }))).toBe(false);
    expect(conditionMatches(notInJobSources, answersFor({ income_sources: known([]) }))).toBe(false);
  });
});

describe("fail-open rule", () => {
  const cases = [
    { operator: "equals" as const, value: "job" },
    { operator: "not_equals" as const, value: "job" },
    { operator: "in" as const, value: "job" },
    { operator: "not_in" as const, value: "job" },
    { operator: "gt" as const, value: 0 },
  ];

  it("an absent answer never matches any operator", () => {
    for (const condition of cases) {
      expect(
        conditionMatches({ question_id: "income_sources", ...condition }, answersFor({})),
        condition.operator,
      ).toBe(false);
    }
  });

  it("an unknown answer never matches any operator", () => {
    for (const condition of cases) {
      expect(
        conditionMatches(
          { question_id: "income_sources", ...condition },
          answersFor({ income_sources: notSure() }),
        ),
        condition.operator,
      ).toBe(false);
    }
  });

  it("an unverified answer never matches any operator", () => {
    for (const condition of cases) {
      expect(
        conditionMatches(
          { question_id: "income_sources", ...condition },
          answersFor({ income_sources: unverified("job") }),
        ),
        condition.operator,
      ).toBe(false);
    }
  });

  it("a blank (empty-string or empty-array) known answer never matches", () => {
    for (const condition of cases) {
      for (const blank of ["", []]) {
        expect(
          conditionMatches(
            { question_id: "income_sources", ...condition },
            answersFor({ income_sources: known(blank) }),
          ),
          `${condition.operator} with ${JSON.stringify(blank)}`,
        ).toBe(false);
      }
    }
  });
});

describe("OR semantics across conditions", () => {
  const question: Question = {
    id: "synthetic_dependent",
    prompt: "Synthetic dependent question?",
    type: "number",
    help: "Synthetic help.",
    pii: false,
    required: false,
    skip_conditions: [
      { question_id: "main_goal", operator: "equals", value: "other" },
      { question_id: "application_role", operator: "equals", value: "someone_else" },
    ],
    provenance: "user-supplied",
  };

  it("skips when any one condition matches", () => {
    expect(
      isQuestionVisible(question, answersFor({ main_goal: known("other"), application_role: known("self") })),
    ).toBe(false);
    expect(
      isQuestionVisible(question, answersFor({ main_goal: known("food"), application_role: known("someone_else") })),
    ).toBe(false);
  });

  it("stays visible when no condition matches", () => {
    expect(
      isQuestionVisible(question, answersFor({ main_goal: known("food"), application_role: known("self") })),
    ).toBe(true);
  });

  it("fail-open beats a would-be skip: unknown answers keep the question visible", () => {
    expect(
      isQuestionVisible(question, answersFor({ main_goal: notSure(), application_role: notSure() })),
    ).toBe(true);
  });
});

describe("spec skip chains (real question spec, read-only)", () => {
  function visibleIds(answers: AnswerMap): string[] {
    return visibleQuestions(QUESTIONS, answers).map((question) => question.id);
  }

  it("keeps every required chain anchor present in the spec", () => {
    for (const id of [
      "income_sources",
      "housing_status",
      "household_children",
      "main_goal",
      "id_status",
      "contact_preference",
      "mailing_situation",
    ]) {
      expect(QUESTION_BY_ID[id], id).toBeDefined();
    }
  });

  describe("income_sources chain, both directions", () => {
    it("asks job follow-ups when a listed source is selected", () => {
      const ids = visibleIds(answersFor({ income_sources: known(["job"]) }));
      expect(ids).toContain("job_income_amount");
      expect(ids).toContain("job_income_frequency");
    });

    it("skips job follow-ups when no listed source is selected", () => {
      const ids = visibleIds(answersFor({ income_sources: known(["none"]) }));
      expect(ids).not.toContain("job_income_amount");
      expect(ids).not.toContain("job_income_frequency");
    });

    it("routes benefits follow-ups on the benefits selection only", () => {
      const ids = visibleIds(answersFor({ income_sources: known(["benefits"]) }));
      expect(ids).toContain("benefits_income_amount");
      expect(ids).toContain("benefits_income_frequency");
      expect(ids).not.toContain("job_income_amount");
      expect(ids).not.toContain("other_income_amount");
    });

    it("asks other-income follow-ups for any overlapping source", () => {
      const ids = visibleIds(
        answersFor({ income_sources: known(["family_friends", "child_support"]) }),
      );
      expect(ids).toContain("other_income_amount");
      expect(ids).not.toContain("job_income_amount");
      expect(ids).not.toContain("benefits_income_amount");
    });

    it("asks every income follow-up when the answer is unknown", () => {
      const ids = visibleIds(answersFor({ income_sources: notSure() }));
      expect(ids).toContain("job_income_amount");
      expect(ids).toContain("benefits_income_amount");
      expect(ids).toContain("other_income_amount");
    });
  });

  describe("housing_status chain, both directions", () => {
    it("asks housing costs when staying in a rental or owned place", () => {
      const ids = visibleIds(answersFor({ housing_status: known("rental_or_own") }));
      expect(ids).toContain("housing_cost");
      expect(ids).toContain("utilities_cost");
    });

    it("skips housing costs for each no-cost living situation", () => {
      for (const situation of ["shelter", "car", "outdoors", "nowhere"]) {
        const ids = visibleIds(answersFor({ housing_status: known(situation) }));
        expect(ids, situation).not.toContain("housing_cost");
        expect(ids, situation).not.toContain("utilities_cost");
      }
    });

    it("asks housing costs when the answer is unknown", () => {
      const ids = visibleIds(answersFor({ housing_status: notSure() }));
      expect(ids).toContain("housing_cost");
      expect(ids).toContain("utilities_cost");
    });
  });

  describe("other spec chains", () => {
    it("goal_detail is asked only for the 'other' goal or an unknown goal", () => {
      expect(visibleIds(answersFor({ main_goal: known("other") }))).toContain("goal_detail");
      expect(visibleIds(answersFor({ main_goal: known("food") }))).not.toContain("goal_detail");
      expect(visibleIds(answersFor({ main_goal: notSure() }))).toContain("goal_detail");
    });

    it("childcare_cost is skipped only for a known zero-children answer", () => {
      expect(visibleIds(answersFor({ household_children: known(0) }))).not.toContain("childcare_cost");
      expect(visibleIds(answersFor({ household_children: known(2) }))).toContain("childcare_cost");
      expect(visibleIds(answersFor({ household_children: notSure() }))).toContain("childcare_cost");
    });

    it("id_issue_detail is skipped only for a known have_id answer", () => {
      expect(visibleIds(answersFor({ id_status: known("have_id") }))).not.toContain("id_issue_detail");
      expect(visibleIds(answersFor({ id_status: known("need_id") }))).toContain("id_issue_detail");
      expect(visibleIds(answersFor({ id_status: notSure() }))).toContain("id_issue_detail");
    });

    it("contact follow-ups follow the contact preference with fail-open", () => {
      const byCall = visibleIds(answersFor({ contact_preference: known("call") }));
      expect(byCall).toContain("phone_contact");
      expect(byCall).not.toContain("email_contact");
      expect(byCall).toContain("best_time_to_reach");

      const byEmail = visibleIds(answersFor({ contact_preference: known("email") }));
      expect(byEmail).toContain("email_contact");
      expect(byEmail).not.toContain("phone_contact");

      const inPerson = visibleIds(answersFor({ contact_preference: known("in_person") }));
      expect(inPerson).not.toContain("phone_contact");
      expect(inPerson).not.toContain("email_contact");
      expect(inPerson).not.toContain("best_time_to_reach");

      const notSureCase = visibleIds(answersFor({ contact_preference: notSure() }));
      expect(notSureCase).toContain("phone_contact");
      expect(notSureCase).toContain("email_contact");
      expect(notSureCase).toContain("best_time_to_reach");
    });

    it("shelter mail consent follows the mailing situation with fail-open", () => {
      expect(visibleIds(answersFor({ mailing_situation: known("shelter") }))).toContain(
        "shelter_mail_consent",
      );
      expect(visibleIds(answersFor({ mailing_situation: known("po_box") }))).not.toContain(
        "shelter_mail_consent",
      );
      expect(visibleIds(answersFor({ mailing_situation: notSure() }))).toContain(
        "shelter_mail_consent",
      );
    });
  });
});

describe("progress and next question", () => {
  it("counts answered vs remaining among visible questions only", () => {
    const visible = visibleQuestions(
      QUESTIONS,
      answersFor({ application_role: known("self"), main_goal: known("food") }),
    );
    const progress = progressCounts(visible, {
      application_role: known("self"),
      main_goal: known("food"),
    });
    expect(progress).toEqual({ answered: 2, remaining: visible.length - 2, total: visible.length });
  });

  it("excludes a skipped question's stored answer from progress", () => {
    const visible = visibleQuestions(
      QUESTIONS,
      answersFor({ main_goal: known("food"), goal_detail: known("orphaned answer") }),
    );
    const progress = progressCounts(visible, {
      main_goal: known("food"),
      goal_detail: known("orphaned answer"),
    });
    expect(progress.answered).toBe(1);
  });

  it("finds the first unanswered visible question, or -1 when complete", () => {
    const answers: AnswerMap = { application_role: known("self"), main_goal: known("food") };
    const visible = visibleQuestions(QUESTIONS, answers);
    expect(visible[firstUnansweredIndex(visible, answers)]?.id).toBe("state");

    const completeAnswers: Record<string, StoredAnswer> = {};
    for (const question of QUESTIONS) {
      completeAnswers[question.id] = known("food");
    }
    const completeVisible = visibleQuestions(QUESTIONS, completeAnswers);
    expect(firstUnansweredIndex(completeVisible, completeAnswers)).toBe(-1);
  });
});
