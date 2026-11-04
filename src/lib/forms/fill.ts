import type { AnswerMap } from "../intake/flow";
import { AppError, logInfo } from "../telemetry";
import {
  fillLoadedPdf,
  type FillOutcome,
  type FillValue,
} from "./fill-core";
import { assertLoadablePdf } from "./parse";
import type { FormRegistryEntry } from "./registry";

// The deterministic form fill (Mission v2 M4 / HACK-74, BN-18): turn answer
// values into a filled application PDF the person can review and submit
// THEMSELVES. The app never submits anything.
//
// The server fill route (POST /api/forms/<formId>/fill) was RETIRED on the
// owner's HACK-138 decision (2026-11-04): it filled the form on the server
// from the session's stores — the answer table and, through the entry's
// per-form allowlist, the vault — and sent the PDF back to the page, which
// carried vault-held pii values to the client outside the sanctioned
// download (rules.md, HACK-115). Both product downloads now fill ON THE
// DEVICE (src/lib/intake/review-fill.ts for the conversation page,
// src/lib/intake/device-fill.ts for the step-by-step page) from the values
// the client already holds, over the shared deterministic machinery this
// module re-exports from fill-core.ts.
//
// What remains here is the node-side half of that machinery: the full
// fill (template load gate → fill → outcome) over values the caller
// assembles, used by the registry and full-form proof tests. The PDF is
// generated in memory and returned as bytes — never written to disk, a
// database, or a log (VAL-PDF-005), and no log line ever carries a value.
//
// Value semantics, per registry field (fill-core's, shared with the device
// fills): every filled field carries its provenance; fields with no answer
// stay VISIBLY BLANK and are listed as to-resolve; fields whose mapped
// question is skipped by the flow's conditional logic stay blank WITHOUT
// being to-resolve (not applicable — skip logic, BN-18).
export {
  assembleFillValues,
  checkedFormValues,
  detectCheckConflicts,
  FLAT_TEXT_SIZE,
  MAX_FORM_ANSWER_LENGTH,
  MAX_FORM_VALUES,
  skippedFieldNames,
} from "./fill-core";
export type {
  FillConflict,
  FillOutcome,
  FillValue,
  FilledField,
  ToResolveItem,
  ToResolveReason,
} from "./fill-core";

// ---------------------------------------------------------------------------
// The fill itself
// ---------------------------------------------------------------------------

/**
 * Fill the template per the registry entry and return the outcome: the PDF
 * bytes (in memory only), the per-field provenance of everything filled,
 * the explicit to-resolve list, and the conflict flags from the fill-time
 * consistency check. Unknown fields are visibly blank. The caller assembles
 * the values (on the device: the client-held answers; in tests: the fixture
 * persona) — this half owns the template load gate and the count-only logs.
 */
export async function fillFormPdf(
  templateBytes: Uint8Array,
  entry: FormRegistryEntry,
  values: Readonly<Record<string, FillValue>>,
  answerMap: AnswerMap = {},
): Promise<FillOutcome> {
  const pdf = await assertLoadablePdf(templateBytes);
  const { filled, toResolve, conflicts } = await fillLoadedPdf(pdf, entry, values, answerMap, {
    onFieldDegraded: (error) =>
      logInfo("form_field_fill_degraded", {
        reason: error instanceof AppError ? error.code : "field_error",
      }),
  });

  logInfo("form_fill_completed", {
    filledCount: filled.length,
    toResolveCount: toResolve.length,
    conflictCount: conflicts.length,
  });
  return { bytes: await pdf.save(), filled, toResolve, conflicts };
}

// Re-export for the node-side machinery's callers: the shared load/rejection
// gate (XFA, encrypted, corrupt — VAL-PDF-004's meaning, unchanged).
export { assertLoadablePdf };
