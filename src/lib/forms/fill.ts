import { PDFDocument, StandardFonts, type PDFFont } from "@cantoo/pdf-lib";
import { isQuestionVisible, type AnswerMap, type StoredAnswer } from "../intake/flow";
import {
  loadAnswerRecords,
  type AnswerProvenance,
} from "../intake/store";
import { QUESTION_BY_ID } from "../intake/spec";
import { readVaultFields } from "../vault";
import { AppError, logInfo } from "../telemetry";
import { loadFormAnswers } from "./answers";
import { displayValueFor } from "./display";
import { assertLoadablePdf } from "./parse";
import type { FormRegistryEntry, FormRegistryField } from "./registry";

// Forms fill (Mission v2 M4 / HACK-74, BN-18): turn stored answers into a
// filled application PDF the person can review and submit THEMSELVES. The
// app never submits anything.
//
// Value sources, per registry field:
// - mapped to a spec question: the session's stored answer. Non-pii values
//   come from the answer table (loadAnswerRecords); pii values cross the
//   vault boundary ONLY via readVaultFields with the entry's committed
//   per-form fill allowlist — the forms module is the second sanctioned
//   accessor (VAL-PDF-006).
// - unmapped: the form-answer store (asked in the flow, saved per entry).
//
// Every filled field carries its provenance; fields with no answer stay
// VISIBLY BLANK and are listed as to-resolve; fields whose mapped question
// is skipped by the flow's conditional logic stay blank WITHOUT being
// to-resolve (not applicable — skip logic, BN-18).
//
// The PDF is generated in memory and returned as bytes. It is NEVER written
// to disk, a database, or a log here — filled PDFs are never persisted
// server-side (VAL-PDF-005), and no log line ever carries a value.

export const FLAT_TEXT_SIZE = 10;
const FLAT_MIN_SIZE = 6;

/** One field's fill value, display-ready, with where it came from. */
export interface FillValue {
  /** The value as it should appear on the form (choice labels, not ids). */
  readonly display: string;
  readonly provenance: AnswerProvenance;
  readonly source: "spec_answer" | "vault" | "form_answer";
}

export interface FilledField {
  readonly fieldName: string;
  readonly provenance: AnswerProvenance;
}

export type ToResolveReason = "unknown" | "unsupported_characters" | "option_missing";

export interface ToResolveItem {
  readonly fieldName: string;
  readonly question: string;
  readonly reason: ToResolveReason;
}

export interface FillOutcome {
  readonly bytes: Uint8Array;
  readonly filled: readonly FilledField[];
  readonly toResolve: readonly ToResolveItem[];
}

/** WinAnsi-safe text (StandardFonts are WinAnsi-only; no fontkit in the fork). */
function isWinAnsiSafe(text: string): boolean {
  return /^[\x20-\x7E\xA0-\xFF\t\n\r]*$/.test(text);
}

// ---------------------------------------------------------------------------
// Value collection — the vault crossing
// ---------------------------------------------------------------------------

/**
 * Assemble the fill values for one form from the session's stored answers.
 *
 * Vault crossing: every pii value is read through readVaultFields with the
 * entry's committed per-form allowlist as the explicit permit. A registry
 * entry that mapped a pii question missing from its allowlist can never see
 * that value — the field degrades to to-resolve instead (fail-closed).
 * Non-pii values come from the answer table; unmapped fields from the
 * form-answer store. No value or field id is logged.
 */
export async function collectFillValues(
  sessionId: string,
  entry: FormRegistryEntry,
): Promise<{
  values: Record<string, FillValue>;
  answerMap: AnswerMap;
}> {
  const records = await loadAnswerRecords(sessionId);
  const vaultValues = await readVaultFields(
    sessionId,
    entry.vaultFieldAllowlist,
    entry.vaultFieldAllowlist,
  );
  const formAnswers = await loadFormAnswers(sessionId, entry.id);

  // The skip-logic view of the session's answers: the answer table's rows
  // plus the vault values this form is sanctioned to read.
  const answerMap: Record<string, StoredAnswer> = {};
  for (const [questionId, record] of Object.entries(records)) {
    answerMap[questionId] = { status: record.status, value: record.value };
  }
  for (const [field, raw] of Object.entries(vaultValues)) {
    const stored = answerMap[field];
    const question = questionById(field);
    if (!question || !stored || stored.status === "unknown") {
      continue;
    }
    answerMap[field] = {
      status: stored.status,
      value: decodeVaultValue(question.id, raw),
    };
  }

  const values: Record<string, FillValue> = {};
  for (const field of entry.fields) {
    if (field.specQuestionId === null) {
      // Unmapped: the form-answer store is the only source.
      const formAnswer = formAnswers[field.name];
      if (formAnswer) {
        values[field.name] = {
          display: formAnswer.value,
          provenance: formAnswer.provenance,
          source: "form_answer",
        };
      }
      continue;
    }
    const record = records[field.specQuestionId];
    if (!record || record.status === "unknown") {
      continue; // blank + to-resolve (the fill decides below)
    }
    let raw: unknown;
    let source: FillValue["source"];
    if (isPiiQuestion(field.specQuestionId)) {
      const vaultRaw = vaultValues[field.specQuestionId];
      if (vaultRaw === undefined) {
        // Not on the allowlist (or nothing stored): fail closed.
        continue;
      }
      raw = decodeVaultValue(field.specQuestionId, vaultRaw);
      source = "vault";
    } else {
      raw = record.value;
      source = "spec_answer";
    }
    const display = displayValueFor(field, raw);
    if (display !== null) {
      values[field.name] = { display, provenance: record.provenance, source };
    }
  }
  return { values, answerMap };
}

function questionById(questionId: string) {
  return Object.hasOwn(QUESTION_BY_ID, questionId)
    ? QUESTION_BY_ID[questionId]
    : undefined;
}

function isPiiQuestion(questionId: string): boolean {
  return questionById(questionId)?.pii === true;
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
  const filled: FilledField[] = [];
  const toResolve: ToResolveItem[] = [];
  const skipped = skippedFieldNames(entry, answerMap);

  if (entry.kind === "acroform") {
    await fillAcroForm(pdf, entry, values, skipped, filled, toResolve);
  } else {
    await fillFlat(pdf, entry, values, skipped, filled, toResolve);
  }

  logInfo("form_fill_completed", {
    filledCount: filled.length,
    toResolveCount: toResolve.length,
  });
  return { bytes: await pdf.save(), filled, toResolve };
}

function pushToResolve(
  field: FormRegistryField,
  reason: ToResolveReason,
  toResolve: ToResolveItem[],
): void {
  toResolve.push({
    fieldName: field.name,
    question: field.question,
    reason,
  });
}

async function fillAcroForm(
  pdf: PDFDocument,
  entry: FormRegistryEntry,
  values: Readonly<Record<string, FillValue>>,
  skipped: ReadonlySet<string>,
  filled: FilledField[],
  toResolve: ToResolveItem[],
): Promise<void> {
  const form = pdf.getForm();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const field of entry.fields) {
    if (skipped.has(field.name)) {
      continue; // not applicable by the flow's conditional logic
    }
    const value = values[field.name];
    if (!value) {
      pushToResolve(field, "unknown", toResolve);
      continue;
    }
    try {
      switch (field.type) {
        case "checkbox": {
          const checkbox = form.getCheckBox(field.name);
          if (value.display === "checked") {
            checkbox.check();
          } else {
            checkbox.uncheck();
          }
          break;
        }
        case "dropdown": {
          const dropdown = form.getDropdown(field.name);
          if (!dropdown.getOptions().includes(value.display)) {
            pushToResolve(field, "option_missing", toResolve);
            continue;
          }
          dropdown.select(value.display);
          break;
        }
        default: {
          if (!isWinAnsiSafe(value.display)) {
            pushToResolve(field, "unsupported_characters", toResolve);
            continue;
          }
          form.getTextField(field.name).setText(value.display);
        }
      }
      filled.push({ fieldName: field.name, provenance: value.provenance });
    } catch (error) {
      // A field that will not take the value degrades to to-resolve —
      // never a stack trace and never a lie about what was filled.
      pushToResolve(field, "unsupported_characters", toResolve);
      logInfo("form_field_fill_degraded", {
        reason: error instanceof AppError ? error.code : "field_error",
      });
    }
  }
  // Some viewers show blank fields until the appearance streams are
  // regenerated — always before save (library/forms.md).
  form.updateFieldAppearances(font);
}

async function fillFlat(
  pdf: PDFDocument,
  entry: FormRegistryEntry,
  values: Readonly<Record<string, FillValue>>,
  skipped: ReadonlySet<string>,
  filled: FilledField[],
  toResolve: ToResolveItem[],
): Promise<void> {
  const pages = pdf.getPages();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const field of entry.fields) {
    if (skipped.has(field.name)) {
      continue; // not applicable by the flow's conditional logic
    }
    const box = field.answerBox;
    const value = values[field.name];
    if (!box || !value) {
      if (!value) {
        pushToResolve(field, "unknown", toResolve);
      }
      continue;
    }
    const page = pages[box.page - 1];
    if (!page) {
      pushToResolve(field, "unknown", toResolve);
      continue;
    }
    if (field.type === "checkbox") {
      // Flat checkboxes: a checked box draws an X in the box; unchecked
      // stays visibly blank.
      if (value.display === "checked") {
        page.drawText("X", { x: box.x, y: box.y, font, size: FLAT_TEXT_SIZE });
        filled.push({ fieldName: field.name, provenance: value.provenance });
      }
      continue;
    }
    if (!isWinAnsiSafe(value.display)) {
      pushToResolve(field, "unsupported_characters", toResolve);
      continue;
    }
    const size = shrinkToFit(font, value.display, box.maxWidth);
    page.drawText(value.display, { x: box.x, y: box.y, font, size });
    filled.push({ fieldName: field.name, provenance: value.provenance });
  }
}

/** Largest size ≤ FLAT_TEXT_SIZE whose text fits the box width. */
function shrinkToFit(
  font: PDFFont,
  text: string,
  maxWidth: number | undefined,
): number {
  let size = FLAT_TEXT_SIZE;
  if (maxWidth === undefined) {
    return size;
  }
  while (size > FLAT_MIN_SIZE && font.widthOfTextAtSize(text, size) > maxWidth) {
    size -= 0.5;
  }
  return size;
}

/**
 * Skip-logic pass (BN-18 conditional fields): given the session's answer
 * map, which mapped fields are NOT applicable — blank by design, never
 * to-resolve. Unmapped fields have no spec question and are never skipped.
 */
export function skippedFieldNames(
  entry: FormRegistryEntry,
  answerMap: AnswerMap,
): Set<string> {
  const skipped = new Set<string>();
  for (const field of entry.fields) {
    if (field.specQuestionId === null) {
      continue;
    }
    const question = questionById(field.specQuestionId);
    if (question && !isQuestionVisible(question, answerMap)) {
      skipped.add(field.name);
    }
  }
  return skipped;
}

/**
 * Full fill for one session: collect values (the vault crossing) → fill →
 * skip-logic-aware to-resolve list. The route calls this; the halves are
 * separate so tests can exercise them independently.
 */
export async function fillForSession(
  templateBytes: Uint8Array,
  entry: FormRegistryEntry,
  sessionId: string,
): Promise<FillOutcome> {
  const { values, answerMap } = await collectFillValues(sessionId, entry);
  return fillFormPdf(templateBytes, entry, values, answerMap);
}

// Re-export for the route: the shared load/rejection gate (XFA, encrypted,
// corrupt — VAL-PDF-004).
export { assertLoadablePdf };
