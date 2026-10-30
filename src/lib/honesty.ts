/**
 * Honesty spine (BN-05 / HACK-30).
 *
 * The contract as code for how the app talks about benefits: no eligibility
 * or approval promise language anywhere, every answer carries a tri-state
 * status, and plain-language labels surface uncertainty instead of hiding it.
 * Downstream features (intake, form prep, model prompts, the walkthrough CLI)
 * import the vocabulary from here rather than re-declaring it.
 */

// ---------------------------------------------------------------------------
// Banned-claims enforcement
// ---------------------------------------------------------------------------

/**
 * Promise language the app must never produce. Eligibility and approval
 * determinations belong to the official program, not to us, so assertive and
 * negated determinations are banned alike ("must", "not"), as are guarantees
 * and benefits-as-promised-outcome phrasing. Hedged uncertainty ("may be
 * eligible") stays allowed — surfacing uncertainty is the point.
 *
 * Patterns are written so their own source text never self-matches (word
 * boundaries and \s separators, no literal phrases), which lets the
 * UI-string scan include this file.
 */
export const BANNED_CLAIM_PATTERNS: readonly RegExp[] = [
  // Eligibility determinations, positive or negative, present or future.
  // Modal "should" assertions count as determinations; may/might hedges stay
  // allowed — surfacing uncertainty is the point. "still" (HACK-50 review)
  // catches the renewal-time form of the same claim.
  /\byou\s*(?:(?:are|'re|will|'ll|shall|must|should)\s+)?(?:(?:definitely|certainly|clearly|absolutely|fully|obviously|undoubtedly|easily|not|still)\s+)?(?:going\s+to\s+)?(?:be\s+)?eligible\b/i,
  // Qualification determinations.
  /\byou\s*(?:(?:are|'re|will|'ll|shall|must|do|should)\s+)?(?:(?:definitely|certainly|clearly|absolutely|fully|obviously|undoubtedly|easily|not|still)\s+)?(?:going\s+to\s+)?qualify\b/i,
  // Approval promises, positive or negative, present or future, including
  // being approved again at renewal ("re-approved").
  /\byou\s*(?:(?:are|'re|will|'ll|shall|must|should)\s+)?(?:(?:definitely|certainly|clearly|absolutely|fully|obviously|undoubtedly|easily|not|still)\s+)?(?:going\s+to\s+)?(?:be\s+)?(?:re-?)?approved\b/i,
  // Guarantee claims, in any phrasing.
  /\bguaranteed\b/i,
  /\bwe\s+(?:can\s+)?(?:guarantee|promise)\b/i,
  // Benefits framed as a promised outcome.
  /\byou\s*(?:(?:will|'ll|shall|should|are)\s+)?(?:(?:definitely|certainly|absolutely)\s+)?(?:going\s+to\s+)?(?:get|receive|obtain)\s+(?:the\s+|these\s+|those\s+|your\s+)?benefits\b/i,
  // Marketing-style approval claims.
  /\b(?:instant|automatic)\s+approval\b/i,
  // Criteria-satisfaction determinations ("meets the income rules" phrasing,
  // droid-review P3-2 on PR #45): asserting that a person satisfies the
  // program's criteria is a determination whether addressed to the person
  // or in third person, present or future. Requirement language ("you must
  // provide...", "would need to..."), hedges ("may meet"), and open
  // conditionals ("if you meet the limits, you may be eligible") stay
  // allowed.
  // "documentation" is deliberately absent: "document" + \w* already covers
  // it, and the redundant alternative makes the repetition ambiguous
  // (exponential backtracking — the CodeQL js/redos alert). Past-tense
  // (met) and satisfy forms are determinations too; terminal nouns take an
  // optional plural. The lookbehind spares open conditionals ("if/until/
  // unless you meet..."). Reported determinations ("your answers show you
  // meet...", "show that you meet...") stay banned — the boundary cost is
  // that requirement copy must avoid "show you meet" phrasing (word it as
  // "documents proving residency status" instead). Lexical backstops are
  // over/under-inclusive at the margins by nature; the grounding checker
  // carries the load for explanation prose.
  /(?<!\b(?:if|whether|once|when|until|unless)\s+)\b(?:you|he|she|they)\s*(?:(?:will|'ll|'ve|have|shall|should|do|did|don't|doesn't|didn't|won't|haven't|hasn't|definitely|certainly|clearly|absolutely|fully|obviously|undoubtedly|easily)\s+(?:not\s+)?)?(?:meets?|met|satisfied|satisfies|satisfy)\s+(?:all\s+|any\s+|every\s+|each\s+|some\s+|the\s+|these\s+|those\s+|your\s+|its\s+|their\s+|of\s+)*(?:(?:income|program|program's|eligibility|asset|resource|residency|household|immigration|document|disability|citizenship|application)\w*\s+)*(?:rules?|requirements?|criteria|guidelines?|limits?|thresholds?|conditions?|standards?)\b/i,
  // Renewal-time promises (HACK-50 renewal tracker). Telling the person
  // their coverage carries on past a renewal is an outcome promise like an
  // approval promise, in any tense. Shared rules for the five patterns
  // below:
  // - Open questions stay allowed: the lookbehind spares "if" and "whether"
  //   (asking the office whether coverage carries on). "that" is NOT
  //   spared, the same call the criteria pattern makes for "show that you
  //   meet": it would let a reported promise through ("this means that"
  //   followed by one). The boundary cost is that a negated report must be
  //   worded without the promise ("no one can promise coverage after a
  //   renewal").
  // - Hedges ("may lose ... if") and requirement language ("will still
  //   need to renew") stay allowed.
  // - The program objects are generic coverage words plus the decided
  //   pilot's program name.
  // - Every token is a literal word joined by \s+ and no group repeats, so
  //   the patterns backtrack linearly.
  // Continued coverage with "you" as the subject: stay or remain covered,
  // keep or continue to have coverage, still covered.
  /(?<!\b(?:if|whether)\s+)\byou\s*(?:(?:will|'ll|shall|(?:are|'re)\s+going\s+to)\s+)?(?:(?:definitely|certainly|absolutely|still)\s+)?(?:(?:stay|remain)\s+(?:eligible|enrolled|covered|insured|on\s+(?:nc\s+)?medicaid)|(?:keep|continue\s+to\s+(?:have|get|receive))\s+(?:your\s+)?(?:coverage|benefits|medicaid|nc\s+medicaid|health\s+(?:coverage|insurance|care))|(?:are|'re)\s+(?:still\s+)?(?:covered|enrolled|insured))\b/i,
  // Never losing coverage or being cut off.
  /(?<!\b(?:if|whether)\s+)\byou\s*(?:won't|will\s+not|'ll\s+not|(?:are|'re)\s+not\s+going\s+to)\s+(?:lose\s+(?:your\s+)?(?:coverage|benefits|medicaid|nc\s+medicaid|health\s+(?:coverage|insurance|care))|be\s+cut\s+off)\b/i,
  // Outcomes with the coverage, renewal, or application as the subject:
  // will be renewed or approved, will continue, is or was or has been
  // approved, won't end or stop, is safe, happens automatically.
  /(?<!\b(?:if|whether)\s+)\byour\s+(?:nc\s+)?(?:coverage|benefits|medicaid|renewal|recertification|application|health\s+(?:coverage|insurance|care))\s+(?:(?:will|'ll|is\s+going\s+to)\s+(?:(?:definitely|certainly|absolutely|still)\s+)?(?:be\s+(?:renewed|approved|re-?approved|continued|extended|accepted)|continue|go\s+through|happen\s+automatically)|(?:is|was|has\s+been)\s+(?:(?:already|definitely|certainly)\s+)?(?:approved|re-?approved|renewed|accepted|safe|automatic)|(?:won't|will\s+not|'ll\s+not)\s+(?:end|stop|lapse|be\s+(?:cut|cancell?ed|terminated|ended|stopped))|(?:happens|renews)\s+automatically)\b/i,
  // Being renewed or recertified, as a promise, automatically or not. The
  // reported past ("were renewed") stays allowed, as "were approved" does
  // above.
  /(?<!\b(?:if|whether)\s+)\byou\s*(?:(?:are|'re|will|'ll|shall|must|should)\s+)?(?:(?:definitely|certainly|absolutely|already|automatically|still)\s+)?(?:going\s+to\s+)?(?:be|get|are|'re)\s+(?:automatically\s+)?(?:renewed|recertified|re-?enrolled)\b/i,
  // A promise of no gap in coverage. "so there is no gap" (a purpose
  // clause in advice) stays allowed.
  /\bthere\s+(?:will|'ll)\s+(?:definitely\s+)?be\s+no\s+(?:gap|break|pause)\s+in\s+your\s+(?:nc\s+)?(?:coverage|benefits|medicaid|health\s+(?:coverage|insurance|care))\b/i,
];

export interface BannedClaimMatch {
  readonly patternSource: string;
  readonly matchedText: string;
  readonly index: number;
}

export class BannedClaimError extends Error {
  readonly matches: readonly BannedClaimMatch[];

  constructor(matches: readonly BannedClaimMatch[]) {
    const first = matches[0];
    super(
      `Banned claim language (honest-answers contract BN-05): ${matches.length} match(es); ` +
        `first from /${first.patternSource}/ at index ${first.index}: "${first.matchedText}". ` +
        "The app never states or implies an eligibility or approval outcome.",
    );
    this.name = "BannedClaimError";
    this.matches = matches;
  }
}

/** Find banned promise language in a string (first match per pattern). */
export function findBannedClaims(text: string): BannedClaimMatch[] {
  const matches: BannedClaimMatch[] = [];
  for (const pattern of BANNED_CLAIM_PATTERNS) {
    const found = pattern.exec(text);
    if (found) {
      matches.push({
        patternSource: pattern.source,
        matchedText: found[0].slice(0, 80),
        index: found.index,
      });
    }
  }
  return matches;
}

/** Throw a BannedClaimError when the text contains promise language. */
export function assertNoBannedClaims(text: string): void {
  const matches = findBannedClaims(text);
  if (matches.length > 0) {
    throw new BannedClaimError(matches);
  }
}

// ---------------------------------------------------------------------------
// Tri-state answer statuses
// ---------------------------------------------------------------------------

/**
 * Exactly the tri-state vocabulary declared in specs/question-spec (BN-05).
 * The question spec, the answer table's CHECK constraint, and this type must
 * stay literal-identical; the test suite compares all three.
 */
export const ANSWER_STATUSES = ["known", "unknown", "unverified"] as const;

export type AnswerStatus = (typeof ANSWER_STATUSES)[number];

/**
 * Plain-language, pilot-agnostic labels for each status. Uncertainty is
 * surfaced, never hidden, and no label promises an outcome.
 */
export const ANSWER_STATUS_LABELS: Readonly<Record<AnswerStatus, string>> = {
  known: "You told us",
  unknown: "You're not sure",
  unverified: "Answered but not verified",
};

export function answerStatusLabel(status: AnswerStatus): string {
  return ANSWER_STATUS_LABELS[status];
}

export function isAnswerStatus(value: unknown): value is AnswerStatus {
  return (
    typeof value === "string" &&
    (ANSWER_STATUSES as readonly string[]).includes(value)
  );
}

// ---------------------------------------------------------------------------
// BN-25 session-state vocabulary
// ---------------------------------------------------------------------------

/**
 * The BN-25 session lifecycle: draft → prepared → handed off, then the user
 * reports what happened outside the app. The app never sets a submitted state
 * itself — submission semantics exist only as user_reported_* values, so
 * "prepared" can never be conflated with "submitted".
 */
export const SESSION_STATUSES = [
  "draft",
  "prepared",
  "handed_off",
  "user_reported_submitted",
  "user_reported_decided",
] as const;

export type SessionStatus = (typeof SESSION_STATUSES)[number];

/** What the user reported happened outside the app, after handoff. */
export const USER_REPORTED_SESSION_STATUSES = [
  "user_reported_submitted",
  "user_reported_decided",
] as const;

export type UserReportedSessionStatus =
  (typeof USER_REPORTED_SESSION_STATUSES)[number];

/**
 * The states app code may set on a session. Derived with Exclude so any
 * future user_reported_* addition is automatically out of bounds — by
 * construction there is no app-settable state with submission semantics
 * (BN-25: prepared ≠ submitted).
 */
export type AppSettableSessionStatus = Exclude<
  SessionStatus,
  UserReportedSessionStatus
>;

export const APP_SETTABLE_SESSION_STATUSES = [
  "draft",
  "prepared",
  "handed_off",
] as const satisfies readonly AppSettableSessionStatus[];

/** Plain-language, pilot-agnostic labels for the session lifecycle. */
export const SESSION_STATUS_LABELS: Readonly<Record<SessionStatus, string>> = {
  draft: "In progress",
  prepared: "Prepared and ready to hand off",
  handed_off: "Handed off",
  user_reported_submitted: "You told us it was submitted",
  user_reported_decided: "You told us a decision was made",
};

export function isSessionStatus(value: unknown): value is SessionStatus {
  return (
    typeof value === "string" &&
    (SESSION_STATUSES as readonly string[]).includes(value)
  );
}

export function isUserReportedSessionStatus(
  value: unknown,
): value is UserReportedSessionStatus {
  return (
    typeof value === "string" &&
    (USER_REPORTED_SESSION_STATUSES as readonly string[]).includes(value)
  );
}

export function isAppSettableSessionStatus(
  value: unknown,
): value is AppSettableSessionStatus {
  return isSessionStatus(value) && !isUserReportedSessionStatus(value);
}
