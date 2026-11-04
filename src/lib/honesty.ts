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
  // allowed — surfacing uncertainty is the point.
  /\byou\s*(?:(?:are|'re|will|'ll|shall|must|should)\s+)?(?:(?:definitely|certainly|clearly|absolutely|fully|obviously|undoubtedly|easily|not)\s+)?(?:going\s+to\s+)?(?:be\s+)?eligible\b/i,
  // Qualification determinations.
  /\byou\s*(?:(?:are|'re|will|'ll|shall|must|do|should)\s+)?(?:(?:definitely|certainly|clearly|absolutely|fully|obviously|undoubtedly|easily|not)\s+)?(?:going\s+to\s+)?qualify\b/i,
  // Approval promises, positive or negative, present or future.
  /\byou\s*(?:(?:are|'re|will|'ll|shall|must|should)\s+)?(?:(?:definitely|certainly|clearly|absolutely|fully|obviously|undoubtedly|easily|not)\s+)?(?:going\s+to\s+)?(?:be\s+)?approved\b/i,
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
  /(?<!\b(?:if|whether|once|when|until|unless)\s+)\b(?:you|he|she|they)\s*(?:(?:will|'ll|'ve|have|shall|should|do|did|don't|doesn't|didn't|won't|haven't|hasn't|definitely|certainly|clearly|absolutely|fully|obviously|undoubtedly|easily)\s+(?:not\s+)?)?(?:meets?|met|satisfied|satisfies|satisfy)\s+(?:all\s+|any\s+|every\s+|each\s+|some\s+|the\s+|these\s+|those\s+|your\s+|its\s+|their\s+|of\s+)*(?:(?:income|program|program's|eligibility|asset|resource|residency|household|immigration|document|disability|citizenship|application|work)\w*\s+)*(?:rules?|requirements?|criteria|guidelines?|limits?|thresholds?|conditions?|standards?)\b/i,
  // Work-requirements exemption determinations (VAL-WR-009; the milestone's
  // HARD LINE): the app helps people REPORT — it never states or implies
  // anyone IS exempt from a work requirement; the state decides. Assertive
  // and negated determinations ban alike: a "not exempt" verdict decides
  // as much as an affirmative one. Hedged forms ("may be exempt") stay
  // allowed, like every determination above.
  /\byou\s*(?:(?:definitely|certainly|clearly|absolutely|fully|obviously|undoubtedly|easily|always)\s+)?(?:will|'ll|shall|must|should|are|'re)\s+(?:not\s+)?(?:going\s+to\s+)?(?:be\s+)?(?:(?:definitely|certainly|clearly|absolutely|fully|obviously|undoubtedly|easily|always)\s+)?(?:not\s+)?(?:be\s+)?exempt\b/i,
  // "No need to report" determinations (VAL-WR-009): the app never tells a
  // person they don't need to report work activities. The permitted framing
  // is the HEDGED one — "you may not need to report work activities — the
  // state decides" — so definite do-not / will-not forms bite and may/might
  // hedges pass.
  /\byou\s+(?:do\s+not|don't|don’t|will\s+not|won't|won’t)\s+(?:even\s+|have\s+to\s+)?need\s+to\s+report\b/i,
];

/**
 * Spanish banned-claim shapes (HACK-131): the same honesty rules in
 * Spanish - eligibility determinations, approval promises, and
 * guarantee claims. Kept beside the English patterns so any Spanish
 * copy, wherever it lives, can be checked against the one gate.
 */
export const BANNED_CLAIM_PATTERNS_ES: readonly RegExp[] = [
  /\b(?:ustedes\s+|usted\s+)?(?:es|eres|son|ser\u00e1|ser\u00e1n)\s+(?:definitivamente\s+)?elegibles?\b/i,
  // With a subject pronoun and an unaccented "si" (typed for "sí", "yes"),
  // the sentence is affirmative and decides the outcome, so it bites before
  // the conditional exemption below can see it.
  // (Written with the suffix nested so this file's own text is not a match
  // for the patterns below: the scanner reads raw source.)
  /\b(?:usted|t\u00fa|tu)\s+(?:s\u00ed|si)\s+calific(?:a(?:s|n)?)\b/i,
  // A bare conditional clause is a condition, not a determination, so a
  // preceding conditional marker keeps the verb out of the gate. The pattern
  // covers every tense (including the future and conditional forms); the
  // related noun is a rating (a VA disability rating, for one), not a
  // determination, so it is deliberately not matched.
  // Hedged forms ("podría calificar", "puede que califique") are the permitted
  // framing, so a modal or a conditional marker before the verb exempts it.
  /(?<!\bsi\s)(?<!\bsi\susted\s)(?<!\bpodr\u00eda\s)(?<!\bpodr\u00edan\s)(?<!\bpuede\s+que\s)(?<!\bpodr\u00eda\s+ser\s+que\s)(?<!\bquiz\u00e1\s)(?<!\bquiz\u00e1s\s)(?<!\btal\s+vez\s)(?<!\bes\s+posible\s+que\s)\b(?:calific(?:a(?:s|n|mos)?|ó|aste(?:is)?|aron|ad[oa]s?|ar(?:[\u00e1a]s?n?|[\u00ed]as?n?)?)|califiqu(?:é|e(?:s|n|mos)?))(?!\p{L})/iu,
  // Other ways Spanish states a determination or an outcome.
  /\bcumple(?:n)?\s+(?:con\s+)?(?:los|todos\s+los)\s+requisitos\b/i,
  /\btiene(?:n)?\s+derecho\s+a\s+(?:recibir|obtener|beneficios|ayuda)\b/i,
  /\b(?:fue|fueron|est\u00e1|est\u00e1n|queda|quedan|ya\s+est\u00e1)\s+aprobad[oa]s?\b/i,
  /\bva(?:n)?\s+a\s+recibir\b/i,
  /\bser\u00e1\s+aprobad[oa]s?\b/i,
  /\baprobaci\u00f3n\s+garantizad[oa]s?\b/i,
  // A disclaimer ("no está garantizado") is the honesty this gate enforces,
  // so only affirmative guarantee claims bite.
  /(?<!\bno\s)(?<!\bno\s(?:est\u00e1|est\u00e1n|queda|quedan|ser\u00e1|ser\u00e1n|nada)\s)\bgarantizad[oa]s?\b/i,
  /\brecibir\u00e1n?(?=[\s.,;:!\)]|$)/i,
  /\bsin duda\b/i,
  /\b(?:usted\s+)?(?:est\u00e1|queda|ser\u00e1)\s+exent[oa]s?\b/i,
  /\bno\s+(?:necesita|necesitas|tiene que|tienen que)\s+reportar\b/i,
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
  for (const pattern of [...BANNED_CLAIM_PATTERNS, ...BANNED_CLAIM_PATTERNS_ES]) {
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
// Answer provenance vocabulary
// ---------------------------------------------------------------------------

/**
 * Where an answer's value came from — mirrors the answer table's CHECK
 * constraint exactly (migrations/0001_core.sql as extended by
 * migrations/0004_tax_return_provenance.sql). Lives on the honesty spine so
 * both server modules (the store) and browser-safe modules (the flow
 * engine, the client-state builder) can share one vocabulary:
 *
 * - `user_supplied` — the person typed or spoke it (wizard, quick
 *   questions, conversation).
 * - `ai_drafted` — a genuine AI inference, always status `unverified`.
 * - `source_verified` — checked against an official source.
 * - `tax_return` — a parser proposal the person confirmed on the income
 *   stage ("From your tax return"). Pairs only with status `known`.
 * - `user` — the person's own value through the income stage's paths (the
 *   manual card, or a bank/tax proposal they corrected). Pairs only with
 *   status `known`. An untouched bank proposal saves as `user_supplied`
 *   with status `unverified`, never `user`.
 *
 * A Plaid institution name is deliberately absent: it is pii:true metadata
 * kept in the client-side encrypted store (HACK-140), so an untouched bank
 * proposal saves as `unverified`/`user_supplied` and the browser, not
 * Postgres, knows the bank.
 */
export const ANSWER_PROVENANCES = [
  "user_supplied",
  "ai_drafted",
  "source_verified",
  "tax_return",
  "user",
] as const;

export type AnswerProvenance = (typeof ANSWER_PROVENANCES)[number];

export function isAnswerProvenance(value: unknown): value is AnswerProvenance {
  return (
    typeof value === "string" &&
    (ANSWER_PROVENANCES as readonly string[]).includes(value)
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
