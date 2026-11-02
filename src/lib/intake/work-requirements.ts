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
// statement. ENGINE-ONLY in this milestone: no stage surfaces the
// proposal yet; part 2 (wr-stage-ui) wires the "Matched for you"
// confirm-or-correct surface. The proposal feeds a form answer only;
// nothing here decides whether anyone is exempt from, or meets, a work
// requirement — the state decides that; this screen answers a form field.
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
//    does — deterministically) AND its frequency converts to a month.
//    Two fixed factors per frequency, and no rounding anywhere — the
//    captured number is compared as-is:
//    - a FLOOR factor (weekly ×4, biweekly ×2, twice_monthly ×2, monthly
//      ×1): every calendar month contains at least that many paydays, so
//      amount × floor is a certain minimum monthly figure;
//    - a CEILING factor (weekly ×52/12, biweekly ×26/12, twice_monthly
//      ×2, monthly ×1): the average-month conversion — the most a
//      source's captured amount can average out to per month.
// 3. A captured amount whose frequency is missing, not a known status,
//    or "varies" is UNCOUNTABLE — it cannot be converted deterministically
//    and is never estimated.
// 4. The match also reads income_sources, the session's own list of where
//    money comes from. Sources the three amount questions never capture
//    (self-employed, family/friends, child support) are UNREAD income:
//    the match cannot see them, so they never feed a total.
// 5. The proposal is what is CERTAIN from the captured numbers, in BOTH
//    directions:
//    - "yes" when the FLOOR total is ≥ $580: the counted sources alone
//      cross the threshold, and neither an uncountable amount nor an
//      unread source can lower a real total;
//    - "no" only when EVERYTHING is accounted for — every captured
//      amount converted, no uncountable source, income_sources is known
//      and names none of the unread sources — and the CEILING total is
//      still < $580 (understating a week or fortnight must not fake a
//      "no": $140/week averages ~$606/month, so that session is ASKED,
//      not pre-answered);
//    - anything else (no captured income at all, an uncountable source,
//      or an unread source named in income_sources) → no proposal: the
//      question is ASKED DIRECTLY.
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
 * The fixed monthly factors per frequency option value. A frequency
 * outside this table ("varies", or anything not stored as one of these
 * option values) does not convert — see the rule above. twice_monthly
 * and monthly convert exactly; weekly and biweekly carry the floor /
 * ceiling pair.
 */
const FLOOR_MONTHLY_FACTOR: Readonly<Record<string, number>> = {
  weekly: 4,
  biweekly: 2,
  twice_monthly: 2,
  monthly: 1,
};

const CEILING_MONTHLY_FACTOR: Readonly<Record<string, number>> = {
  weekly: 52 / 12,
  biweekly: 26 / 12,
  twice_monthly: 2,
  monthly: 1,
};

/**
 * The income_sources option values that account for every source of
 * money: the three the amount questions capture, plus "none" (the
 * person's own assertion that no money is coming in at all). Any OTHER
 * option ("self_employed", "family_friends", "child_support") is money
 * the match never sees — see rule 4.
 */
const CAPTURED_SOURCE_VALUES: ReadonlySet<string> = new Set([
  "job",
  "benefits",
  "other",
  "none",
]);

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

/**
 * The stored frequency's monthly factor pair, or null when it does not
 * convert.
 */
function monthlyFactors(
  answers: AnswerMap,
  id: string,
): { floor: number; ceiling: number } | null {
  const stored = answers[id];
  if (!stored || stored.status !== "known") {
    return null;
  }
  const value = stored.value;
  if (typeof value !== "string") {
    return null;
  }
  const floor = FLOOR_MONTHLY_FACTOR[value];
  const ceiling = CEILING_MONTHLY_FACTOR[value];
  return floor === undefined || ceiling === undefined
    ? null
    : { floor, ceiling };
}

/**
 * True when the session's own income_sources answer names a source the
 * three amount questions never capture (rule 4). Unknown or absent —
 * the match cannot rule unread money out.
 */
function namesUnreadSource(answers: AnswerMap): boolean {
  const stored = answers.income_sources;
  if (!stored || stored.status !== "known") {
    return true;
  }
  const value = stored.value;
  const values = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? [value]
      : [];
  return values.some((item) => !CAPTURED_SOURCE_VALUES.has(String(item)));
}

/**
 * The deterministic $580-screen match over stored answers. See the
 * module doc comment for the complete, documented rule.
 */
export function matchIncome580(answers: AnswerMap): Income580Match {
  const countedSourceIds: string[] = [];
  const uncountedSourceIds: string[] = [];
  let floorTotal = 0;
  let ceilingTotal = 0;
  for (const source of INCOME_SOURCES) {
    const amount = knownAmount(answers, source.amountId);
    if (amount === null) {
      continue;
    }
    const factors =
      source.frequencyId === null
        ? { floor: 1, ceiling: 1 }
        : monthlyFactors(answers, source.frequencyId);
    if (factors === null) {
      uncountedSourceIds.push(source.amountId);
      continue;
    }
    countedSourceIds.push(source.amountId);
    floorTotal += amount * factors.floor;
    ceilingTotal += amount * factors.ceiling;
  }
  if (floorTotal >= INCOME_580_MONTHLY_THRESHOLD) {
    // Certain: the counted sources' minimum month already crosses the
    // threshold; neither an uncountable amount nor an unread source can
    // lower a real total.
    return {
      proposal: "yes",
      monthlyTotal: floorTotal,
      countedSourceIds,
      uncountedSourceIds,
    };
  }
  const unreadSource = namesUnreadSource(answers);
  if (
    countedSourceIds.length > 0 &&
    uncountedSourceIds.length === 0 &&
    !unreadSource &&
    ceilingTotal < INCOME_580_MONTHLY_THRESHOLD
  ) {
    // Certain: everything is accounted for (every captured amount
    // converted, no unread source named), and even the average-month
    // conversion stays under the threshold.
    return {
      proposal: "no",
      monthlyTotal: ceilingTotal,
      countedSourceIds,
      uncountedSourceIds: [],
    };
  }
  // Not certain — ask the person directly. (With nothing countable,
  // there is no total to show; with an uncountable source under the
  // threshold, the total is known-incomplete and is never estimated.)
  return {
    proposal: null,
    monthlyTotal: countedSourceIds.length > 0 ? ceilingTotal : null,
    countedSourceIds,
    uncountedSourceIds,
  };
}
