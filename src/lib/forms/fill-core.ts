import type { PDFDocument, PDFFont } from "@cantoo/pdf-lib";
import type { AnswerStatus } from "../honesty";
import { isQuestionVisible, type AnswerMap, type StoredAnswer } from "../intake/flow";
import type { AnswerProvenance } from "../intake/store";
import { QUESTION_BY_ID } from "../intake/spec";
import { displayValueFor } from "./display";
import type {
  ConflictGroupKind,
  FormRegistryEntry,
  FormRegistryField,
} from "./registry-core";

// The browser-safe half of the forms fill (HACK-115): turning answers into
// field values and drawing them onto a loaded application PDF. Everything
// here is a pure function of its inputs plus pdf-lib. It never reads a
// store, the vault, the filesystem, or telemetry, so the step-by-step page
// fills the form in the browser from the answers sealed on the device, and
// no answer leaves it.
//
// fill.ts re-exports these names unchanged and keeps the server-only half:
// reading the session's answers and its vault values, the template load
// gate, and the log lines. Both halves run the same value assembly and the
// same fill, so a form filled on the device matches the server's fill of
// the same answers field for field (property-proven in
// src/lib/intake/device-form.test.ts).
//
// Every filled field carries its provenance; fields with no answer stay
// VISIBLY BLANK and are listed as to-resolve; fields whose mapped question
// is skipped by the flow's conditional logic stay blank WITHOUT being
// to-resolve (not applicable — skip logic, BN-18).

export const FLAT_TEXT_SIZE = 10;
const FLAT_MIN_SIZE = 6;

/**
 * The font fills are drawn in: pdf-lib's standard Helvetica, given by its
 * name (StandardFonts.Helvetica's value, pinned equal in fill-core.test.ts).
 * This module needs only pdf-lib's types, so a page that imports it loads
 * pdf-lib itself only when it actually opens a form to fill.
 */
export const FILL_FONT = "Helvetica";

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
   * (counts only, no values). On the device, the end of /intake lists them
   * after the download.
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

function questionById(questionId: string) {
  return Object.hasOwn(QUESTION_BY_ID, questionId)
    ? QUESTION_BY_ID[questionId]
    : undefined;
}

function isPiiQuestion(questionId: string): boolean {
  return questionById(questionId)?.pii === true;
}

// ---------------------------------------------------------------------------
// In-request form values (the unmapped fields)
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
 * The answers to a form's UNMAPPED fields, checked: keys must be unmapped
 * fields of the entry (spec-mapped fields never come this way — their
 * answers live in the ordinary intake stores), values bounded non-empty
 * text. Returns a plain record of the trimmed values, an empty one for no
 * values, or null when anything is off. These answers are never stored:
 * they live only in memory for the one fill.
 */
export function checkedFormValues(
  entry: FormRegistryEntry,
  raw: unknown,
): Record<string, string> | null {
  if (raw === null || raw === undefined) {
    return {};
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const unmapped = new Set(
    entry.fields.filter((f) => f.specQuestionId === null).map((f) => f.name),
  );
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!unmapped.has(name)) {
      return null;
    }
    if (typeof value !== "string") {
      return null;
    }
    const trimmed = value.trim();
    if (trimmed === "" || trimmed.length > MAX_FORM_ANSWER_LENGTH) {
      return null;
    }
    out[name] = trimmed;
  }
  if (Object.keys(out).length > MAX_FORM_VALUES) {
    return null;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Value assembly
// ---------------------------------------------------------------------------

/** One stored answer as the fill reads it (the answer table's row shape). */
export interface FillAnswerRecord {
  readonly status: AnswerStatus;
  /** The stored value; null for pii questions, whose values come from the vault. */
  readonly value: unknown;
  readonly provenance: AnswerProvenance;
}

/**
 * Assemble the fill values for one form from the stored answers, the
 * private answers it may read, and the in-request form values (unmapped
 * fields).
 *
 * Only the entry's committed vault allowlist is read from `vaultValues`
 * (VAL-PDF-006): a private value the allowlist doesn't name never reaches
 * the form or the skip logic, whatever the caller passes. A field mapped
 * to a pii question without an allowed value degrades to to-resolve
 * instead (fail-closed). Vault values arrive decoded into the answer's own
 * shape.
 */
export function assembleFillValues(
  entry: FormRegistryEntry,
  records: Readonly<Record<string, FillAnswerRecord>>,
  vaultValues: Readonly<Record<string, unknown>>,
  formValues: Readonly<Record<string, string>> = {},
): {
  values: Record<string, FillValue>;
  answerMap: AnswerMap;
} {
  const allowed: Record<string, unknown> = {};
  for (const field of entry.vaultFieldAllowlist) {
    if (Object.hasOwn(vaultValues, field)) {
      allowed[field] = vaultValues[field];
    }
  }

  // The skip-logic view of the answers: the stored rows plus the private
  // values this form is sanctioned to read.
  const answerMap: Record<string, StoredAnswer> = {};
  for (const [questionId, record] of Object.entries(records)) {
    answerMap[questionId] = { status: record.status, value: record.value };
  }
  for (const [field, value] of Object.entries(allowed)) {
    const stored = answerMap[field];
    const question = questionById(field);
    if (!question || !stored || stored.status === "unknown") {
      continue;
    }
    answerMap[field] = { status: stored.status, value };
  }

  const values: Record<string, FillValue> = {};
  for (const field of entry.fields) {
    if (field.specQuestionId === null) {
      // Unmapped: the in-request values are the only source — they live
      // only in memory for this fill.
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
      if (!Object.hasOwn(allowed, field.specQuestionId)) {
        // Not on the allowlist (or nothing stored): fail closed.
        continue;
      }
      raw = allowed[field.specQuestionId];
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

// ---------------------------------------------------------------------------
// The fill itself
// ---------------------------------------------------------------------------

/** What the fill reports as it goes. The browser passes none: it logs nothing. */
export interface FillHooks {
  /** A field refused its value and was listed to-resolve instead. */
  readonly onFieldDegraded?: (error: unknown) => void;
}

/**
 * Fill an already loaded template per the registry entry, in place, and
 * return the per-field provenance of everything filled, the explicit
 * to-resolve list, and the conflict flags from the fill-time consistency
 * check. Unknown fields are visibly blank; fields the flow's skip logic
 * leaves out (given `answerMap`) are blank and not to-resolve; fields with
 * a reviewed non-mapped disposition stay blank and are neither.
 * Saving the document is the caller's step.
 */
export async function fillLoadedPdf(
  pdf: PDFDocument,
  entry: FormRegistryEntry,
  values: Readonly<Record<string, FillValue>>,
  answerMap: AnswerMap = {},
  hooks: FillHooks = {},
): Promise<{ filled: FilledField[]; toResolve: ToResolveItem[]; conflicts: FillConflict[] }> {
  const filled: FilledField[] = [];
  const toResolve: ToResolveItem[] = [];
  const skipped = skippedFieldNames(entry, answerMap);
  const conflicts = detectCheckConflicts(entry, values, skipped);

  if (entry.kind === "acroform") {
    await fillAcroForm(pdf, entry, values, skipped, filled, toResolve, hooks);
  } else {
    await fillFlat(pdf, entry, values, skipped, filled, toResolve);
  }
  return { filled, toResolve, conflicts };
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
  hooks: FillHooks,
): Promise<void> {
  const form = pdf.getForm();
  const font = await pdf.embedFont(FILL_FONT);
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
      hooks.onFieldDegraded?.(error);
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
  const font = await pdf.embedFont(FILL_FONT);
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
 * Skip-logic pass (BN-18 conditional fields): given the answer map, which
 * mapped fields are NOT applicable — blank by design, never to-resolve.
 * Unmapped fields have no spec question and are never skipped.
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
