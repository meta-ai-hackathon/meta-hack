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
  /\byou\s*(?:(?:are|'re|will|'ll|shall|must|should)\s+)?(?:(?:definitely|certainly|clearly|absolutely|fully|obviously|undoubtedly|easily|not|still)\s+)?(?:going\s+to\s+)?(?:be\s+)?eligible\b/i,
  /\byou\s*(?:(?:are|'re|will|'ll|shall|must|do|should)\s+)?(?:(?:definitely|certainly|clearly|absolutely|fully|obviously|undoubtedly|easily|not|still)\s+)?(?:going\s+to\s+)?qualify\b/i,
  /\byou\s*(?:(?:are|'re|will|'ll|shall|must|should)\s+)?(?:(?:definitely|certainly|clearly|absolutely|fully|obviously|undoubtedly|easily|not|still)\s+)?(?:going\s+to\s+)?(?:be\s+)?(?:re-?)?approved\b/i,
  /\bguaranteed\b/i,
  /\bwe\s+(?:can\s+)?(?:guarantee|promise)\b/i,
  /\byou\s*(?:(?:will|'ll|shall|should|are)\s+)?(?:(?:definitely|certainly|absolutely)\s+)?(?:going\s+to\s+)?(?:get|receive|obtain)\s+(?:the\s+|these\s+|those\s+|your\s+)?benefits\b/i,
  /\b(?:instant|automatic)\s+approval\b/i,
  // Criteria-satisfaction determinations ("meets the income rules" phrasing,
  // droid-review P3-2 on PR #45). Identical source to src/lib/honesty.ts —
  // the drift test below pins the two lists together.
  // "documentation" is deliberately absent: "document" + \w* already covers
  // it, and the redundant alternative makes the repetition ambiguous
  // (exponential backtracking — the CodeQL js/redos alert). Past-tense
  // (met) and satisfy forms are determinations too; terminal nouns take an
  // optional plural. The lookbehind spares open conditionals; reported
  // determinations ("your answers show you meet...") stay banned.
  /(?<!\b(?:if|whether|once|when|until|unless)\s+)\b(?:you|he|she|they)\s*(?:(?:will|'ll|'ve|have|shall|should|do|did|don't|doesn't|didn't|won't|haven't|hasn't|definitely|certainly|clearly|absolutely|fully|obviously|undoubtedly|easily)\s+(?:not\s+)?)?(?:meets?|met|satisfied|satisfies|satisfy)\s+(?:all\s+|any\s+|every\s+|each\s+|some\s+|the\s+|these\s+|those\s+|your\s+|its\s+|their\s+|of\s+)*(?:(?:income|program|program's|eligibility|asset|resource|residency|household|immigration|document|disability|citizenship|application)\w*\s+)*(?:rules?|requirements?|criteria|guidelines?|limits?|thresholds?|conditions?|standards?)\b/i,
  // Renewal-time promises (HACK-50): continued coverage, never losing it,
  // the same two about someone else the renewal is for, coverage or
  // renewal outcomes, being renewed, and no gap in coverage. Identical
  // sources to src/lib/honesty.ts, which explains each one; the drift test
  // pins the two lists together.
  /(?<!\b(?:if|whether|once|when|until|unless|how|do|does|did|will|would|can|could|should|are|don't|doesn't|didn't|won't|wouldn't|can't|couldn't|shouldn't|aren't|isn't)\s+|\byou\s+(?:told\s+us|said|reported)\s+)\byou\s*(?:(?:will|'ll|shall|(?:are|'re)\s+going\s+to)\s+)?(?:(?:definitely|certainly|absolutely|still)\s+)?(?:(?:stay|remain)\s+(?:eligible|enrolled|covered|insured|on\s+(?:nc\s+)?medicaid)|(?:keep|continue\s+to\s+(?:have|get|receive)|still\s+have)\s+(?:your\s+)?(?:coverage|benefits|medicaid|nc\s+medicaid|health\s+(?:coverage|insurance|care))|continue\s+to\s+(?:be\s+(?:eligible|enrolled|covered|insured)|qualify)|be\s+(?:covered|enrolled|insured)|(?:are|'re)\s+(?:(?:still\s+)?covered|still\s+(?:enrolled|insured)|(?:enrolled|insured)\s+(?:in|on|by|through|under|with)\s+(?:(?:a|an|the|your)\s+)?(?:nc\s+)?(?:medicaid|health\s+(?:coverage|insurance|care|plans?))))\b/i,
  /(?<!\b(?:if|whether|once|when|until|unless|how|do|does|did|will|would|can|could|should|are|don't|doesn't|didn't|won't|wouldn't|can't|couldn't|shouldn't|aren't|isn't)\s+|\byou\s+(?:told\s+us|said|reported)\s+)\byou\s*(?:won't|will\s+not|will\s+never|'ll\s+not|'ll\s+never|can't|cannot|can\s+not|can\s+never|never|(?:are|'re)\s+(?:not|never)\s+going\s+to)\s+(?:(?:ever|definitely|certainly)\s+)?(?:lose\s+(?:your\s+)?(?:coverage|benefits|medicaid|nc\s+medicaid|health\s+(?:coverage|insurance|care))|be\s+(?:cut\s+off|dropped|disenrolled|kicked\s+off))\b/i,
  /(?<!\b(?:if|whether|once|when|until|unless|how|do|does|did|will|would|can|could|should|are|don't|doesn't|didn't|won't|wouldn't|can't|couldn't|shouldn't|aren't|isn't)\s+|\byou\s+(?:told\s+us|said|reported)\s+)\b(?:he|she|they|your\s+(?:child|children|kids?|son|daughter|baby|family|household))\s*(?:(?:will|'ll|(?:is|'s|are|'re)\s+going\s+to)\s+(?:(?:definitely|certainly|absolutely|still)\s+)?(?:(?:stay|remain)\s+(?:eligible|enrolled|covered|insured|on\s+(?:nc\s+)?medicaid)|(?:keep|continue\s+to\s+(?:have|get|receive)|still\s+have)\s+(?:their\s+|his\s+|her\s+)?(?:coverage|benefits|medicaid|nc\s+medicaid|health\s+(?:coverage|insurance|care))|continue\s+to\s+(?:be\s+(?:eligible|enrolled|covered|insured)|qualify)|never\s+lose\s+(?:their\s+|his\s+|her\s+)?(?:coverage|benefits|medicaid|nc\s+medicaid|health\s+(?:coverage|insurance|care)))|(?:won't|will\s+not|will\s+never|'ll\s+not|'ll\s+never)\s+(?:lose\s+(?:their\s+|his\s+|her\s+)?(?:coverage|benefits|medicaid|nc\s+medicaid|health\s+(?:coverage|insurance|care))|be\s+(?:cut\s+off|dropped|disenrolled|kicked\s+off)))\b/i,
  /(?<!\b(?:if|whether|once|when|until|unless|how|do|does|did|will|would|can|could|should|are|don't|doesn't|didn't|won't|wouldn't|can't|couldn't|shouldn't|aren't|isn't)\s+|\byou\s+(?:told\s+us|said|reported)\s+)\byour\s+(?:nc\s+)?(?:coverage|benefits|medicaid|eligibility|renewal|recertification|application|health\s+(?:coverage|insurance|care))\s+(?:(?:will|'ll|is\s+going\s+to)\s+(?:(?:definitely|certainly|absolutely|still)\s+)?(?:be\s+(?:renewed|approved|re-?approved|continued|extended|accepted)|continue|renew|carry\s+over|go\s+through|happen\s+automatically)|(?:still\s+)?continues?|(?:is|was|has\s+been)\s+(?:(?:already|definitely|certainly)\s+)?(?:approved|re-?approved|accepted|extended|confirmed|safe|automatic)|(?:was|has\s+been)\s+(?:(?:already|definitely|certainly)\s+)?renewed|is\s+(?:(?:already|definitely|certainly)\s+)?renewed(?!,?\s+(?:which\s+happens\s+)?(?:every|once|each|twice)\b)|(?:won't|will\s+not|will\s+never|'ll\s+not|'ll\s+never|isn't\s+going\s+to|is\s+not\s+going\s+to|aren't\s+going\s+to|are\s+not\s+going\s+to)\s+(?:end|stop|lapse|be\s+(?:cut|cancell?ed|terminated|ended|stopped|dropped|taken\s+away))|(?:happens|renews)\s+automatically)\b/i,
  /(?<!\b(?:if|whether|once|when|until|unless|how|do|does|did|will|would|can|could|should|are|don't|doesn't|didn't|won't|wouldn't|can't|couldn't|shouldn't|aren't|isn't)\s+|\byou\s+(?:told\s+us|said|reported)\s+)\byou\s*(?:(?:are|'re|will|'ll|shall|must|should)\s+)?(?:(?:definitely|certainly|absolutely|already|automatically|still)\s+)?(?:going\s+to\s+)?(?:be|get|are|'re)\s+(?:automatically\s+)?(?:renewed|recertified|re-?enrolled)\b/i,
  /\bthere\s+(?:(?:will|'ll)\s+(?:definitely\s+)?be\s+no|(?:won't|will\s+not|'ll\s+not)\s+(?:ever\s+)?be\s+(?:a|any))\s+(?:gap|break|pause)\s+in\s+your\s+(?:nc\s+)?(?:coverage|benefits|medicaid|health\s+(?:coverage|insurance|care))\b/i,
];

/**
 * Typographic apostrophes read as the straight one and zero-width
 * characters as spaces before matching. Identical to src/lib/honesty.ts
 * foldForClaimScan; the drift test runs both on the same text.
 *
 * @param {string} text
 * @returns {string}
 */
export function foldForClaimScan(text) {
  return text.replace(/[\u2018\u2019\u201b\u02bc]/g, "'").replace(/[\u200b-\u200d\u2060\ufeff]/g, " ");
}

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
  const hits = [];
  const folded = foldForClaimScan(text);
  for (const pattern of BANNED_CLAIM_PATTERNS) {
    const found = pattern.exec(folded);
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

// ---------------------------------------------------------------------------
// v2 detectors (Mission v2 M5, VAL-WALK2-002): the conversational and
// form-driven journeys exercise surfaces the wizard never sees — assistant
// turns, redacted transcripts, subtitles, match cards, review views. These
// detectors extend the same fail-closed vocabulary to them. As before, the
// Vitest suite (walkthrough-detectors.test.mjs) runs these against
// committed fixtures so the checks provably bite. (Assistant-turn
// banned-claim detection reuses findBannedClaims directly at the turn call
// site, which records the assistant-specific violation kind and context.)
// ---------------------------------------------------------------------------

/**
 * Pii-echo detection on ANY client payload (v2): walk every string in a
 * parsed JSON body — assistant replies, redacted transcripts, subtitle
 * fields, client state, match cards, review fields, error messages — and
 * report every PATH where a submitted private value appears. The report
 * names paths, never values (the value is private content; the transcript
 * must not repeat what it flags).
 *
 * @param {unknown} payload - parsed JSON body of any client-visible response
 * @param {readonly string[]} privateValues - submitted pii values
 * @param {number} [maxDepth] - recursion bound for nested structures
 * @returns {Array<{path: string, reason: string}>}
 */
export function findPiiEcho(payload, privateValues, maxDepth = 12) {
  const echoes = [];
  const clean = privateValues.filter(
    (value) => typeof value === "string" && value.trim() !== "",
  );
  if (clean.length === 0) {
    return echoes;
  }
  const visit = (node, path, depth) => {
    if (typeof node === "string") {
      for (const value of clean) {
        if (node.includes(value)) {
          echoes.push({ path: path === "" ? "(root)" : path, reason: "private_value_in_payload" });
        }
      }
      return;
    }
    if (node === null || typeof node !== "object") {
      return;
    }
    // Fail closed: a payload nested past the walk bound is not "clean" —
    // it is unscanned, which the journey must treat as a violation.
    if (depth > maxDepth) {
      echoes.push({
        path: path === "" ? "(root)" : path,
        reason: "payload_nesting_past_scan_bound",
      });
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, index) => visit(item, `${path}[${index}]`, depth + 1));
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      visit(value, path === "" ? key : `${path}.${key}`, depth + 1);
    }
  };
  visit(payload, "", 0);
  return echoes;
}

/**
 * Redaction verification (v2): a typed turn that carried a private value
 * must come back redacted. A value present in BOTH the raw words the
 * walkthrough typed and the transcript the server delivered means the
 * substitution failed — the private words were stored and shown as typed.
 * Returns the surviving values (the caller reports the count and the
 * question, never the value).
 *
 * @param {string} rawUserText - the exact words the walkthrough typed
 * @param {string} redactedTranscript - the transcript the server delivered
 * @param {readonly string[]} privateValues - submitted pii values
 * @returns {string[]} values that survived redaction
 */
export function verifyRedaction(rawUserText, redactedTranscript, privateValues) {
  const survivors = [];
  if (typeof rawUserText !== "string" || typeof redactedTranscript !== "string") {
    return survivors;
  }
  for (const value of privateValues) {
    if (
      typeof value === "string" &&
      value.trim() !== "" &&
      rawUserText.includes(value) &&
      redactedTranscript.includes(value)
    ) {
      survivors.push(value);
    }
  }
  return survivors;
}
