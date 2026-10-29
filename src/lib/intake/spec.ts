import questionSpecJson from "../../../specs/question-spec/generic-questions.json";

// Read-only loader for the question spec (BN-09 / HACK-37). The JSON document
// is the single source of truth for intake: prompts, help text, options, PII
// classification, and skip conditions. Nothing here duplicates or rewrites
// spec data — the flow engine and the client-state serializer consume this
// module, and the spec is never mutated at runtime.

export type QuestionType =
  | "text"
  | "number"
  | "boolean"
  | "single_select"
  | "multi_select"
  | "date"
  | "address";

export type SkipOperator =
  | "equals"
  | "not_equals"
  | "in"
  | "not_in"
  | "gt";

export interface QuestionOption {
  readonly value: string;
  readonly label: string;
}

export interface SkipCondition {
  readonly question_id: string;
  readonly operator: SkipOperator;
  readonly value: string | number | boolean;
}

export interface Question {
  readonly id: string;
  readonly prompt: string;
  readonly type: QuestionType;
  readonly help: string;
  readonly terms?: readonly string[];
  readonly pii: boolean;
  readonly required: boolean;
  readonly options?: readonly QuestionOption[];
  readonly skip_conditions: readonly SkipCondition[];
  readonly provenance: string;
}

export interface QuestionSpec {
  readonly title: string;
  readonly version: string;
  readonly answer_statuses: readonly string[];
  readonly questions: readonly Question[];
}

export const QUESTION_SPEC = questionSpecJson as unknown as QuestionSpec;

/** All questions in spec order — the flow renders in exactly this order. */
export const QUESTIONS: readonly Question[] = QUESTION_SPEC.questions;

export const QUESTION_BY_ID: Readonly<Record<string, Question>> =
  Object.fromEntries(QUESTIONS.map((question) => [question.id, question]));

/** Question ids marked pii:true — the vault-only set (BN-03). */
export const PII_QUESTION_IDS_IN_SPEC: readonly string[] = QUESTIONS.filter(
  (question) => question.pii,
).map((question) => question.id);
