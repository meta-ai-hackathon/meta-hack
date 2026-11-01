import type { AnswerStatus } from "../honesty";
import {
  firstUnansweredIndex,
  progressCounts,
  visibleQuestions,
  type AnswerMap,
} from "./flow";
import { remainingQuickQuestions } from "./requirements";
import { QUESTIONS, type Question, type QuestionOption, type QuestionType } from "./spec";

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
    // The pii branch never touches the stored value — structural omission.
    clientAnswers[question.id] = question.pii
      ? { status: stored.status }
      : { status: stored.status, value: stored.value ?? null };
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
  };
}
