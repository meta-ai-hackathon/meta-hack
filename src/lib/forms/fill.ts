import { PDFDocument, StandardFonts, type PDFFont } from "@cantoo/pdf-lib";
import { isQuestionVisible, type AnswerMap, type StoredAnswer } from "../intake/flow";
import {
  loadAnswerRecords,
  type AnswerProvenance,
} from "../intake/store";
import { QUESTION_BY_ID } from "../intake/spec";
import { readVaultFieldsForFill } from "../vault";
import { AppError, logInfo } from "../telemetry";
import { displayValueFor } from "./display";
import { assertLoadablePdf } from "./parse";
import type {
  ConflictGroupKind,
  FormRegistryEntry,
  FormRegistryField,
} from "./registry";

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

export const FLAT_TEXT_SIZE = 10;
const FLAT_MIN_SIZE = 6;

/** One field's fill value, display-ready, with where it came from. */
export interface FillValue {
  /** The value as it should appear on the form (choice labels, not ids). */
  readonly display: string;
  readonly provenance: AnswerProvenance;
  readonly source: "spec_answer" | "vault" | "in_request";
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
  /**
   * The fill-time consistency check's flags (full-form proof, VAL-FIX-007):
   * mapped Yes/No checkbox pairs and check-one groups where the value set
   * checks two or more members of one group. The fill NEVER silently picks
   * a side — what the person asked checked is what the form prints — and
   * the flag reaches the person the way every still-needed item does: the
   * packet cover's missing rows (provenanceFromFill) and the fill logs
   * (counts only, no values).
   */
  readonly conflicts: readonly FillConflict[];
}

/** One flagged conflict: a check group with two or more members checked. */
export interface FillConflict {
  readonly kind: ConflictGroupKind;
  /** The flagged question (the first checked member's plain-language question). */
  readonly question: string;
  /** The checked members' field names, in registry order. */
  readonly fields: readonly string[];
}

/** WinAnsi-safe text (StandardFonts are WinAnsi-only; no fontkit in the fork). */
function isWinAnsiSafe(text: string): boolean {
  return /^[\x20-\x7E\xA0-\xFF\t\n\r]*$/.test(text);
}

// ---------------------------------------------------------------------------
// Value collection — the vault crossing
// ---------------------------------------------------------------------------

/** Bound for one in-request form answer (the review view's text inputs). */
export const MAX_FORM_ANSWER_LENGTH = 200;
/**
 * Bound for how many in-request form answers one fill may carry.
 *
 * Full-form mapping (VAL-FIX-007, owner decision "map every answerable
 * field across all 21 pages"): the person's review-and-complete step at
 * fill time is the answer carrier for every mapped field the interview
 * doesn't collect — 350 of the template's 571 named fields (355 mapped in
 * total; 614 is the widget-rectangle count the discovery pass walks),
 * roughly seven times this cap's original 50. The bound covers every
 * field the committed template has with headroom; the pinned boundary
 * lives in fill.test.ts.
 */
export const MAX_FORM_VALUES = 650;

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
  if (raw === null || raw === undefined) {
    return {};
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new AppError("validation_error", "We couldn't use those form answers.");
  }
  const unmapped = new Set(
    entry.fields.filter((f) => f.specQuestionId === null).map((f) => f.name),
  );
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!unmapped.has(name)) {
      throw new AppError("validation_error", "We couldn't use those form answers.");
    }
    if (typeof value !== "string") {
      throw new AppError("validation_error", "We couldn't use those form answers.");
    }
    const trimmed = value.trim();
    if (trimmed === "" || trimmed.length > MAX_FORM_ANSWER_LENGTH) {
      throw new AppError("validation_error", "We couldn't use those form answers.");
    }
    out[name] = trimmed;
  }
  if (Object.keys(out).length > MAX_FORM_VALUES) {
    throw new AppError("validation_error", "We couldn't use those form answers.");
  }
  return out;
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
      // Unmapped: the in-request values are the only source — they ride
      // the fill request and live only in memory.
      const raw = formValues[field.name];
      if (raw !== undefined) {
        values[field.name] = {
          display: raw,
          provenance: "user_supplied",
          source: "in_request",
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
 * the explicit to-resolve list, and the conflict flags from the fill-time
 * consistency check. Unknown fields are visibly blank.
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
  const conflicts = detectCheckConflicts(entry, values, skipped);

  if (entry.kind === "acroform") {
    await fillAcroForm(pdf, entry, values, skipped, filled, toResolve);
  } else {
    await fillFlat(pdf, entry, values, skipped, filled, toResolve);
  }

  logInfo("form_fill_completed", {
    filledCount: filled.length,
    toResolveCount: toResolve.length,
    conflictCount: conflicts.length,
  });
  return { bytes: await pdf.save(), filled, toResolve, conflicts };
}

/**
 * The fill-time consistency check (full-form proof, VAL-FIX-007 — the
 * part-3 claude-review finding): the form's Yes/No questions and check-one
 * elections are INDEPENDENT checkbox widgets — nothing in the AcroForm
 * structure stops a value set checking both sides of a pair (e.g. the
 * foster-care pair, the help-paying pair) or two terms of the renewal
 * election. For every registry-declared conflict group, this flags when
 * two or more of its mapped checkbox members would print checked.
 *
 * The flag is all the check does: the fill renders the person's answers
 * exactly as sent (never silently picks a side, never drops one) and the
 * person resolves the contradiction before submitting.
 */
export function detectCheckConflicts(
  entry: FormRegistryEntry,
  values: Readonly<Record<string, FillValue>>,
  skipped: ReadonlySet<string> = new Set(),
): FillConflict[] {
  const groups = new Map<
    string,
    { kind: ConflictGroupKind; question: string; fields: string[] }
  >();
  for (const field of entry.fields) {
    const group = field.conflictGroup;
    // Only mapped checkboxes carry a checked state a conflict could
    // contradict; a skipped member (not applicable by the flow's
    // conditional logic) fills blank and joins no flag.
    if (!group || field.disposition !== "mapped" || field.type !== "checkbox") {
      continue;
    }
    if (skipped.has(field.name)) {
      continue;
    }
    if (values[field.name]?.display !== "checked") {
      continue;
    }
    const existing = groups.get(group.id);
    if (existing) {
      existing.fields.push(field.name);
    } else {
      groups.set(group.id, {
        kind: group.kind,
        question: field.question,
        fields: [field.name],
      });
    }
  }
  return [...groups.values()]
    .filter((group) => group.fields.length >= 2)
    .map(({ kind, question, fields }) => ({
      kind,
      question,
      fields: [...fields],
    }));
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
    if (field.disposition !== "mapped") {
      // A reviewed non-mapped disposition (not-collected / optional /
      // agency-use / structural) stays blank by documentation: never
      // filled, never to-resolve — even if a caller sends a value for it.
      continue;
    }
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
        case "radio": {
          const group = form.getRadioGroup(field.name);
          const exports = field.exportValues;
          if (
            !exports ||
            (value.display !== "checked" && value.display !== "unchecked")
          ) {
            // Without the pair's discovered export values (or with a
            // non-boolean display) the fill refuses to guess a side.
            pushToResolve(field, "option_missing", toResolve);
            continue;
          }
          group.select(value.display === "checked" ? exports.yes : exports.no);
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
    if (field.disposition !== "mapped") {
      // Dispositioned fields stay blank by documentation (see fillAcroForm).
      continue;
    }
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
