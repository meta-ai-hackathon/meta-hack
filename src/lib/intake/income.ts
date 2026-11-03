import type { AnswerMap } from "./flow";
import type { Question } from "./spec";

// The income stage's client-state block (milestone income-capture part 3;
// VAL-QQ-011 / VAL-INC-001). The journey's results gate is redefined
// deliberately: results = intake complete AND income handled. This module
// is the ONE definition of "income handled" — pure, browser-safe, computed
// from the same visible-question + answer map inputs the rest of the
// intake engines use, so the served payload, the journey UI, and any HTTP
// walkthrough all read the same numbers.
//
// The definition, precisely:
//
// - The income questions are the seven income spec questions (all
//   pii:false — the storage semantics did not change in this milestone).
// - Only VISIBLE income questions count (the flow engine's skip logic
//   decides — e.g. income_sources "none" skips the amount/frequency
//   branches; their absent rows are honest, not gaps).
// - HANDLED = every visible income question has a stored answer (any
//   tri-state status — an "I'm not sure" is an answer everywhere else in
//   this app) AND at least one visible income answer carries an
//   income-stage provenance (`user` from the manual card or a correction,
//   `tax_return` from a confirmed parser proposal).
//
// Why the second clause: the quick-questions and talk stages save income
// answers with the default `user_supplied` provenance. Without the clause,
// intake-complete (which requires those answers to exist) would imply
// income handled, the stage could never render, and the five-stage journey
// (Choose mode → Quick questions → Talk → Income → Results) would have no
// income step. With it, the stage renders on every fresh journey and the
// person confirms or enters income through one of its two real paths
// before results is reachable. The clause is reload-safe: provenances are
// persisted answer-table columns, so the gate re-derives from Postgres on
// every load.

/** The income spec questions the income stage owns (all pii:false). */
export const INCOME_STAGE_QUESTION_IDS = [
  "income_sources",
  "income_kind",
  "job_income_amount",
  "job_income_frequency",
  "benefits_income_amount",
  "benefits_income_frequency",
  "other_income_amount",
] as const;

/** The provenances only the income stage's paths write. */
const INCOME_STAGE_PROVENANCES: readonly string[] = ["user", "tax_return"];

export interface IncomeClientState {
  /** The visible income questions, spec order. */
  readonly questionIds: readonly string[];
  /** How many visible income questions have stored answers. */
  readonly answeredCount: number;
  /** How many carry an income-stage provenance (user | tax_return). */
  readonly confirmedCount: number;
  readonly totalCount: number;
  /**
   * The results gate's income conjunct (VAL-QQ-011): every visible income
   * question answered AND at least one captured or confirmed through the
   * income stage's paths. Vacuously true when no income question is
   * visible (the stage never blocks on nothing).
   */
  readonly handled: boolean;
}

/**
 * The income stage's view of a session's state. Pure: a function of the
 * visible question list and the stored answers.
 */
export function incomeClientState(
  visible: readonly Question[],
  answers: AnswerMap,
): IncomeClientState {
  const incomeIds = new Set<string>(INCOME_STAGE_QUESTION_IDS);
  const visibleIncome = visible.filter((question) =>
    incomeIds.has(question.id),
  );
  const answered = visibleIncome.filter(
    (question) => answers[question.id] !== undefined,
  );
  const confirmed = answered.filter((question) => {
    const provenance = answers[question.id]?.provenance;
    return (
      provenance !== undefined &&
      INCOME_STAGE_PROVENANCES.includes(provenance)
    );
  });
  const totalCount = visibleIncome.length;
  const answeredCount = answered.length;
  const confirmedCount = confirmed.length;
  return {
    questionIds: visibleIncome.map((question) => question.id),
    answeredCount,
    confirmedCount,
    totalCount,
    handled:
      totalCount === 0 ||
      (answeredCount === totalCount && confirmedCount > 0),
  };
}
