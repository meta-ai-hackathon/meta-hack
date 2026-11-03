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
