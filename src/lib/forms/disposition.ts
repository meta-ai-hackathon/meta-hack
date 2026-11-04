import type { FormFieldDisposition, FormRegistryEntry } from "./registry";

// Full-form disposition report (full-form mapping part 3, VAL-FIX-007):
// the honest coverage accounting for a registry entry. Every field the
// template carries is in exactly one bucket — mapped (takes a person
// answer), or one of the reviewed blank-by-documentation reasons
// (not_collected_by_interview / optional_unanswered / agency_use_only /
// duplicate_structural). The review surface serves and renders this so
// nothing is silently unmapped: a field is either asked, or its reason is
// named.
//
// Registry data only — no vault import, no answers, no person values: the
// report is the same committed, reviewed artifact the registry JSON is,
// reshaped for the review payload.

export interface DispositionReportField {
  readonly fieldName: string;
  /** The field's printed mapping question (registry data, not a person value). */
  readonly question: string;
  readonly pages: readonly number[];
  readonly disposition: FormFieldDisposition;
  /** Present exactly when the disposition is not "mapped". */
  readonly dispositionReason?: string;
}

export interface DispositionReport {
  readonly counts: Readonly<
    Record<FormFieldDisposition, number> & { readonly total: number }
  >;
  readonly fields: readonly DispositionReportField[];
}

/**
 * Build the full disposition report for one registry entry: per-disposition
 * counts plus a per-field row for EVERY field (all pages). Pure and
 * session-independent — a function of the committed entry alone.
 */
export function buildDispositionReport(
  entry: FormRegistryEntry,
): DispositionReport {
  const counts: Record<FormFieldDisposition, number> & { total: number } = {
    mapped: 0,
    not_collected_by_interview: 0,
    optional_unanswered: 0,
    agency_use_only: 0,
    duplicate_structural: 0,
    total: entry.fields.length,
  };
  const fields: DispositionReportField[] = entry.fields.map((field) => {
    counts[field.disposition] += 1;
    return {
      fieldName: field.name,
      question: field.question,
      pages: field.pages,
      disposition: field.disposition,
      ...(field.dispositionReason !== undefined
        ? { dispositionReason: field.dispositionReason }
        : {}),
    };
  });
  return { counts, fields };
}

/**
 * Where to find a blank field on the printed form: "page 16 of the form",
 * or "pages 16 and 17 of the form" for a multi-page field. Deduped and
 * sorted first (a two-widget field lists its page once, in order); an
 * empty list — impossible from the committed registry (schema minItems:
 * 1) but never applicant-hostile — renders neutral copy. The rows'
 * developer-facing disposition_reason stays in the payload (the
 * retrievable record) — the applicant-facing list points at the page
 * instead.
 */
export function pagePointer(pages: readonly number[]): string {
  const ordered = [...new Set(pages)].sort((a, b) => a - b);
  if (ordered.length === 0) {
    return "the form";
  }
  if (ordered.length === 1) {
    return `page ${ordered[0]} of the form`;
  }
  const head = ordered.slice(0, -1).join(", ");
  const tail = ordered[ordered.length - 1];
  return `pages ${head} and ${tail} of the form`;
}
