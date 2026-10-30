import { QUESTION_BY_ID } from "../intake/spec";
import type { FormRegistryField } from "./registry";

// Display form of a stored answer for a registry field. Deliberately a
// vault-free module: the flow view (and through it the review route)
// renders answers and must not transitively pull the vault read path in —
// only forms/fill.ts crosses the vault boundary (see vault-boundary.test).

/**
 * Display form of a stored answer for a registry field: choice answers
 * render their spec option label (labels are display vocabulary, values are
 * storage vocabulary), booleans map onto checkbox state, everything else is
 * its canonical string.
 */
export function displayValueFor(
  field: FormRegistryField,
  raw: unknown,
): string | null {
  if (raw === null || raw === undefined) {
    return null;
  }
  if (field.type === "checkbox") {
    // Boolean answers (jsonb boolean, or the vault's stringified form).
    if (raw === true || raw === "true") {
      return "checked";
    }
    if (raw === false || raw === "false") {
      return "unchecked";
    }
    return null;
  }
  const question =
    field.specQuestionId !== null ? QUESTION_BY_ID[field.specQuestionId] : undefined;
  if (question?.options) {
    const values = Array.isArray(raw) ? raw : [raw];
    const labels = values.map((value) => {
      const option = question.options?.find(
        (candidate) => candidate.value === String(value),
      );
      return option ? option.label : String(value);
    });
    return labels.join(", ");
  }
  return String(raw);
}
