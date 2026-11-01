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
/**
 * A display_format renders an ISO date answer in the format the form
 * itself prints ("mm/dd/yyyy" on the DHB-5200): the mm/dd/yyyy tokens are
 * replaced with the zero-padded date parts. Returns null for anything
 * that is not an ISO yyyy-mm-dd string, so non-date answers fall through
 * to the ordinary display path unchanged.
 */
function formatDateByPattern(iso: string, pattern: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) {
    return null;
  }
  const [, year, month, day] = match;
  return pattern
    .replace("yyyy", year)
    .replace("mm", month)
    .replace("dd", day);
}

export function displayValueFor(
  field: FormRegistryField,
  raw: unknown,
): string | null {
  if (raw === null || raw === undefined) {
    return null;
  }
  if (field.type === "checkbox" || field.type === "radio") {
    // Boolean answers (jsonb boolean, or the vault's stringified form).
    // Radio pairs (the yes/no widget groups) take the same checked/unchecked
    // display as checkboxes: the fill selects the pair's discovered yes/no
    // export value from it. Anything non-boolean renders null — the fill
    // never guesses which box a non-boolean answer would check.
    if (raw === true || raw === "true") {
      return "checked";
    }
    if (raw === false || raw === "false") {
      return "unchecked";
    }
    return null;
  }
  // The form's printed date format, when the entry declares one.
  if (field.displayFormat !== undefined && typeof raw === "string") {
    const formatted = formatDateByPattern(raw, field.displayFormat);
    if (formatted !== null) {
      return formatted;
    }
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
