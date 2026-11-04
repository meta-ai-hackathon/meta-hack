// The review surfaces' shared layout logic (HACK-153 + HACK-154): the
// plain-language question text, the person scoping, and the page grouping
// both review surfaces (the conversation page's review section and the
// step-by-step page's results) render with. Browser-safe by construction:
// pure functions over the registry field shapes, no store, no vault, no
// filesystem, no telemetry.
//
// WHY A SHARED MODULE: both surfaces must group the remaining fields by
// the form's own step (the page it prints on), hide the per-person fields
// of people who are not on the application, and label a box question with
// a Yes/No pair. Rendering that differently on the two surfaces would let
// one surface drift back to the field dump the tickets describe.

import type { FormRegistryField } from "./registry-core";

/**
 * The field question without its parenthetical explanation: the plain
 * question a person reads ("Is Person 2 employed?" from "Is Person 2
 * employed? (The Employed box of the form's check-one work-status line
 * for Person 2.)"). The explanations are registry voice, not person
 * voice, and they repeat on every row.
 */
export function plainQuestion(question: string): string {
  const trimmed = question.trimEnd();
  if (trimmed.endsWith(")")) {
    const open = trimmed.lastIndexOf(" (");
    if (open > 0) {
      return trimmed.slice(0, open).trimEnd();
    }
  }
  return trimmed;
}

/**
 * How many people are on the application, from the household size the
 * session answered: the number the person gave, at least 1 (the
 * applicant), capped at 6 (the form's own per-person sections cover
 * Person 2 through Person 6). When the answer isn't known the applicant
 * alone is counted — the application is for the person themself unless
 * they said otherwise.
 */
export function peopleOnApplication(householdSize: unknown): number {
  const size =
    typeof householdSize === "number"
      ? householdSize
      : typeof householdSize === "string" && householdSize.trim() !== ""
        ? Number(householdSize)
        : NaN;
  if (!Number.isFinite(size)) {
    return 1;
  }
  return Math.min(6, Math.max(1, Math.floor(size)));
}

/**
 * Whether a field's question belongs to a person who is on the
 * application: the form words its per-person sections "Person 2", "Person
 * 3", and so on (Person 1 is the applicant). Anything else — an
 * applicant-level question, or a question the form words without a person
 * number — always shows.
 */
export function personShowsField(question: string, people: number): boolean {
  const match = /Person\s+(\d+)/.exec(question);
  if (!match) {
    return true;
  }
  return Number(match[1]) <= people;
}

/**
 * The form step a field belongs to: the first page it prints on (a
 * field's pages are sorted, deduped, and never empty in a committed
 * entry). The review surfaces group the remaining fields under these.
 */
export function fieldStep(field: { readonly pages?: readonly number[] }): number {
  return field.pages?.[0] ?? 1;
}

/**
 * Group a field list by form step, in step order, registry order within a
 * step. Returns the steps in ascending order with the fields that print
 * on each.
 */
export function groupByStep<T extends { readonly pages?: readonly number[] }>(
  fields: readonly T[],
): readonly { readonly step: number; readonly fields: readonly T[] }[] {
  const byStep = new Map<number, T[]>();
  for (const field of fields) {
    const step = fieldStep(field);
    const bucket = byStep.get(step);
    if (bucket) {
      bucket.push(field);
    } else {
      byStep.set(step, [field]);
    }
  }
  return [...byStep.entries()]
    .sort(([a], [b]) => a - b)
    .map(([step, stepFields]) => ({ step, fields: stepFields }));
}

/**
 * The words a box pair's two options put in the draft: the fill reads a
 * box as checked only for the word "checked" and prints it unchecked for
 * the word "unchecked" — anything else would print an unchecked box with
 * no word to the person. The Yes/No pair's values are these words.
 */
export const BOX_PAIR_WORDS = { yes: "checked", no: "unchecked" } as const;

/** Whether a field is one of the form's boxes (a Yes/No pair's subject). */
export function isBoxField(
  field: Pick<FormRegistryField, "type">,
): boolean {
  return field.type === "checkbox" || field.type === "radio";
}
