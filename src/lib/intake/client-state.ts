import type { AnswerProvenance, AnswerStatus } from "../honesty";
import {
  firstUnansweredIndex,
  progressCounts,
  visibleQuestions,
  type AnswerMap,
} from "./flow";
import { incomeClientState, type IncomeClientState } from "./income";
import { remainingQuickQuestions } from "./requirements";
import { QUESTIONS, type Question, type QuestionOption, type QuestionType } from "./spec";

// Re-exported: the income block is part of this module's public state
// shape (serialize.ts re-exports it onward with the rest).
export type { IncomeClientState };

// The intake's client-visible state (BN-09): what the step-by-step page
// renders. Built the same way whether the answers come from the server
// store (serialize.ts re-exports this as the API's response shape) or from
// the sealed on-device store (HACK-99). Pure and browser-safe: only the
// flow engine, the question spec, and the program-requirements layer,
// never a server module.
//
// A pii:true answer contributes its tri-state status alone — its value is
// structurally omitted, so no pii value reaches the page's rendered state
// (VAL-INTAKE-004). Skipped questions and their stored answers are omitted
// entirely: a skipped question never renders anywhere in the flow.

export interface ClientQuestion {
  readonly id: string;
  readonly prompt: string;
  readonly help: string;
  readonly type: QuestionType;
  readonly required: boolean;
  readonly pii: boolean;
  readonly options?: readonly QuestionOption[];
}

export interface ClientAnswer {
  readonly status: AnswerStatus;
  /** Present ONLY for pii:false questions. */
  readonly value?: unknown;
  /**
   * Where the answer came from (the spine's provenance vocabulary).
   * Present ONLY when it is NOT the default `user_supplied` — the quick-
   * questions and wizard paths keep the exact shape they always had, and
   * the income stage's badges read it when it matters ("From your tax
   * return" / a person-corrected value). Metadata only: never a value.
   */
  readonly provenance?: AnswerProvenance;
}

export interface IntakeProgress {
  readonly answered: number;
  readonly remaining: number;
  readonly total: number;
}

/**
 * The quick-questions counter (VAL-QQ-004): the honest N of M, computed
 * live from the requirements engine for the targeted programs. Ids only —
 * never an answer value; every remaining id has its client-safe
 * definition in this state's questions list.
 */
export interface QuickQuestionsClientState {
  readonly programs: readonly string[];
  /** The required-for-programs universe, spec order. */
  readonly requiredIds: readonly string[];
  /** M — the total required-for-programs universe size. */
  readonly requiredCount: number;
  /** N — still to ask: required minus answered minus skippable. */
  readonly remainingIds: readonly string[];
  readonly remainingCount: number;
  /**
   * True when nothing required is left to ask. Ask-once semantics: any
   * stored answer — including `unknown`/`unverified` — counts as asked,
   * so `complete` means "nothing left to ask", never "fully confirmed
   * data"; surfaces needing uncertainty should read the tri-state
   * statuses in `answers`, not this flag alone.
   */
  readonly complete: boolean;
}

export interface IntakeClientState {
  /** Visible questions in spec order — skipped questions are absent. */
  readonly questions: readonly ClientQuestion[];
  /** Stored answers for visible questions, pii values stripped. */
  readonly answers: Readonly<Record<string, ClientAnswer>>;
  readonly progress: IntakeProgress;
  /** Index into questions of the first unanswered one; null when complete. */
  readonly currentIndex: number | null;
  readonly complete: boolean;
  /** The quick-questions N-of-M counter for the targeted programs. */
  readonly quickQuestions: QuickQuestionsClientState;
  /** The income stage's gate state (milestone income-capture). */
  readonly income: IncomeClientState;
}

function toClientQuestion(question: Question): ClientQuestion {
  return {
    id: question.id,
    prompt: question.prompt,
    help: question.help,
    type: question.type,
    required: question.required,
    pii: question.pii,
    ...(question.options ? { options: question.options } : {}),
  };
}

/**
 * The provenance field is exposed ONLY when it is not the default
 * `user_supplied`, so every payload a default-path answer produces keeps
 * its exact historical shape ({status, value} / {status} for pii) and the
 * income stage's badges read the field when it carries meaning.
 */
function clientProvenance(
  stored: { provenance?: AnswerProvenance },
): AnswerProvenance | undefined {
  const { provenance } = stored;
  return provenance !== undefined && provenance !== "user_supplied"
    ? provenance
    : undefined;
}

/**
 * Build the client-visible state from stored answers. Pure: a function of
 * the answer map and the read-only question spec.
 */
export function buildClientState(answers: AnswerMap): IntakeClientState {
  const visible = visibleQuestions(QUESTIONS, answers);
  const clientAnswers: Record<string, ClientAnswer> = {};
  for (const question of visible) {
    const stored = answers[question.id];
    if (!stored) {
      continue;
    }
    const provenance = clientProvenance(stored);
    // The pii branch never touches the stored value — structural omission.
    // Provenance is metadata about origin, safe for both branches.
    clientAnswers[question.id] = question.pii
      ? { status: stored.status, ...(provenance ? { provenance } : {}) }
      : {
          status: stored.status,
          value: stored.value ?? null,
          ...(provenance ? { provenance } : {}),
        };
  }
  const progress = progressCounts(visible, answers);
  const firstUnanswered = firstUnansweredIndex(visible, answers);
  // The quick-questions counter targets the committed default programs;
  // the same pure computation runs server- and device-side.
  const quick = remainingQuickQuestions(answers);
  return {
    questions: visible.map(toClientQuestion),
    answers: clientAnswers,
    progress,
    currentIndex: firstUnanswered === -1 ? null : firstUnanswered,
    complete: firstUnanswered === -1,
    quickQuestions: {
      programs: quick.programs,
      requiredIds: quick.requiredIds,
      requiredCount: quick.requiredCount,
      remainingIds: quick.remainingIds,
      remainingCount: quick.remainingCount,
      complete: quick.complete,
    },
    income: incomeClientState(visible, answers),
  };
}
