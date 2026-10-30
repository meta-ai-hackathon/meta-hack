import {
  assertNoBannedClaimsEverySentence,
  isSpecificValue,
} from "./conversation";
import {
  glossaryTermsForText,
  type GlossaryTerm,
} from "./glossary";
import {
  ANSWER_STATUS_LABELS,
  answerStatusLabel,
  type AnswerStatus,
} from "./honesty";
import {
  ALL_KB_FACT_GROUPS,
  KB_ENTRIES,
  citeFactGroup,
  type KbCitation,
  type KbEntry,
  type KbSignalFact,
} from "./kb";
import {
  PII_QUESTION_IDS_IN_SPEC,
  QUESTION_BY_ID,
  QUESTIONS,
  type Question,
} from "./intake/spec";
import {
  visibleQuestions,
  type AnswerMap,
  type StoredAnswer,
} from "./intake/flow";
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

// ---------------------------------------------------------------------------
// Card vocabulary
// ---------------------------------------------------------------------------

/** The honest framing every card carries: a suggestion, never a promise. */
export const MATCH_FRAMING = "This may be worth pursuing.";

/**
 * The explanation opener. Committed copy (not a claim about the program),
 * so the grounding checker keeps an exact allowlist for it.
 */
export const EXPLANATION_FRAMING =
  "Based on the official rules we have on file, this may be worth pursuing.";

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

export interface MatchSourceCitation {
  readonly entryId: string;
  readonly entryTitle: string;
  readonly entryVersion: number;
  /** Always "active" on presented cards: non-active entries never surface. */
  readonly entryStatus: string;
  /** Official source URL backing the claim (https only, from the entry). */
  readonly sourceUrl: string;
  /** YYYY-MM-DD date the source content was retrieved. */
  readonly retrievedAt: string;
}

export interface MatchReason {
  /** The program-side claim from the entry's match signal. */
  readonly text: string;
  /** The spec question the signal evaluated, when one did. */
  readonly questionId?: string;
  /**
   * The person's known answer in plain language — ONLY for pii:false
   * questions. Values of pii:true questions never enter card copy.
   */
  readonly answerLabel?: string;
  readonly source: MatchSourceCitation;
}

export type MatchRequirementKind = "document" | "step" | "deadline" | "renewal";

export interface MatchRequirement {
  readonly kind: MatchRequirementKind;
  readonly text: string;
  readonly source: MatchSourceCitation;
}

export interface MatchLink {
  readonly label: string;
  readonly url: string;
  readonly source: MatchSourceCitation;
}

export interface MatchExplanation {
  readonly text: string;
  /** "model": LLM prose that passed every gate; "facts": composed from the entry. */
  readonly source: "model" | "facts";
}

export interface MatchCard {
  readonly entryId: string;
  readonly entryTitle: string;
  readonly entryVersion: number;
  readonly score: number;
  readonly framing: string;
  readonly reasons: readonly MatchReason[];
  readonly requirements: readonly MatchRequirement[];
  readonly links: readonly MatchLink[];
  readonly explanation: MatchExplanation;
  /** Glossary terms (BN-30) the card's copy uses, with sourced definitions. */
  readonly terms: readonly GlossaryTerm[];
}

export interface ToResolveItem {
  readonly questionId: string;
  /** The question in plain language, as the flow asks it. */
  readonly prompt: string;
  readonly status: AnswerStatus;
  readonly statusLabel: string;
}

export interface MatchResponse {
  readonly matches: readonly MatchCard[];
  readonly toResolve: readonly ToResolveItem[];
}

// ---------------------------------------------------------------------------
// Deterministic scoring (VAL-MATCH-001)
// ---------------------------------------------------------------------------

export interface RankedEntry {
  readonly entry: KbEntry;
  readonly score: number;
  readonly reasons: readonly MatchReason[];
}

function selectedStrings(value: unknown): readonly string[] {
  const selected = Array.isArray(value) ? value.map(String) : [String(value)];
  return selected.filter((item) => item.trim() !== "");
}

/**
 * A signal matches only a KNOWN, non-blank answer (fail-closed, BN-16):
 * unknown and unverified answers never infer a match. With no `values`
 * list, any known non-blank answer matches.
 */
function signalMatches(
  signal: KbSignalFact,
  stored: StoredAnswer | undefined,
): boolean {
  if (!stored || stored.status !== "known") {
    return false;
  }
  if (stored.value === null || stored.value === undefined) {
    return false;
  }
  const selected = selectedStrings(stored.value);
  if (selected.length === 0) {
    return false;
  }
  const wanted = signal.values;
  if (!wanted || wanted.length === 0) {
    return true;
  }
  return selected.some((value) => wanted.includes(value));
}

/** Plain-language label of a known answer; option labels win over raw values. */
function plainAnswerLabel(question: Question, value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  const selected = selectedStrings(value);
  if (selected.length === 0) {
    return undefined;
  }
  if (question.options && question.options.length > 0) {
    return selected
      .map(
        (value) =>
          question.options?.find((option) => option.value === value)?.label ?? value,
      )
      .join(", ");
  }
  return selected.join(", ");
}

function sourceCitation(citation: KbCitation): MatchSourceCitation {
  return {
    entryId: citation.entryId,
    entryTitle: citation.entryTitle,
    entryVersion: citation.entryVersion,
    entryStatus: citation.status,
    sourceUrl: citation.sourceUrl,
    retrievedAt: citation.retrievedAt,
  };
}

/** Score one entry: matched signal weights, with one auditable reason each. */
export function scoreEntry(entry: KbEntry, answers: AnswerMap): RankedEntry {
  const reasons: MatchReason[] = [];
  let score = 0;
  for (const signal of entry.facts.match_signals?.items ?? []) {
    if (!signalMatches(signal, answers[signal.questionId])) {
      continue;
    }
    score += signal.weight ?? 1;
    const question = Object.hasOwn(QUESTION_BY_ID, signal.questionId)
      ? QUESTION_BY_ID[signal.questionId]
      : undefined;
    // pii answers never enter copy: the reason cites the program-side claim
    // alone (the value stays in the vault path).
    const answerLabel =
      question && !question.pii
        ? plainAnswerLabel(question, answers[signal.questionId]?.value)
        : undefined;
    reasons.push({
      text: signal.reason,
      questionId: signal.questionId,
      ...(answerLabel !== undefined ? { answerLabel } : {}),
      source: sourceCitation(citeFactGroup(entry, "match_signals")),
    });
  }
  return { entry, score, reasons };
}

/**
 * Rank the ACTIVE entries for one answer map. Deterministic: descending
 * score, ties broken by entry id — stable under any input key order.
 */
export function rankEntries(
  answers: AnswerMap,
  entries: readonly KbEntry[] = KB_ENTRIES,
): readonly RankedEntry[] {
  return entries
    .filter((entry) => entry.status === "active")
    .map((entry) => scoreEntry(entry, answers))
    .sort((a, b) => {
      if (a.score !== b.score) {
        return b.score - a.score;
      }
      return a.entry.id < b.entry.id ? -1 : 1;
    });
}

// ---------------------------------------------------------------------------
// Requirements checklist (BN-15) — every item cites its entry source
// ---------------------------------------------------------------------------

export function buildRequirements(entry: KbEntry): readonly MatchRequirement[] {
  const requirements: MatchRequirement[] = [];
  for (const item of entry.facts.required_documents.items) {
    requirements.push({
      kind: "document",
      text: item,
      source: sourceCitation(citeFactGroup(entry, "required_documents")),
    });
  }
  if (entry.facts.steps) {
    for (const item of entry.facts.steps.items) {
      requirements.push({
        kind: "step",
        text: item,
        source: sourceCitation(citeFactGroup(entry, "steps")),
      });
    }
  }
  for (const item of entry.facts.deadlines.items) {
    requirements.push({
      kind: /\brenewal\b/i.test(item.label) ? "renewal" : "deadline",
      text: `${item.label}: ${item.due}`,
      source: sourceCitation(citeFactGroup(entry, "deadlines")),
    });
  }
  return requirements;
}

// ---------------------------------------------------------------------------
// To-resolve list (BN-16): unknowns surface explicitly, never inferred
// ---------------------------------------------------------------------------

/**
 * Every VISIBLE question whose stored answer is unknown or unverified,
 * in spec order, in plain language. Questions the flow skipped (a known
 * answer made them irrelevant) are absent by design.
 */
export function buildToResolve(answers: AnswerMap): readonly ToResolveItem[] {
  const items: ToResolveItem[] = [];
  for (const question of visibleQuestions(QUESTIONS, answers)) {
    const stored = answers[question.id];
    if (!stored || (stored.status !== "unknown" && stored.status !== "unverified")) {
      continue;
    }
    items.push({
      questionId: question.id,
      prompt: question.prompt,
      status: stored.status,
      statusLabel: answerStatusLabel(stored.status),
    });
  }
  return items;
}

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
      } else if ("intervalMonths" in item) {
        // Renewal schedules (BN-22) are entry facts too.
        parts.push(`${item.label} ${item.appliesTo}`);
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
 * Deterministic explanation composed from the entry's own facts: the
 * fallback when the model is unavailable or its output fails a gate. By
 * construction it quotes the entry, so it is grounded and claim-free.
 */
export function composeFallbackExplanation(entry: KbEntry): string {
  const rule = entry.facts.rules.items[0];
  const document = entry.facts.required_documents.items[0];
  const link = entry.facts.official_links.items[0];
  return (
    `${EXPLANATION_FRAMING} The official rules we have on file state: "${rule}" ` +
    `You would need: ${document} The program lists its official application link: ${link.label} (${link.url}).`
  );
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
// Card assembly
// ---------------------------------------------------------------------------

/** All card copy in one string — the detector scan surface for tests. */
export function matchCardText(card: MatchCard): string {
  return [
    card.framing,
    ...card.reasons.map((reason) => reason.text),
    ...card.requirements.map((requirement) => requirement.text),
    ...card.links.map((link) => link.label),
    card.explanation.text,
    ...card.terms.map((term) => `${term.term}: ${term.definition}`),
  ].join(" ");
}

function buildCard(ranked: RankedEntry, explanation: MatchExplanation): MatchCard {
  const entry = ranked.entry;
  const card: MatchCard = {
    entryId: entry.id,
    entryTitle: entry.title,
    entryVersion: entry.version,
    score: ranked.score,
    framing: MATCH_FRAMING,
    reasons: ranked.reasons,
    requirements: buildRequirements(entry),
    links: entry.facts.official_links.items.map((link) => ({
      label: link.label,
      url: link.url,
      source: sourceCitation(citeFactGroup(entry, "official_links")),
    })),
    explanation,
    terms: [],
  };
  return { ...card, terms: glossaryTermsForText(matchCardText(card)) };
}

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
  // THIS session's specific pii values (lowercased), used to degrade (never
  // pin) an explanation that collides with them. The substring trigger and
  // word-boundary excusal MIRROR the response gate exactly, so any
  // explanation the gate would reject is degraded here first — a cached
  // explanation can never pin a session's match list to a 500.
  const piiValues: { lowered: string; inStatic: RegExp }[] = [];
  for (const questionId of PII_QUESTION_IDS_IN_SPEC) {
    const stored = answers[questionId];
    if (!stored || stored.value === null || stored.value === undefined) {
      continue;
    }
    for (const element of Array.isArray(stored.value) ? stored.value : [stored.value]) {
      const raw = String(element).trim();
      if (raw !== "" && isSpecificValue(raw)) {
        piiValues.push({
          lowered: raw.toLowerCase(),
          inStatic: new RegExp(`\\b${escapeRegExpValue(raw)}\\b`, "i"),
        });
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
    let card = buildCard(rankedEntry, explanation);
    if (
      explanation.source === "model" &&
      piiValues.length > 0 &&
      piiValues.some(
        (value) =>
          card.explanation.text.toLowerCase().includes(value.lowered) &&
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
      card = buildCard(rankedEntry, {
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
      } else if ("intervalMonths" in item) {
        parts.push(`${item.label} ${item.appliesTo}`);
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
 */
function responseStaticCopy(response: MatchResponse): string {
  const parts: string[] = [
    MATCH_FRAMING,
    EXPLANATION_FRAMING,
    ...Object.values(ANSWER_STATUS_LABELS),
  ];
  for (const card of response.matches) {
    const entry = KB_ENTRIES.find(
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
 */
export function assertNoPiiValuesInMatch(
  response: MatchResponse,
  answers: AnswerMap,
): void {
  const serialized = JSON.stringify(response).toLowerCase();
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
      if (!serialized.includes(raw.toLowerCase())) {
        continue;
      }
      const inStaticCopy = new RegExp(
        `\\b${escapeRegExpValue(raw)}\\b`,
        "i",
      ).test(staticCopy);
      if (!inStaticCopy) {
        throw new AppError(
          "internal",
          "A match response attempted to include a private answer value.",
        );
      }
    }
  }
}
