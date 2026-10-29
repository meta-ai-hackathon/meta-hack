import type { AnswerStatus } from "../honesty";
import type { Question, SkipCondition } from "./spec";

// Intake traversal engine (BN-09 / HACK-37): a pure function of stored
// answers. Implements the question spec's skip contract exactly:
//
// - OR semantics: a question is skipped when ANY of its skip_conditions
//   matches.
// - Operators: equals/not_equals compare exactly; in/not_in treat the
//   condition value as a comma-separated list; gt is numeric.
// - multi_select any-overlap: the answer is a set of selected values —
//   `in` matches when at least one listed value is selected, `not_in`
//   matches when none of the listed values are selected. single_select
//   answers are a one-value set under the same operators.
// - Fail-open: only a KNOWN, non-blank answer can satisfy an operator.
//   Unknown answers, unverified answers, blank values (empty string, empty
//   selection), and absent answers never match, so dependent questions are
//   asked rather than silently dropped.

export interface StoredAnswer {
  readonly status: AnswerStatus;
  /** jsonb-decoded answer value; null/undefined when unknown or blank. */
  readonly value?: unknown;
}

export type AnswerMap = Readonly<Record<string, StoredAnswer | undefined>>;

/** Canonical string set for an answer value (multi_select = many). */
function selectedValues(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item));
  }
  if (typeof value === "string" && value.trim() === "") {
    return [];
  }
  return [String(value)];
}

function listedValues(condition: SkipCondition): string[] {
  return String(condition.value)
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

function equalsSingleSelected(
  selected: readonly string[],
  expected: string | number | boolean,
): boolean {
  return selected.length === 1 && selected[0] === String(expected);
}

export function conditionMatches(
  condition: SkipCondition,
  answers: AnswerMap,
): boolean {
  const stored = answers[condition.question_id];

  // Fail-open: absent, non-known, or blank answers never satisfy an
  // operator, so the dependent question stays in the flow.
  if (!stored || stored.status !== "known") {
    return false;
  }
  const value = stored.value;
  if (value === null || value === undefined) {
    return false;
  }
  const selected = selectedValues(value);
  // Blank answers — empty string or an empty selection — never match any
  // operator, not_in included (an empty selection is not a "none of the
  // above" answer; it is no answer).
  if (selected.length === 0) {
    return false;
  }

  const listed = listedValues(condition);

  switch (condition.operator) {
    case "equals":
      return equalsSingleSelected(selected, condition.value);
    case "not_equals":
      return !equalsSingleSelected(selected, condition.value);
    case "in":
      // Any overlap: at least one listed value is selected.
      return selected.some((item) => listed.includes(item));
    case "not_in":
      // None selected: zero overlap with the listed values.
      return !selected.some((item) => listed.includes(item));
    case "gt": {
      if (Array.isArray(value) || typeof value === "boolean") {
        return false;
      }
      const numeric = Number(value);
      return Number.isFinite(numeric) && numeric > Number(condition.value);
    }
  }
}

/** Visible = not skipped. Skipped when ANY skip condition matches (OR). */
export function isQuestionVisible(
  question: Question,
  answers: AnswerMap,
): boolean {
  return !question.skip_conditions.some((condition) =>
    conditionMatches(condition, answers),
  );
}

/** The questions the flow asks, in spec order, given stored answers. */
export function visibleQuestions(
  questions: readonly Question[],
  answers: AnswerMap,
): Question[] {
  return questions.filter((question) => isQuestionVisible(question, answers));
}

/**
 * Index into the visible list of the first question without a stored
 * answer, or -1 when every visible question is answered (flow complete).
 */
export function firstUnansweredIndex(
  visible: readonly Question[],
  answers: AnswerMap,
): number {
  return visible.findIndex((question) => answers[question.id] === undefined);
}

export interface IntakeProgressCounts {
  readonly answered: number;
  readonly remaining: number;
  readonly total: number;
}

/** Answered vs remaining over the visible questions only. */
export function progressCounts(
  visible: readonly Question[],
  answers: AnswerMap,
): IntakeProgressCounts {
  const answered = visible.filter(
    (question) => answers[question.id] !== undefined,
  ).length;
  return {
    answered,
    remaining: visible.length - answered,
    total: visible.length,
  };
}
