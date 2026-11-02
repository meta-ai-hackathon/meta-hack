import type { AnswerMap } from "./flow";

// The $580/month income screen's deterministic match (work-requirements
// milestone, VAL-WR-008).
//
// Civilla's insert asks the household income screen directly: "Does your
// household make at least $580 in monthly income?" When the session has
// ALREADY captured income answers (the income questions the intake and
// income stages own), the app can match that screen for the person
// instead of re-asking blind. This module is the ONE definition of that
// match: a pure, documented, deterministic comparison over stored answers
// — never an LLM (HACK-86: the engine computes; a model never computes,
// rounds, classifies, or estimates a form number), and never a compliance
// statement. The proposal feeds a form answer only; the person confirms
// or corrects it on the stage ("Matched for you", with the person's own
// answer saved under their provenance when they change it). Nothing here
// decides whether anyone is exempt from, or meets, a work requirement —
// the state decides that; this screen answers a form field.
//
// The documented rule (exactly what the implementation below does):
//
// 1. Sources: the captured income answers — job_income_amount with
//    job_income_frequency, benefits_income_amount with
//    benefits_income_frequency, and other_income_amount (asked "each
//    month", so monthly by definition).
// 2. A source is COUNTABLE when its amount is a known, finite,
//    non-negative number (a captured number question is stored as a
//    number; a numeric string converts the way the answer canonicalizer
//    does — deterministically) AND its frequency converts to a month by
//    a fixed factor: weekly ×4, biweekly ×2, twice_monthly ×2, monthly
//    ×1. A week is treated as a quarter of a month — a conservative
//    whole-month factor (the true average is ~4.33 weeks). Understating
//    income biases the match toward asking/reporting rather than
//    skipping, which is the fail-open direction for a reporting helper.
//    No rounding is applied anywhere: the captured number is compared
//    as-is.
// 3. A captured amount whose frequency is missing, not a known status,
//    or "varies" is UNCOUNTABLE — it cannot be converted deterministically
//    and is never estimated.
// 4. The monthly total is the sum of the countable sources' monthly
//    figures.
// 5. The proposal is what is CERTAIN from the captured numbers:
//    - total ≥ $580 → "yes" (a non-negative uncountable source cannot
//      lower the total, so the threshold is met regardless);
//    - total < $580 with NOTHING uncountable → "no";
//    - anything else (no captured income at all, or total < $580 with an
//      uncountable source) → no proposal: the question is ASKED DIRECTLY.
//
// Pure and browser-safe: imports only the flow engine's answer-map type.
// The import-boundary test (work-requirements.test.ts, per the
// VAL-INC-005 pattern) proves no model/LLM client is reachable from this
// path.

/** The spec question the match proposes an answer for. */
export const INCOME_580_QUESTION_ID = "wr_income_580";

/** The screen's threshold, as printed on the Civilla insert ($580/month). */
export const INCOME_580_MONTHLY_THRESHOLD = 580;

/**
 * The fixed monthly factor per frequency option value. A frequency
 * outside this table ("varies", or anything not stored as one of these
 * option values) does not convert — see the rule above.
 */
const MONTHLY_FACTOR: Readonly<Record<string, number>> = {
  weekly: 4,
  biweekly: 2,
  twice_monthly: 2,
  monthly: 1,
};

/** One income source: an amount question and, when it has one, its frequency. */
interface IncomeSource {
  readonly amountId: string;
  /** null when the amount question is already monthly by definition. */
  readonly frequencyId: string | null;
}

const INCOME_SOURCES: readonly IncomeSource[] = [
  { amountId: "job_income_amount", frequencyId: "job_income_frequency" },
  {
    amountId: "benefits_income_amount",
    frequencyId: "benefits_income_frequency",
  },
  { amountId: "other_income_amount", frequencyId: null },
];

export interface Income580Match {
  /**
   * The proposed answer for the $580 screen — "yes" or "no" when the
   * captured income determines it with certainty, null when the question
   * is asked directly (income not captured, or not deterministically
   * convertible). A FORM ANSWER only: never a statement that anyone is
   * exempt, meets, or satisfies a work requirement — the state decides.
   */
  readonly proposal: "yes" | "no" | null;
  /** The monthly total the counted sources sum to; null with none counted. */
  readonly monthlyTotal: number | null;
  /** The amount questions that fed the total, in the rule's source order. */
  readonly countedSourceIds: readonly string[];
  /**
   * Captured amount questions that could NOT be converted deterministically
   * (a "varies" or missing frequency). Their amounts are never estimated;
   * their presence under the threshold withholds the proposal.
   */
  readonly uncountedSourceIds: readonly string[];
}

/** The stored amount as a countable number, or null when not countable. */
function knownAmount(answers: AnswerMap, id: string): number | null {
  const stored = answers[id];
  // Fail-open, mirroring the flow engine: only a KNOWN answer feeds the
  // match; unknown/unverified/absent never contribute.
  if (!stored || stored.status !== "known") {
    return null;
  }
  const value = stored.value;
  if (typeof value === "number" && Number.isFinite(value)) {
    return value >= 0 ? value : null;
  }
  // Defensive: a numeric string converts exactly as the answer
  // canonicalizer would have (deterministic, no estimation).
  if (typeof value === "string" && value.trim() !== "") {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric >= 0) {
      return numeric;
    }
  }
  return null;
}

/** The stored frequency's monthly factor, or null when it does not convert. */
function monthlyFactor(answers: AnswerMap, id: string): number | null {
  const stored = answers[id];
  if (!stored || stored.status !== "known") {
    return null;
  }
  const value = stored.value;
  if (typeof value !== "string") {
    return null;
  }
  return MONTHLY_FACTOR[value] ?? null;
}

/**
 * The deterministic $580-screen match over stored answers. See the
// module doc comment for the complete, documented rule.
 */
export function matchIncome580(answers: AnswerMap): Income580Match {
  const countedSourceIds: string[] = [];
  const uncountedSourceIds: string[] = [];
  let total = 0;
  for (const source of INCOME_SOURCES) {
    const amount = knownAmount(answers, source.amountId);
    if (amount === null) {
      continue;
    }
    const factor =
      source.frequencyId === null
        ? 1
        : monthlyFactor(answers, source.frequencyId);
    if (factor === null) {
      uncountedSourceIds.push(source.amountId);
      continue;
    }
    countedSourceIds.push(source.amountId);
    total += amount * factor;
  }
  if (total >= INCOME_580_MONTHLY_THRESHOLD) {
    // Certain: the counted sources alone cross the threshold; a
    // non-negative uncountable source cannot lower the total.
    return {
      proposal: "yes",
      monthlyTotal: total,
      countedSourceIds,
      uncountedSourceIds,
    };
  }
  if (countedSourceIds.length > 0 && uncountedSourceIds.length === 0) {
    // Certain: everything captured converted, and the total stays under.
    return {
      proposal: "no",
      monthlyTotal: total,
      countedSourceIds,
      uncountedSourceIds: [],
    };
  }
  // Not certain — ask the person directly. (With nothing countable,
  // there is no total to show; with an uncountable source under the
  // threshold, the total is known-incomplete and is never estimated.)
  return {
    proposal: null,
    monthlyTotal: countedSourceIds.length > 0 ? total : null,
    countedSourceIds,
    uncountedSourceIds,
  };
}
