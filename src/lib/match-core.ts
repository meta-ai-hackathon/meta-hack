import { glossaryTermsForText, type GlossaryTerm } from "./glossary";
import { answerStatusLabel, type AnswerStatus } from "./honesty";
import {
  KB_ENTRIES,
  citeFactGroup,
  type KbCitation,
  type KbEntry,
  type KbSignalFact,
} from "./kb";
import { QUESTION_BY_ID, QUESTIONS, type Question } from "./intake/spec";
import { visibleQuestions, type AnswerMap, type StoredAnswer } from "./intake/flow";

// The browser-safe half of the benefit match (Mission v2 M3, HACK-115).
//
// Everything here is a pure function of the answer map and the committed
// knowledge base: deterministic scoring, the requirements checklist, the
// to-resolve list, and the explanation composed from the entry's own facts.
// It imports no model client, no telemetry, and no server store, so the
// step-by-step page can build the match in the browser from the answers
// sealed on the device, without any answer leaving it.
//
// match.ts re-exports these names unchanged and adds the server-only half:
// the gated model explanation and the pii defense for responses that leave
// the server. With the model explainer swapped for the facts-only one (the
// consent-declined route), match.ts builds exactly what
// buildFactsMatchResponse builds here (property-proven in
// match-core.test.ts).

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
// The facts-only explanation and card assembly
// ---------------------------------------------------------------------------

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

/** The entry's official application links, each citing its source. */
export function officialLinks(entry: KbEntry): readonly MatchLink[] {
  return entry.facts.official_links.items.map((link) => ({
    label: link.label,
    url: link.url,
    source: sourceCitation(citeFactGroup(entry, "official_links")),
  }));
}

/** One card for a ranked entry, with the explanation it is shown with. */
export function buildMatchCard(ranked: RankedEntry, explanation: MatchExplanation): MatchCard {
  const entry = ranked.entry;
  const card: MatchCard = {
    entryId: entry.id,
    entryTitle: entry.title,
    entryVersion: entry.version,
    score: ranked.score,
    framing: MATCH_FRAMING,
    reasons: ranked.reasons,
    requirements: buildRequirements(entry),
    links: officialLinks(entry),
    explanation,
    terms: [],
  };
  return { ...card, terms: glossaryTermsForText(matchCardText(card)) };
}

/**
 * The match with every explanation composed from the entry's own facts:
 * the ranked cards whose signals matched something (a score-0 entry is
 * never presented as "may be worth pursuing"), plus the to-resolve list.
 * Synchronous and model-free by construction, so it can run anywhere,
 * the browser included.
 */
export function buildFactsMatchResponse(
  answers: AnswerMap,
  entries: readonly KbEntry[] = KB_ENTRIES,
): MatchResponse {
  const matches = rankEntries(answers, entries)
    .filter((rankedEntry) => rankedEntry.score > 0)
    .map((rankedEntry) =>
      buildMatchCard(rankedEntry, {
        text: composeFallbackExplanation(rankedEntry.entry),
        source: "facts",
      }),
    );
  return { matches, toResolve: buildToResolve(answers) };
}
