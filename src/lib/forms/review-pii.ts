import { isSpecificValue } from "../conversation";
import type { AnswerMap } from "../intake/flow";
import { PII_QUESTION_IDS_IN_SPEC, QUESTIONS } from "../intake/spec";
import { AppError } from "../telemetry";
import type { FormRegistryEntry } from "./registry";
import type { FormFlowFieldView } from "./flow";

// The form-review payload's pii defense in depth (the DSS-8207 milestone,
// assertNoPiiValues semantics for the review surfaces): the flow view
// structurally omits every pii-likely field's value (flow.ts), and this
// check is the second line of defense before the payload leaves the
// server. Mirrors the match module's per-value check (its
// responseStaticCopy design): the excusal set is built from the COMMITTED
// sources a review can legitimately render — never from the serialized
// payload itself, so a copy-generation bug that echoes user content can
// never excuse its own leak.
//
// This module is server-side only (the review route imports it); it must
// never enter the client bundle and never import the vault read path.

function escapeRegExpValue(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Throw loudly if a form-review field view (and anything else about to
 * serialize with it) carries a stored value of a pii:true question. The
 * message stays generic; no value or question id is echoed back.
 *
 * Two halves:
 * 1. Structural — a pii-likely view never carries a `value` key at all.
 * 2. Needle — no SPECIFIC stored pii value appears anywhere in the
 *    serialized view, with the same per-value excusal rule the match
 *    module applies (claude-review P2-3 on PR #45): a value
 *    indistinguishable from the review's legitimate copy is not a
 *    disclosure. The legitimate copy is exactly:
 *    - the registry entry's own text (field names + printed questions —
 *      committed, reviewed data; a short answer like "shelter" is a word
 *      of it),
 *    - the spec's public option labels the display path renders,
 *    - the person's own non-pii answer values, whose display content may
 *      legitimately carry the same string.
 *    A raw echo of any OTHER user text is never part of the excusal set,
 *    so a leak can never excuse itself.
 */
export function assertNoPiiValuesInFormReview(
  fields: readonly FormFlowFieldView[],
  answers: AnswerMap,
  entry: FormRegistryEntry,
): void {
  for (const field of fields) {
    if (field.piiLikely && "value" in field) {
      throw new AppError(
        "internal",
        "A form review attempted to include a private answer value.",
      );
    }
  }

  // Excusal part 1: the registry's own committed text, word-matched (the
  // serialized view is NOT the source — a fabricated echo into a view's
  // question stays a finding).
  const registryCopy = entry.fields
    .map((field) => `${field.name} ${field.question}`)
    .join(" ")
    .toLowerCase();
  const isWordOfRegistryCopy = (value: string): boolean =>
    new RegExp(`\\b${escapeRegExpValue(value)}\\b`, "i").test(registryCopy);

  // Excusal part 2: the spec's public option labels (multi-select labels
  // join with commas; the parts rule is the match module's
  // isSpecProducedLabel).
  const specLabels = new Set(
    QUESTIONS.flatMap((question) =>
      (question.options ?? []).map((option) =>
        option.label.trim().toLowerCase(),
      ),
    ),
  );
  const isSpecLabel = (value: string): boolean =>
    value
      .split(",")
      .map((part) => part.trim())
      .every((part) => specLabels.has(part));

  // Excusal part 3: the person's own non-pii answer values — the review's
  // legitimate display content, whatever field shows it.
  const publicValues = new Set<string>();
  for (const [questionId, stored] of Object.entries(answers)) {
    if (PII_QUESTION_IDS_IN_SPEC.includes(questionId)) {
      continue;
    }
    if (!stored || stored.value === null || stored.value === undefined) {
      continue;
    }
    const elements = Array.isArray(stored.value)
      ? stored.value
      : [stored.value];
    for (const element of elements) {
      const raw = String(element).trim().toLowerCase();
      if (raw !== "") {
        publicValues.add(raw);
      }
    }
  }

  const serialized = JSON.stringify(fields).toLowerCase();
  for (const questionId of PII_QUESTION_IDS_IN_SPEC) {
    const stored = answers[questionId];
    if (!stored || stored.value === null || stored.value === undefined) {
      continue;
    }
    const elements = Array.isArray(stored.value)
      ? stored.value
      : [stored.value];
    for (const element of elements) {
      const raw = String(element).trim();
      // Generic one-word answers ("yes") would over-match ordinary copy;
      // the same specificity rule the conversation redactor uses. A
      // WHOLLY-digit needle under five digits is skipped in addition: the
      // view's own structural numbers (field names, printed years like
      // "1996") would over-match, and such a needle could never diagnose
      // a leak. Longer digit runs (phones, digit-dates) stay live.
      const digitsOnly = raw.replace(/\D/g, "");
      if (
        raw === "" ||
        !isSpecificValue(raw) ||
        (/^\d+$/.test(raw) && digitsOnly.length < 5)
      ) {
        continue;
      }
      const lowered = raw.toLowerCase();
      if (!serialized.includes(lowered)) {
        continue;
      }
      const excused =
        isWordOfRegistryCopy(lowered) ||
        isSpecLabel(lowered) ||
        // The needle rides inside (or equals) the person's own non-pii
        // display content. The reverse — a public value inside a longer
        // private one — never excuses: sharing a number with displayed
        // copy does not make a private narrative displayable.
        [...publicValues].some((publicValue) => publicValue.includes(lowered));
      if (!excused) {
        throw new AppError(
          "internal",
          "A form review attempted to include a private answer value.",
        );
      }
    }
  }
}
