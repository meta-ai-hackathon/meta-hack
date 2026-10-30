import type { AnswerStatus } from "../honesty";
import {
  firstUnansweredIndex,
  progressCounts,
  visibleQuestions,
  type AnswerMap,
} from "./flow";
import { QUESTIONS, type Question, type QuestionOption, type QuestionType } from "./spec";

// The intake's client-visible state (BN-09): what the step-by-step page
// renders. Built the same way whether the answers come from the server
// store (serialize.ts re-exports this as the API's response shape) or from
// the sealed on-device store (HACK-99). Pure and browser-safe: only the
// flow engine and the question spec, never a server module.
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

export interface IntakeClientState {
  /** Visible questions in spec order — skipped questions are absent. */
  readonly questions: readonly ClientQuestion[];
  /** Stored answers for visible questions, pii values stripped. */
  readonly answers: Readonly<Record<string, ClientAnswer>>;
  readonly progress: IntakeProgress;
  /** Index into questions of the first unanswered one; null when complete. */
  readonly currentIndex: number | null;
  readonly complete: boolean;
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
  return {
    questions: visible.map(toClientQuestion),
    answers: clientAnswers,
    progress,
    currentIndex: firstUnanswered === -1 ? null : firstUnanswered,
    complete: firstUnanswered === -1,
  };
}
