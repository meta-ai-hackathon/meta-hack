import {
  assertNoBannedClaimsEverySentence,
  isSpecificValue,
} from "./conversation";
import { ANSWER_STATUS_LABELS } from "./honesty";
import {
  ALL_KB_FACT_GROUPS,
  KB_ENTRIES,
  SAMPLE_KB_ENTRIES,
  type KbEntry,
} from "./kb";
import { PII_QUESTION_IDS_IN_SPEC, QUESTION_BY_ID, QUESTIONS } from "./intake/spec";
import type { AnswerMap } from "./intake/flow";
import {
  EXPLANATION_FRAMING,
  MATCH_FRAMING,
  buildMatchCard,
  buildToResolve,
  composeFallbackExplanation,
  rankEntries,
  type MatchCard,
  type MatchExplanation,
  type MatchResponse,
} from "./match-core";
import { chatCompletion, type ChatMessage } from "./model";
import { AppError, logInfo, logWarn } from "./telemetry";

// Benefit match (Mission v2 M3, BN-14/15/16/27/29/30).
//
// Deterministic, auditable scoring over the knowledge base: the ranking is a
// PURE function of the stored answer map (same answers -> same ranking, in
// the same order, with the same reasons — property-proven). Every claim a
// card shows traces to the matched entry through the KB citation API, so
// each reason, requirement, and link carries the official source URL, the
// retrieval date, and the entry version (BN-27).
//
// Honesty rules this module enforces:
// - Framing is "this may be worth pursuing" — never a determination.
// - Stale and withdrawn entries are never presented (BN-29): rankEntries
//   filters to active entries before anything else happens.
// - Unknown and unverified answers are never inferred from (BN-16): they
//   score nothing and surface in an explicit to-resolve list instead.
// - The plain-language explanation is grounded ONLY on the matched entry:
//   its prompt carries the entry's facts alone, its output passes the
//   per-sentence banned-claim gate (BN-05), and a grounding checker proves
//   every sentence traces to the entry before render (VAL-MATCH-006). Any
//   failure degrades to copy composed from the entry's own facts.
//
// The browser-safe half (card vocabulary, scoring, requirements, the
// to-resolve list, the facts-only explanation, card assembly) lives in
// match-core.ts, so the step-by-step page can build the match on the device
// (HACK-115). It is re-exported here unchanged, so every existing import of
// this module keeps working; this module adds the server-only half: the
// gated model explanation and the pii defense for responses.
export {
  EXPLANATION_FRAMING,
  MATCH_FRAMING,
  buildRequirements,
  buildToResolve,
  composeFallbackExplanation,
  matchCardText,
  rankEntries,
  scoreEntry,
} from "./match-core";
export type {
  MatchCard,
  MatchExplanation,
  MatchLink,
  MatchReason,
  MatchRequirement,
  MatchRequirementKind,
  MatchResponse,
  MatchSourceCitation,
  RankedEntry,
  ToResolveItem,
} from "./match-core";

// ---------------------------------------------------------------------------
// The model explanation's budget
// ---------------------------------------------------------------------------

export const EXPLANATION_SYSTEM_PROMPT_PREFIX =
  "You explain a benefits program in plain language.";

/**
 * Completion budget for the explanation call. Reasoning tokens consume the
 * budget (library/model.md): the grounded-explanation prompt's constraints
 * drive reasoning bursts that exhausted a 2048 budget into null content
 * with finish_reason "length" (live-verified on this exact prompt), so the
 * floor here is 4096. One explanation call per match request; usage is
 * logged per call (cost discipline).
 */
export const MATCH_EXPLANATION_MAX_TOKENS = 4096;

// ---------------------------------------------------------------------------
// Grounding checker (VAL-MATCH-006): explanation claims trace to the entry
// ---------------------------------------------------------------------------

const SENTENCE_SPLIT_PATTERN = /(?<=[.!?])\s+/;

/**
 * Function words that never make a sentence a factual claim, plus the
 * framing sentence's own vocabulary so a lightly rephrased framing is not
 * mistaken for a program claim.
 */
const GROUNDING_STOPWORDS: ReadonlySet<string> = new Set([
  "the", "a", "an", "and", "or", "but", "if", "then", "than", "as", "at", "by",
  "for", "from", "in", "into", "of", "on", "to", "with", "without", "is", "are",
  "was", "were", "be", "been", "being", "am", "do", "does", "did", "doing",
  "have", "has", "had", "having", "will", "would", "shall", "should", "can",
  "could", "may", "might", "must", "this", "that", "these", "those", "it",
  "its", "they", "them", "their", "you", "your", "yours", "we", "our", "ours",
  "he", "she", "his", "her", "not", "no", "yes", "so", "such", "there", "here",
  "what", "which", "who", "whom", "when", "where", "why", "how", "also",
  "only", "any", "all", "every", "each", "some", "one", "two", "based",
  "worth", "pursuing", "official", "file",
]);

/**
 * A sentence with at least this many vocabulary hits AND at least this
 * share of its content words inside the entry's vocabulary counts as
 * tracing to the entry. A sentence with too few content words to carry a
 * factual claim is not a violation.
 */
const GROUNDING_MIN_OVERLAP = 2;
const GROUNDING_MIN_RATIO = 0.5;

function contentTokens(text: string): readonly string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 2 && !GROUNDING_STOPWORDS.has(token));
}

/** Every word the entry itself provides: titles, facts, sources, signals. */
function entryVocabulary(entry: KbEntry): ReadonlySet<string> {
  const parts: string[] = [
    entry.title,
    ...entry.sources.map((source) => `${source.title} ${source.supports}`),
  ];
  for (const name of ALL_KB_FACT_GROUPS) {
    const group = entry.facts[name];
    if (!group) {
      continue;
    }
    for (const item of group.items) {
      if (typeof item === "string") {
        parts.push(item);
      } else if ("questionId" in item) {
        parts.push(`${item.reason} ${item.questionId} ${(item.values ?? []).join(" ")}`);
      } else {
        parts.push(`${item.label} ${"due" in item ? item.due : item.url}`);
      }
    }
  }
  return new Set(contentTokens(parts.join(" ")));
}

export interface ExplanationGroundingViolation {
  readonly sentence: string;
}

/**
 * Check an explanation sentence by sentence against ONE entry. A sentence
 * is grounded when it is the committed framing, carries no content words
 * (nothing claim-like), or enough of its content words come from the
 * entry's own vocabulary. A hallucinated attribute ("covers dental care")
 * shares almost none of its content words with the entry and fails.
 */
export function checkExplanationGrounding(
  explanation: string,
  entry: KbEntry,
): readonly ExplanationGroundingViolation[] {
  const vocabulary = entryVocabulary(entry);
  const violations: ExplanationGroundingViolation[] = [];
  for (const rawSentence of explanation.split(SENTENCE_SPLIT_PATTERN)) {
    const sentence = rawSentence.trim();
    if (sentence === "") {
      continue;
    }
    const normalized = sentence
      .toLowerCase()
      .replace(/\s+/g, " ")
      .replace(/[.!?]+$/, "");
    if (normalized === EXPLANATION_FRAMING.toLowerCase().replace(/[.!?]+$/, "")) {
      continue;
    }
    const tokens = contentTokens(sentence);
    if (tokens.length === 0) {
      continue;
    }
    const overlap = tokens.filter((token) => vocabulary.has(token)).length;
    if (overlap >= GROUNDING_MIN_OVERLAP && overlap / tokens.length >= GROUNDING_MIN_RATIO) {
      continue;
    }
    violations.push({ sentence });
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Explanation: grounded on the matched entry ONLY, gated before render
// ---------------------------------------------------------------------------

function explanationFactsBlock(entry: KbEntry): string {
  const lines: string[] = [];
  const rule = entry.facts.rules;
  lines.push(
    `Rules (source: ${rule.sourceId}, retrieved ${rule.retrievedAt}):\n` +
      rule.items.map((item) => `- ${item}`).join("\n"),
  );
  const documents = entry.facts.required_documents;
  lines.push(
    `Required documents (source: ${documents.sourceId}, retrieved ${documents.retrievedAt}):\n` +
      documents.items.map((item) => `- ${item}`).join("\n"),
  );
  if (entry.facts.steps) {
    lines.push(
      `Steps (source: ${entry.facts.steps.sourceId}, retrieved ${entry.facts.steps.retrievedAt}):\n` +
        entry.facts.steps.items.map((item) => `- ${item}`).join("\n"),
    );
  }
  const deadlines = entry.facts.deadlines;
  lines.push(
    `Deadlines (source: ${deadlines.sourceId}, retrieved ${deadlines.retrievedAt}):\n` +
      deadlines.items.map((item) => `- ${item.label}: ${item.due}`).join("\n"),
  );
  const links = entry.facts.official_links;
  lines.push(
    `Official links (source: ${links.sourceId}, retrieved ${links.retrievedAt}):\n` +
      links.items.map((item) => `- ${item.label}: ${item.url}`).join("\n"),
  );
  return lines.join("\n\n");
}

/** The explanation prompt: the matched entry's facts and nothing else. */
export function buildExplanationMessages(entry: KbEntry): readonly ChatMessage[] {
  return [
    {
      role: "system",
      content:
        `${EXPLANATION_SYSTEM_PROMPT_PREFIX} You write 2-4 short plain-language ` +
        `sentences about one program, from knowledge-base entry ${entry.id} ` +
        `version ${entry.version}. Use ONLY the facts quoted in the next ` +
        "message; never add facts, numbers, or dates the quotes do not state. " +
        `Start your reply with exactly this sentence: "${EXPLANATION_FRAMING}" ` +
        "Never state or imply anything about whether any person is or may be " +
        "eligible or approved. This is not a determination of any kind.",
    },
    {
      role: "user",
      content:
        `Program facts (the only facts you may use):\n${explanationFactsBlock(entry)}`,
    },
  ];
}

/**
 * One model explanation for the matched entry, passed through BOTH gates
 * before render: the per-sentence banned-claim gate and the grounding
 * checker. Any failure — promise language, an ungrounded sentence, or a
 * model error — degrades to the deterministic entry-fact copy. No path
 * here can render a fabricated or promissory sentence (VAL-MATCH-006).
 */
export async function explainEntry(entry: KbEntry): Promise<MatchExplanation> {
  try {
    const result = await chatCompletion([...buildExplanationMessages(entry)], {
      maxTokens: MATCH_EXPLANATION_MAX_TOKENS,
    });
    if (result.finishReason === "length") {
      // A budget-truncated reply ships an incomplete final sentence as a
      // "model" explanation (droid-review P2 on PR #45) — non-empty
      // content is not the same as a complete reply. Degrade to the
      // deterministic entry-fact copy, like every other gate failure.
      logWarn("match_explanation_length_truncated_blocked");
      return { text: composeFallbackExplanation(entry), source: "facts" };
    }
    const text = result.content.trim();
    try {
      assertNoBannedClaimsEverySentence(text);
    } catch {
      logWarn("match_explanation_banned_claim_blocked");
      return { text: composeFallbackExplanation(entry), source: "facts" };
    }
    const violations = checkExplanationGrounding(text, entry);
    if (violations.length > 0) {
      logWarn("match_explanation_ungrounded_blocked", {
        violationCount: violations.length,
      });
      return { text: composeFallbackExplanation(entry), source: "facts" };
    }
    return { text, source: "model" };
  } catch (error) {
    // model_unavailable / rate_limited (or any transport failure): the card
    // keeps its value with the honest entry-fact copy — never a fabricated
    // explanation.
    logWarn("match_explanation_model_unavailable", {
      code: error instanceof AppError ? error.code : undefined,
    });
    return { text: composeFallbackExplanation(entry), source: "facts" };
  }
}

/** The explainer builds one model explanation for the top-ranked entry. */
export type MatchExplainer = (entry: KbEntry) => Promise<MatchExplanation>;

// ---------------------------------------------------------------------------
// Response assembly (card assembly itself is buildMatchCard in match-core.ts)
// ---------------------------------------------------------------------------

export interface MatchBuildOptions {
  /** Entries to rank (defaults to the shipped dataset). */
  readonly entries?: readonly KbEntry[];
  /** The explanation builder (defaults to the gated model explainer). */
  readonly explainer?: MatchExplainer;
  /**
   * Explanation cache keyed by entry id + version. Defaults to a
   * module-level cache so repeated turns never repeat the model call;
   * tests inject a fresh Map per scenario.
   */
  readonly explanationCache?: Map<string, MatchExplanation>;
}

/**
 * ONE gated explanation per entry id + version per server process under
 * sequential traffic (the cache key never involves rank: an entry that was
 * top-ranked last turn carries its explanation wherever it ranks now).
 * Concurrent cold-start requests for the same entry may each spend a call;
 * only the first result is cached. (claude-review P2-2 on PR #45: the
 * ranking derives from pii answers, so re-firing the call every turn would
 * leak that derived signal to the model on every request and block every
 * fetch for 10-20s.)
 */
const moduleExplanationCache = new Map<string, MatchExplanation>();

/** Test seam: clear the module-level explanation cache. */
export function resetModuleExplanationCache(): void {
  moduleExplanationCache.clear();
}

function explanationCacheKey(entry: KbEntry): string {
  return `${entry.id}:v${entry.version}`;
}

/**
 * The full match payload: ranked active cards plus the to-resolve list.
 * Entries are grouped by score — a score-0 entry is NEVER presented as a
 * "may be worth pursuing" card (claude-review P2-1 on PR #45); when no
 * signal matched anything, the payload is empty and the client shows its
 * honest empty state. Only the top-scoring match spends a model call, and
 * only once per entry id + version; the rest carry the deterministic
 * entry-fact explanation (cost discipline).
 */
export async function buildMatchResponse(
  answers: AnswerMap,
  options: MatchBuildOptions = {},
): Promise<MatchResponse> {
  const entries = options.entries ?? KB_ENTRIES;
  const explainer = options.explainer ?? explainEntry;
  // The shared module cache is only for the default explainer; a custom
  // explainer without an explicit cache gets a fresh map per build, so test
  // stubs can never leak into (or pin) later default-explainer builds.
  const cache =
    options.explanationCache ??
    (explainer === explainEntry ? moduleExplanationCache : new Map());
  const ranked = rankEntries(answers, entries);
  const matches: MatchCard[] = [];
  const signalMatched = ranked.filter((rankedEntry) => rankedEntry.score > 0);
  // THIS session's specific pii values, used to degrade (never pin) an
  // explanation that collides with them. The trigger and excusal come from
  // the response gate's own privateValueMatcher, so they MIRROR the gate
  // exactly: any explanation the gate would reject is degraded here first —
  // a cached explanation can never pin a session's match list to a 500.
  const piiValues: PrivateValueMatcher[] = [];
  for (const questionId of PII_QUESTION_IDS_IN_SPEC) {
    const stored = answers[questionId];
    if (!stored || stored.value === null || stored.value === undefined) {
      continue;
    }
    for (const element of Array.isArray(stored.value) ? stored.value : [stored.value]) {
      const raw = String(element).trim();
      if (raw !== "" && isSpecificValue(raw)) {
        piiValues.push(privateValueMatcher(questionId, raw));
      }
    }
  }
  for (const [index, rankedEntry] of signalMatched.entries()) {
    const key = explanationCacheKey(rankedEntry.entry);
    let explanation = cache.get(key);
    if (explanation === undefined && index === 0) {
      explanation = await explainer(rankedEntry.entry);
      // Only a model-sourced explanation is cached: a degraded fallback
      // (model unavailable, gate failure, truncation) must not pin the
      // entry to fallback copy until process restart — the next turn
      // retries the model (claude-review P2 on PR #46).
      if (explanation.source === "model") {
        cache.set(key, explanation);
      }
    }
    if (explanation === undefined) {
      explanation = {
        text: composeFallbackExplanation(rankedEntry.entry),
        source: "facts",
      };
    }
    let card = buildMatchCard(rankedEntry, explanation);
    if (
      explanation.source === "model" &&
      piiValues.length > 0 &&
      piiValues.some(
        (value) =>
          value.carriedBy(card.explanation.text) &&
          !value.inStatic.test(cardStaticCopy(rankedEntry.entry, card)),
      )
    ) {
      // The model explanation is grounded on the entry and never sees user
      // content, so a word colliding with this session's free-text pii
      // answer is coincidence, not a leak. Degrade THIS card to the
      // entry-fact copy for this response — the cached copy (per entry,
      // shared across users) is untouched (claude-review P2 on PR #46,
      // round 5).
      logWarn("match_explanation_pii_echo_degraded");
      card = buildMatchCard(rankedEntry, {
        text: composeFallbackExplanation(rankedEntry.entry),
        source: "facts",
      });
    }
    matches.push(card);
  }
  logInfo("match_response_built", { cardCount: matches.length });
  return { matches, toResolve: buildToResolve(answers) };
}

// ---------------------------------------------------------------------------
// PII defense in depth (the serialization-boundary pattern, for match)
// ---------------------------------------------------------------------------

function escapeRegExpValue(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A number answer as String() and the vault write it: digits, maybe a decimal part. */
const PLAIN_NUMBER_PATTERN = /^\d+(?:\.\d+)?$/;

/**
 * Token edges for number answers (HACK-121). Before the number, a letter or
 * digit joins it to a longer token, and so does a hyphen, dot, slash, or
 * underscore right after a letter or digit, or a colon or comma right after
 * a digit. So ids (dhb-5200, wr_income_580, travel_1hr), versions (v3), URL
 * paths, and the later parts of dates, times, decimals, and grouped numbers
 * each stay one token, while a label (hours:20) does not hide the number.
 * After the number, only a digit joins it, right next to it or across one
 * of these separators (2026-10-30, 10/08/2026, 10:30, 1.5, 1,000). A letter
 * or a word after it is a unit (0hrs, 20-hour, 20/week), so the number
 * still stands as its own number there. These are the trigger's edges, and
 * the excusal's are stricter (standaloneNumberPattern).
 */
const TOKEN_CHAR = "[a-z0-9]";
const TOKEN_JOINER = "[-./:,_]";
const JOINER_AFTER_TOKEN_CHAR = "[-./_]";
const JOINER_AFTER_DIGIT = "[:,]";

/**
 * A plain number answer's digits. Trailing zeros after a decimal point are
 * the same number, so 20 also matches 20.0 and 7.5 matches 7.50.
 */
function numberValuePattern(raw: string): string {
  return raw.includes(".")
    ? `${escapeRegExpValue(raw)}0*`
    : `${escapeRegExpValue(raw)}(?:\\.0+)?`;
}

/**
 * The trigger: a plain number answer as its own number, a unit or label
 * glued on included.
 */
function ownNumberPattern(raw: string): RegExp {
  return new RegExp(
    `(?<!${TOKEN_CHAR})(?<!${TOKEN_CHAR}${JOINER_AFTER_TOKEN_CHAR})(?<!\\d${JOINER_AFTER_DIGIT})` +
      `${numberValuePattern(raw)}(?!\\d)(?!${TOKEN_JOINER}\\d)`,
    "i",
  );
}

/**
 * The excusal: a plain number answer as a token of its own, with no letter
 * or digit right before or after it and no separator joining it to one on
 * either side. A unit or label glued on still shows the answer in a leak,
 * but in the public copy that shape is a longer token, so a "1st", "20h",
 * "24-hour" or "hours:3" there never excuses a leaked 1, 20, 24 or 3
 * (security review on PR #132). "page 1" still excuses 1.
 */
function standaloneNumberPattern(raw: string): RegExp {
  return new RegExp(
    `(?<!${TOKEN_CHAR})(?<!${TOKEN_CHAR}${TOKEN_JOINER})` +
      `${numberValuePattern(raw)}(?!${TOKEN_CHAR})(?!${TOKEN_JOINER}${TOKEN_CHAR})`,
    "i",
  );
}

/**
 * The numbers a match response computes itself: the entry version (on each
 * card and citation) and the card score. They are metadata, not copy, so a
 * number answer equal to one of them is not a disclosure.
 */
const COMPUTED_NUMBER_KEYS: ReadonlySet<string> = new Set(["entryVersion", "score"]);

/**
 * The private number questions whose plain-number answers are matched as
 * their own number (HACK-121): today the only private number question. A
 * private number question added later keeps the strict substring check
 * until its answers are checked against the copy a match carries, so
 * turning the token rule on for it is a reviewed decision.
 */
const OWN_NUMBER_QUESTION_IDS: ReadonlySet<string> = new Set(["wr_work_activity_hours"]);

/**
 * The gate's two tests for one private value: does a text carry it (the
 * trigger), and is it part of a public copy (the excusal). Every value
 * keeps the substring trigger and the word-boundary excusal, except a
 * plain-number answer to a question in OWN_NUMBER_QUESTION_IDS (HACK-121).
 * Its digits turn up inside the dates, ids, and longer numbers every
 * response carries ("0" inside 2026-10-30), so the trigger counts it only
 * where it stands as its own number, a unit or label glued on included, and
 * the excusal only where the public copy holds it as a token of its own.
 */
interface PrivateValueMatcher {
  /** True when the value is matched as a whole number token. */
  readonly wholeNumber: boolean;
  /** The trigger: does this text carry the value? */
  readonly carriedBy: (text: string) => boolean;
  /** The excusal: matches a public copy the value is part of. */
  readonly inStatic: RegExp;
}

function privateValueMatcher(questionId: string, raw: string): PrivateValueMatcher {
  if (
    OWN_NUMBER_QUESTION_IDS.has(questionId) &&
    QUESTION_BY_ID[questionId]?.type === "number" &&
    PLAIN_NUMBER_PATTERN.test(raw)
  ) {
    const ownNumber = ownNumberPattern(raw);
    return {
      wholeNumber: true,
      carriedBy: (text) => ownNumber.test(text),
      inStatic: standaloneNumberPattern(raw),
    };
  }
  const lowered = raw.toLowerCase();
  return {
    wholeNumber: false,
    carriedBy: (text) => text.toLowerCase().includes(lowered),
    inStatic: new RegExp(`\\b${escapeRegExpValue(raw)}\\b`, "i"),
  };
}

/**
 * Every key, string, and number the response carries, unescaped, minus the
 * computed numbers above: the text a number answer is matched against.
 * (The JSON escapes a newline to "\n", which would glue an "n" onto the
 * number that follows it.)
 */
function responseNumberScan(value: unknown, key = ""): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (typeof value === "number") {
    return COMPUTED_NUMBER_KEYS.has(key) ? [] : [String(value)];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => responseNumberScan(item));
  }
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([childKey, child]) => [
      childKey,
      ...responseNumberScan(child, childKey),
    ]);
  }
  return [];
}

/**
 * The spec's plain-language option labels (lowercased). A reason's answer
 * label is SPEC-PRODUCED — public vocabulary, never user text — when every
 * comma-separated part of it is one of these (multi-select labels join the
 * selected options' labels).
 */
const SPEC_OPTION_LABELS: ReadonlySet<string> = new Set(
  QUESTIONS.flatMap((question) =>
    (question.options ?? []).map((option) => option.label.trim().toLowerCase()),
  ),
);

function isSpecProducedLabel(label: string): boolean {
  return label
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .every((part) => SPEC_OPTION_LABELS.has(part));
}

/**
 * The entry-derived copy one card renders: the entry's own text plus the
 * glossary terms the card actually displays. This is the excusal set for
 * that card's model explanation — the explanation is grounded on THIS
 * entry, so its legitimate vocabulary is exactly here.
 */
function cardStaticCopy(entry: KbEntry, card: MatchCard): string {
  const parts: string[] = [entry.title];
  for (const source of entry.sources) {
    parts.push(`${source.title} ${source.supports}`);
  }
  for (const name of ALL_KB_FACT_GROUPS) {
    const group = entry.facts[name];
    if (!group) {
      continue;
    }
    for (const item of group.items) {
      if (typeof item === "string") {
        parts.push(item);
      } else if ("questionId" in item) {
        parts.push(item.reason);
      } else {
        parts.push(`${item.label} ${"due" in item ? item.due : item.url}`);
      }
    }
  }
  for (const term of card.terms) {
    parts.push(`${term.term} ${term.definition}`);
  }
  return parts.join(" ").toLowerCase();
}

/**
 * The public copy THIS response renders from its own sources: each matched
 * card's entry text and rendered glossary terms, the spec-produced option
 * labels it shows, the fixed tri-state status labels, and the to-resolve
 * prompts (verbatim spec questions). Never computed from a raw echo of the
 * user's own text, so a leak cannot excuse itself. Entries are matched by
 * id AND version, so a card built from a bumped entry never inherits the
 * old version's copy.
 *
 * The lookup covers the test-only sample entries as well (VAL-PILOTREAL-004
 * kept them out of the PRODUCTION dataset): production builds rank
 * KB_ENTRIES only, but the suites build fixture cards from
 * SAMPLE_KB_ENTRIES and run them through this same gate. Looking a card's
 * entry up here never puts a sample into a response.
 */
const STATIC_COPY_ENTRIES: readonly KbEntry[] = [
  ...KB_ENTRIES,
  ...SAMPLE_KB_ENTRIES,
];

function responseStaticCopy(response: MatchResponse): string {
  const parts: string[] = [
    MATCH_FRAMING,
    EXPLANATION_FRAMING,
    ...Object.values(ANSWER_STATUS_LABELS),
  ];
  for (const card of response.matches) {
    const entry = STATIC_COPY_ENTRIES.find(
      (candidate) =>
        candidate.id === card.entryId &&
        candidate.version === card.entryVersion,
    );
    if (entry) {
      parts.push(cardStaticCopy(entry, card));
    }
    for (const reason of card.reasons) {
      if (
        reason.answerLabel !== undefined &&
        isSpecProducedLabel(reason.answerLabel)
      ) {
        parts.push(reason.answerLabel);
      }
    }
  }
  for (const item of response.toResolve) {
    parts.push(item.prompt);
  }
  return parts.join(" ").toLowerCase();
}

/**
 * Throw loudly if a match response about to leave the server carries any
 * stored value of a pii:true question. The message stays generic; no value
 * or question id is echoed back. Mirrors the intake serializer's check.
 *
 * The WHOLE outgoing payload is scanned (reason text, model explanations,
 * labels, framing — anything that serializes), and a specific value throws
 * unless it is an exact word of the response's public copy: the matched
 * entries' facts, the glossary terms the cards render, the spec-produced
 * option labels they show, the fixed status labels, the to-resolve
 * prompts, and the framing. A free-text pii answer that happens to equal a
 * common KB word ("application") must not fail-closed the user's whole
 * match list (claude-review P2-3 on PR #45). The excusal is PER VALUE
 * across the whole payload — there is no per-field exempted tier: once a
 * value is a word of the public copy, every occurrence anywhere is
 * excused, INCLUDING an answer label that echoes it (a value
 * indistinguishable from public vocabulary is not a disclosure); a raw
 * echo of any other user text is never part of the excusal set, so it can
 * never excuse itself. Model explanations that collide with this
 * session's values are degraded per card at build time (see
 * buildMatchResponse), so this gate mostly stands for user-derived fields
 * and non-explanation copy.
 *
 * Multi-select values are checked element by element (the old whole-array
 * JSON check could never substring-match).
 *
 * The work hours answer written as a plain number is matched only as its
 * own number, never inside a date, an id, or a longer number, and never
 * against the entry version or card score, and it is excused only where the
 * public copy holds it as a token of its own (HACK-121; see
 * privateValueMatcher and OWN_NUMBER_QUESTION_IDS).
 */
export function assertNoPiiValuesInMatch(
  response: MatchResponse,
  answers: AnswerMap,
): void {
  const serialized = JSON.stringify(response).toLowerCase();
  const numberScan = responseNumberScan(response).join("\n");
  const staticCopy = responseStaticCopy(response);
  for (const questionId of PII_QUESTION_IDS_IN_SPEC) {
    const stored = answers[questionId];
    if (!stored || stored.value === null || stored.value === undefined) {
      continue;
    }
    const elements = (
      Array.isArray(stored.value) ? stored.value : [stored.value]
    ).map((element) => String(element).trim());
    for (const raw of elements) {
      // Generic one-word answers ("yes") would over-match ordinary copy; the
      // same specificity rule the conversation redactor uses applies here.
      if (raw === "" || !isSpecificValue(raw)) {
        continue;
      }
      const matcher = privateValueMatcher(questionId, raw);
      if (!matcher.carriedBy(matcher.wholeNumber ? numberScan : serialized)) {
        continue;
      }
      if (!matcher.inStatic.test(staticCopy)) {
        throw new AppError(
          "internal",
          "A match response attempted to include a private answer value.",
        );
      }
    }
  }
}
