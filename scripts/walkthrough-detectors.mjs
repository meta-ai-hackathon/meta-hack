// Violation detectors for the walkthrough CLI (scripts/walkthrough.mjs).
//
// The CLI drives a running app purely over HTTP, so it cannot import app
// modules — these detectors are the CLI's own vocabulary, and this file is
// the single module both the CLI and the Vitest suite (see
// walkthrough-detectors.test.mjs, VAL-WALK-003) use. Two invariants keep it
// honest:
//
// 1. BANNED_CLAIM_PATTERNS mirrors src/lib/honesty.ts (the honesty spine)
//    pattern-for-pattern; the test suite compares the sources so the two
//    lists cannot drift.
// 2. ANSWER_STATUS_LABELS mirrors src/lib/honesty.ts ANSWER_STATUS_LABELS —
//    the same plain-language, non-promissory tri-state labels.
//
// Plain JavaScript (no TypeScript, no dependencies): the CLI runs on Node's
// built-in fetch alone.

/**
 * Promise language the app must never produce. Identical sources to
 * src/lib/honesty.ts BANNED_CLAIM_PATTERNS — eligibility and approval
 * determinations, guarantees, and benefits-as-promised-outcome phrasing.
 * Hedged uncertainty ("may be eligible") stays allowed.
 */
export const BANNED_CLAIM_PATTERNS = [
  /\byou\s*(?:(?:are|'re|will|'ll|shall|must|should)\s+)?(?:(?:definitely|certainly|clearly|absolutely|fully|obviously|undoubtedly|easily|not)\s+)?(?:going\s+to\s+)?(?:be\s+)?eligible\b/i,
  /\byou\s*(?:(?:are|'re|will|'ll|shall|must|do|should)\s+)?(?:(?:definitely|certainly|clearly|absolutely|fully|obviously|undoubtedly|easily|not)\s+)?(?:going\s+to\s+)?qualify\b/i,
  /\byou\s*(?:(?:are|'re|will|'ll|shall|must|should)\s+)?(?:(?:definitely|certainly|clearly|absolutely|fully|obviously|undoubtedly|easily|not)\s+)?(?:going\s+to\s+)?(?:be\s+)?approved\b/i,
  /\bguaranteed\b/i,
  /\bwe\s+(?:can\s+)?(?:guarantee|promise)\b/i,
  /\byou\s*(?:(?:will|'ll|shall|should|are)\s+)?(?:(?:definitely|certainly|absolutely)\s+)?(?:going\s+to\s+)?(?:get|receive|obtain)\s+(?:the\s+|these\s+|those\s+|your\s+)?benefits\b/i,
  /\b(?:instant|automatic)\s+approval\b/i,
];

/**
 * Plain-language tri-state labels, verbatim from src/lib/honesty.ts. The
 * transcript prints these for every answer; uncertainty is surfaced, never
 * hidden, and no label promises an outcome.
 */
export const ANSWER_STATUS_LABELS = Object.freeze({
  known: "You told us",
  unknown: "You're not sure",
  unverified: "Answered but not verified",
});

/** Find banned promise language in a string (first match per pattern). */
export function findBannedClaims(text) {
  /** @type {BannedClaimHit[]} */
  const hits = [];
  for (const pattern of BANNED_CLAIM_PATTERNS) {
    const found = pattern.exec(text);
    if (found) {
      hits.push({
        patternSource: pattern.source,
        matchedText: found[0].slice(0, 80),
        index: found.index,
      });
    }
  }
  return hits;
}

/**
 * Scan a client-state payload for PII-boundary violations: any answer under
 * a pii:true question that carries a `value` key. The serialization
 * contract (src/lib/intake/serialize.ts) ships status alone for pii
 * answers, so a present value is a leak no matter what it contains.
 *
 * @param {unknown} payload - parsed JSON body of a client-state response
 * @returns {Array<{questionId: string, reason: string}>}
 */
export function findPiiValueLeaks(payload) {
  const leaks = [];
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return leaks;
  }
  const state = /** @type {{questions?: unknown, answers?: unknown}} */ (payload);
  const questions = Array.isArray(state.questions) ? state.questions : [];
  const answers =
    state.answers !== null && typeof state.answers === "object"
      ? /** @type {Record<string, unknown>} */ (state.answers)
      : {};
  const piiIds = new Set(
    questions
      .filter(
        (question) =>
          question !== null &&
          typeof question === "object" &&
          /** @type {{pii?: unknown}} */ (question).pii === true,
      )
      .map(
        (question) =>
          /** @type {{id?: unknown}} */ (question).id,
      )
      .filter((id) => typeof id === "string"),
  );
  for (const [questionId, answer] of Object.entries(answers)) {
    if (
      piiIds.has(questionId) &&
      answer !== null &&
      typeof answer === "object" &&
      "value" in /** @type {object} */ (answer)
    ) {
      leaks.push({ questionId, reason: "value_under_pii_question" });
    }
  }
  return leaks;
}

/**
 * Scan raw response text for values the walkthrough submitted to pii:true
 * questions. None of those values may ever appear in any client-visible
 * body — not in state payloads, not echoed in error messages.
 *
 * @param {string} body - raw response text
 * @param {readonly string[]} privateValues - submitted pii values
 * @returns {Array<{value: string}>}
 */
export function findPiiValueExposure(body, privateValues) {
  const hits = [];
  for (const value of privateValues) {
    if (typeof value === "string" && value.trim() !== "" && body.includes(value)) {
      hits.push({ value });
    }
  }
  return hits;
}
