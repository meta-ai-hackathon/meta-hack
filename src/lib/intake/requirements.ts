import programRequirementsJson from "../../../specs/question-spec/program-requirements.json";
import dhb5200RegistryJson from "../../../kb/forms/dhb-5200.json";
import { isQuestionVisible, type AnswerMap } from "./flow";
import { QUESTION_BY_ID, QUESTIONS } from "./spec";

// Program-requirements engine (quick-questions milestone, VAL-QQ-003/004).
//
// A pure, browser-safe layer over the question spec: WHICH questions a
// targeted program's application needs, and of those, which a session
// still has to answer. Three inputs, all committed data:
//
// - specs/question-spec/program-requirements.json — the reviewed decision
//   listing per-program required question ids;
// - the committed form registries a program links (kb/forms/*.json) —
//   their spec_question_id fields join the universe, so requirements grow
//   with the forms as they are mapped;
// - specs/question-spec/generic-questions.json — the single source of
//   truth for question DEFINITIONS; this layer only selects from it.
//
// The still-to-ask set REUSES the flow engine's skip logic
// (isQuestionVisible, OR-semantics, fail-open) — never a fork. The
// counter is honest math: M = the required-for-programs universe size,
// N = the minimal still-to-ask size. Nothing is hardcoded; a fresh
// session shows N = M (with no known answers nothing is skippable yet).

export interface ProgramRequirement {
  readonly id: string;
  readonly title: string;
  readonly form_registry_ids: readonly string[];
  readonly required_question_ids: readonly string[];
  readonly rationale: string;
}

export interface ProgramRequirementsSpec {
  readonly title: string;
  readonly version: string;
  readonly default_programs: readonly string[];
  readonly programs: readonly ProgramRequirement[];
}

export const PROGRAM_REQUIREMENTS =
  programRequirementsJson as unknown as ProgramRequirementsSpec;

/**
 * The committed form registries a program's requirements may link to, by
 * registry id. Each entry is the single source of that registry's
 * spec_question_id links (pytest cross-checks them against the question
 * spec). When the snap-form milestone commits dss-8207.json, its program
 * gains one line here — no engine change.
 */
const REGISTRY_JSON_BY_ID: Readonly<Record<string, unknown>> = {
  "dhb-5200": dhb5200RegistryJson,
};

interface RawFormRegistry {
  readonly fields: readonly { readonly spec_question_id: string | null }[];
}

function fail(message: string): never {
  throw new Error(`program-requirements: ${message}`);
}

/** The spec question ids a committed registry's fields link to. */
function registrySpecQuestionIds(registryId: string): readonly string[] {
  const raw = REGISTRY_JSON_BY_ID[registryId];
  if (raw === undefined) {
    return fail(`unknown form registry ${registryId}`);
  }
  const fields = (raw as RawFormRegistry).fields;
  if (!Array.isArray(fields)) {
    return fail(`form registry ${registryId} carries no fields list`);
  }
  return fields.flatMap((field) =>
    field.spec_question_id === null ? [] : [field.spec_question_id],
  );
}

/** Programs the session targets unless said otherwise (committed default). */
export const DEFAULT_PROGRAM_IDS: readonly string[] =
  PROGRAM_REQUIREMENTS.default_programs;

function program(id: string): ProgramRequirement {
  const entry = PROGRAM_REQUIREMENTS.programs.find(
    (candidate) => candidate.id === id,
  );
  if (entry === undefined) {
    return fail(`unknown program ${id}`);
  }
  return entry;
}

/**
 * The per-program required question-id universe: the union of the
 * committed required_question_ids and every linked registry's
 * spec_question_id links, in question-spec order, deduplicated. Every id
 * is a question the spec defines (validated at load below).
 */
export function requiredForPrograms(
  programIds: readonly string[],
): readonly string[] {
  const wanted = new Set<string>();
  for (const id of programIds) {
    const entry = program(id);
    for (const questionId of entry.required_question_ids) {
      wanted.add(questionId);
    }
    for (const registryId of entry.form_registry_ids) {
      for (const questionId of registrySpecQuestionIds(registryId)) {
        wanted.add(questionId);
      }
    }
  }
  // Spec order makes the universe deterministic and render-ready.
  return QUESTIONS.filter((question) => wanted.has(question.id)).map(
    (question) => question.id,
  );
}

/** The quick-questions view of a session's state: the honest N of M. */
export interface QuickQuestionsView {
  /** The targeted program ids this view was computed for. */
  readonly programs: readonly string[];
  /** The required-for-programs universe, question-spec order. */
  readonly requiredIds: readonly string[];
  /** M — the total required-for-programs universe size. */
  readonly requiredCount: number;
  /**
   * N — the minimal still-to-ask set, question-spec order: the universe
   * minus answered (any stored answer counts as asked once) minus
   * skippable (the flow engine's skip conditions, fail-open).
   */
  readonly remainingIds: readonly string[];
  readonly remainingCount: number;
  /**
   * True when nothing required is left to ask. Ask-once semantics: a
   * question with ANY stored answer — including `unknown`/`unverified` —
   * is not asked again, so `complete` means "nothing left to ask", never
   * "fully confirmed data". A surface that needs to show uncertainty
   * should consult the answers' tri-state statuses, not this flag alone.
   */
  readonly complete: boolean;
}

/**
 * The minimal still-to-ask set for the targeted programs, given stored
 * answers: program requirements minus answered minus skippable. Pure: a
 * function of the answer map and the committed requirements data.
 */
export function remainingQuickQuestions(
  answers: AnswerMap,
  programIds: readonly string[] = DEFAULT_PROGRAM_IDS,
): QuickQuestionsView {
  const requiredIds = requiredForPrograms(programIds);
  const remainingIds = requiredIds.filter(
    (id) => answers[id] === undefined && isQuestionVisible(QUESTION_BY_ID[id]!, answers),
  );
  return {
    programs: [...programIds],
    requiredIds,
    requiredCount: requiredIds.length,
    remainingIds,
    remainingCount: remainingIds.length,
    complete: remainingIds.length === 0,
  };
}

// Load-time validation of the committed layer (the pytest gate
// tests/test_program_requirements.py is the other half): fail fast when a
// referenced id or registry does not resolve, so a bad requirements file
// can never silently narrow a session's question set.
for (const entry of PROGRAM_REQUIREMENTS.programs) {
  for (const questionId of entry.required_question_ids) {
    if (QUESTION_BY_ID[questionId] === undefined) {
      fail(
        `${entry.id}: required id ${questionId} is not a generic-questions.json question id`,
      );
    }
  }
  for (const registryId of entry.form_registry_ids) {
    for (const questionId of registrySpecQuestionIds(registryId)) {
      if (QUESTION_BY_ID[questionId] === undefined) {
        fail(
          `${entry.id}: registry-linked id ${questionId} is not a generic-questions.json question id`,
        );
      }
    }
  }
}
for (const id of PROGRAM_REQUIREMENTS.default_programs) {
  program(id);
}
