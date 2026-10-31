import type { AnswerMap } from "../intake/flow";
import { loadAnswerRecords } from "../intake/store";
import { QUESTION_BY_ID } from "../intake/spec";
import { readVaultFieldsForFill } from "../vault";
import { AppError, logInfo } from "../telemetry";
import {
  assembleFillValues,
  checkedFormValues,
  fillLoadedPdf,
  type FillOutcome,
  type FillValue,
} from "./fill-core";
import { assertLoadablePdf } from "./parse";
import type { FormRegistryEntry } from "./registry";

// Forms fill (Mission v2 M4 / HACK-74, BN-18): turn answers into a filled
// application PDF the person can review and submit THEMSELVES. The app
// never submits anything.
//
// Value sources, per registry field:
// - mapped to a spec question: the session's stored answer. Non-pii values
//   come from the answer table (loadAnswerRecords); pii values cross the
//   vault boundary ONLY via readVaultFieldsForFill with the entry's
//   committed per-form fill allowlist — the forms module is the second
//   sanctioned accessor (VAL-PDF-006).
// - unmapped: asked in the flow, answered in the review view, and sent WITH
//   the fill request. They live only in memory for the one fill — the real
//   data rules forbid any new server-side store for answers (no plaintext
//   table, no client payload beyond the person's own session), so nothing
//   here writes them down; a later download asks for them again.
//
// Every filled field carries its provenance; fields with no answer stay
// VISIBLY BLANK and are listed as to-resolve; fields whose mapped question
// is skipped by the flow's conditional logic stay blank WITHOUT being
// to-resolve (not applicable — skip logic, BN-18).
//
// The PDF is generated in memory and returned as bytes. It is NEVER written
// to disk, a database, or a log here — filled PDFs are never persisted
// server-side (VAL-PDF-005), and no log line ever carries a value.
//
// The value assembly and the fill itself live in fill-core.ts, which the
// step-by-step page also runs in the browser over the answers on the device
// (HACK-115). They are re-exported here unchanged; this module keeps the
// server-only half: the session and vault reads, the template load gate,
// and the log lines.
export {
  FLAT_TEXT_SIZE,
  MAX_FORM_ANSWER_LENGTH,
  MAX_FORM_VALUES,
  skippedFieldNames,
} from "./fill-core";
export type {
  FillOutcome,
  FillValue,
  FilledField,
  ToResolveItem,
  ToResolveReason,
} from "./fill-core";

// ---------------------------------------------------------------------------
// Value collection — the vault crossing
// ---------------------------------------------------------------------------

/**
 * Validate the in-request form values that ride the fill request: keys must
 * be UNMAPPED fields of the entry (spec-mapped fields never come this way —
 * their answers live in the ordinary intake stores), values bounded
 * non-empty text. Returns a plain record for collectFillValues; anything
 * else is a taxonomy error. This is memory-only state — nothing here
 * persists it.
 */
export function parseFormValues(
  entry: FormRegistryEntry,
  raw: unknown,
): Record<string, string> {
  const values = checkedFormValues(entry, raw);
  if (values === null) {
    throw new AppError("validation_error", "We couldn't use those form answers.");
  }
  return values;
}

/**
 * Assemble the fill values for one form from the session's stored answers
 * plus the IN-REQUEST form values (unmapped fields).
 *
 * Vault crossing: every pii value is read through readVaultFieldsForFill,
 * which admits exactly the entry's committed per-form allowlist and nothing
 * else. A registry entry that mapped a pii question missing from its
 * allowlist can never see that value — the field degrades to to-resolve
 * instead (fail-closed). Non-pii values come from the answer table. No
 * value or field id is logged.
 */
export async function collectFillValues(
  sessionId: string,
  entry: FormRegistryEntry,
  formValues: Readonly<Record<string, string>> = {},
): Promise<{
  values: Record<string, FillValue>;
  answerMap: AnswerMap;
}> {
  const records = await loadAnswerRecords(sessionId);
  const vaultValues = await readVaultFieldsForFill(sessionId, entry);
  const decoded: Record<string, unknown> = {};
  for (const [field, raw] of Object.entries(vaultValues)) {
    decoded[field] = decodeVaultValue(field, raw);
  }
  return assembleFillValues(entry, records, decoded, formValues);
}

function questionById(questionId: string) {
  return Object.hasOwn(QUESTION_BY_ID, questionId)
    ? QUESTION_BY_ID[questionId]
    : undefined;
}

/** Decode a vault text value into the answer shape for its question type. */
function decodeVaultValue(questionId: string, raw: string): unknown {
  const question = questionById(questionId);
  if (!question) {
    return raw;
  }
  if (question.type === "multi_select") {
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : raw;
    } catch {
      return raw;
    }
  }
  if (question.type === "boolean") {
    return raw === "true";
  }
  return raw;
}

// ---------------------------------------------------------------------------
// The fill itself
// ---------------------------------------------------------------------------

/**
 * Fill the template per the registry entry and return the outcome: the PDF
 * bytes (in memory only), the per-field provenance of everything filled,
 * and the explicit to-resolve list. Unknown fields are visibly blank.
 * Skipped (not-applicable) fields are handled by fillForSession, which owns
 * the answer map.
 */
export async function fillFormPdf(
  templateBytes: Uint8Array,
  entry: FormRegistryEntry,
  values: Readonly<Record<string, FillValue>>,
  answerMap: AnswerMap = {},
): Promise<FillOutcome> {
  const pdf = await assertLoadablePdf(templateBytes);
  const { filled, toResolve } = await fillLoadedPdf(pdf, entry, values, answerMap, {
    onFieldDegraded: (error) =>
      logInfo("form_field_fill_degraded", {
        reason: error instanceof AppError ? error.code : "field_error",
      }),
  });

  logInfo("form_fill_completed", {
    filledCount: filled.length,
    toResolveCount: toResolve.length,
  });
  return { bytes: await pdf.save(), filled, toResolve };
}

/**
 * Full fill for one session: collect values (the vault crossing, plus the
 * in-request form values) → fill → skip-logic-aware to-resolve list. The
 * route calls this; the halves are separate so tests can exercise them
 * independently. The in-request form values live only for this call.
 */
export async function fillForSession(
  templateBytes: Uint8Array,
  entry: FormRegistryEntry,
  sessionId: string,
  formValues: Readonly<Record<string, string>> = {},
): Promise<FillOutcome> {
  const { values, answerMap } = await collectFillValues(
    sessionId,
    entry,
    formValues,
  );
  return fillFormPdf(templateBytes, entry, values, answerMap);
}

// Re-export for the route: the shared load/rejection gate (XFA, encrypted,
// corrupt — VAL-PDF-004).
export { assertLoadablePdf };
