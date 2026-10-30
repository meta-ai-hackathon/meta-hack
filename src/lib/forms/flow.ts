import { isQuestionVisible, type AnswerMap } from "../intake/flow";
import { QUESTION_BY_ID } from "../intake/spec";
import type { AnswerStatus, SessionStatus } from "../honesty";
import type { AnswerProvenance } from "../intake/store";
import type { FormRegistryEntry, FormRegistryField } from "./registry";
import { displayValueFor } from "./display";

// Form-driven flow (Mission v2 M4, BN-18/BN-21): the application form's
// questions join the conversation. A form field either:
//
// - maps to a question-spec id the session already answered → it is
//   PRE-FILLED ("we already know this from what you told us") and never
//   re-asked;
// - maps to a spec question the flow SKIPS (conditional logic) → it is
//   NOT_APPLICABLE: blank by design, never asked, never to-resolve;
// - maps to a spec question with no stored answer yet → it is ASKED (the
//   conversation collects it through the normal pipeline);
// - maps to nothing (the spec doesn't ask it) → it is also ASKED here,
//   answered into the form-answer store.
//
// The view is what the review screen renders: answered vs still-needed
// (BN-21), with every field's provenance and pii fields' values structurally
// omitted (sensitive-by-default, the serialize.ts discipline).

export type FormFlowFieldState = "prefilled" | "asked" | "not_applicable";

export interface FormFlowFieldView {
  readonly fieldName: string;
  readonly type: FormRegistryField["type"];
  readonly question: string;
  readonly state: FormFlowFieldState;
  readonly specQuestionId: string | null;
  readonly required: boolean;
  /** Status + provenance of the source answer, when one exists. */
  readonly status?: AnswerStatus;
  readonly provenance?: AnswerProvenance;
  /**
   * Display value — ONLY for pii_likely:false fields. Pii values are
   * structurally omitted from client views; their status/provenance badge
   * ("You told us") renders instead.
   */
  readonly value?: string;
  /** True when this view must never include a value (pii_likely field). */
  readonly piiLikely: boolean;
}

export interface FormFlowView {
  readonly formId: string;
  readonly formTitle: string;
  readonly fields: readonly FormFlowFieldView[];
  readonly toResolve: readonly { fieldName: string; question: string }[];
  readonly counts: { prefilled: number; asked: number; notApplicable: number };
}

/**
 * Build the form-driven question view for one registry entry against the
 * session's answers. Pure: a function of the entry, the answer map, the
 * stored form answers (unmapped fields', keyed by field name), and the
 * per-spec-question provenance lookup (the answer table's provenances).
 */
export function buildFormFlow(
  entry: FormRegistryEntry,
  answers: AnswerMap,
  formAnswers: Readonly<Record<string, { value: string; provenance: AnswerProvenance }>> = {},
  provenances: Readonly<Record<string, AnswerProvenance>> = {},
): FormFlowView {
  const fields: FormFlowFieldView[] = [];
  const toResolve: { fieldName: string; question: string }[] = [];
  const counts = { prefilled: 0, asked: 0, notApplicable: 0 };

  for (const field of entry.fields) {
    if (field.specQuestionId !== null) {
      const question =
        Object.hasOwn(QUESTION_BY_ID, field.specQuestionId)
          ? QUESTION_BY_ID[field.specQuestionId]
          : undefined;
      if (question && !isQuestionVisible(question, answers)) {
        // Conditional logic skips the mapped question: not applicable.
        fields.push(toView(field, "not_applicable"));
        counts.notApplicable += 1;
        continue;
      }
      const stored = answers[field.specQuestionId];
      if (
        stored &&
        stored.status !== "unknown" &&
        stored.value !== null &&
        stored.value !== undefined
      ) {
        // Known answer on file: pre-filled, never re-asked ("we already
        // know this from what you told us"). Pii values are structurally
        // omitted; the status badge speaks for them.
        const displayValue = displayValueFor(
          field,
          stored.value,
        );
        fields.push({
          ...toView(
            field,
            "prefilled",
            stored.status,
            provenances[field.specQuestionId],
          ),
          ...(field.piiLikely || displayValue === null
            ? {}
            : { value: displayValue }),
        });
        counts.prefilled += 1;
        continue;
      }
      // Mapped but unanswered (or answered unknown): asked through the
      // conversation pipeline, and still-needed on the review (BN-21).
      fields.push(toView(field, "asked", stored?.status));
      toResolve.push({ fieldName: field.name, question: field.question });
      counts.asked += 1;
      continue;
    }
    // Unmapped: asked here, answered into the form-answer store.
    const formAnswer = formAnswers[field.name];
    if (formAnswer) {
      fields.push({
        ...toView(field, "prefilled", undefined, formAnswer.provenance),
        ...(field.piiLikely ? {} : { value: formAnswer.value }),
      });
      counts.prefilled += 1;
      continue;
    }
    fields.push(toView(field, "asked"));
    toResolve.push({ fieldName: field.name, question: field.question });
    counts.asked += 1;
  }

  return {
    formId: entry.id,
    formTitle: entry.title,
    fields,
    toResolve,
    counts,
  };
}

function toView(
  field: FormRegistryField,
  state: FormFlowFieldState,
  status?: AnswerStatus,
  provenance?: AnswerProvenance,
): FormFlowFieldView {
  const view = {
    fieldName: field.name,
    type: field.type,
    question: field.question,
    state,
    specQuestionId: field.specQuestionId,
    required: field.required,
    piiLikely: field.piiLikely,
  };
  const effectiveProvenance =
    provenance ?? (state === "prefilled" ? ("user_supplied" as const) : undefined);
  return {
    ...view,
    ...(status ? { status } : {}),
    ...(effectiveProvenance ? { provenance: effectiveProvenance } : {}),
  };
}

/**
 * The session lifecycle states the forms surfaces may move the session
 * through (BN-25): draft → prepared → handed_off. No forms surface can set
 * a submitted state — those exist only as user_reported_* values (the type
 * system enforces it; the session route re-validates it).
 */
export const FORM_SESSION_TRANSITIONS: readonly SessionStatus[] = [
  "draft",
  "prepared",
  "handed_off",
];
