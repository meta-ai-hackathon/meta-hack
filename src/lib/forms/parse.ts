import {
  PDFCheckBox,
  PDFDict,
  PDFDocument,
  PDFDropdown,
  type PDFField,
  PDFOptionList,
  PDFName,
  PDFRadioGroup,
  PDFTextField,
} from "@cantoo/pdf-lib";
import { chatCompletion, type ChatMessage } from "../model";
import { AppError, logInfo, logWarn } from "../telemetry";
import { QUESTIONS } from "../intake/spec";

// Forms parser (Mission v2 M4 / HACK-74, BN-18): turn an application PDF
// into structured, reviewable data. Three stages:
//
// 1. DISCOVERY — AcroForm fields (name, kind, page, rect) via @cantoo/pdf-lib.
// 2. LABELS — page text via pdfjs-dist, matched to each field by proximity
//    (labels are page text, not field metadata).
// 3. MAPPING — an LLM-assisted pass turns (field name, kind, nearby label)
//    into a plain-language question and, when confident, a question-spec id
//    the field pre-fills from. The output is a PROPOSAL for a form-registry
//    entry: a person reviews it before it is committed (the registry, not
//    this pass, drives the fill).
//
// The mapping degrades honestly: a model failure yields label-verbatim
// questions and no spec mapping, never a fabricated guess.

export const MAPPING_MAX_TOKENS = 2048;

export type DiscoveredFieldKind =
  | "text"
  | "checkbox"
  | "dropdown"
  | "radio"
  | "optionlist";

export interface FieldRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface DiscoveredField {
  readonly name: string;
  readonly kind: DiscoveredFieldKind;
  /** 1-based page number. */
  readonly page: number;
  readonly rect: FieldRect;
}

export interface FieldMapping {
  readonly fieldName: string;
  /** Plain-language question for the flow (reviewed before commit). */
  readonly question: string;
  /** Spec question id to pre-fill from, or null when unmapped. */
  readonly specQuestionId: string | null;
  readonly piiLikely: boolean;
}

export interface ParsedForm {
  readonly fields: readonly DiscoveredField[];
  /** Extracted nearby label text per field name (verbatim from the page). */
  readonly labels: Readonly<Record<string, string>>;
  readonly mapping: readonly FieldMapping[];
}

// ---------------------------------------------------------------------------
// Loading + rejection checks (shared with the fill path)
// ---------------------------------------------------------------------------

/**
 * Load a PDF and reject the input classes the pipeline cannot fill honestly:
 * XFA (the AcroForm is replaced by an XML form pdf-lib cannot write) and
 * password-encrypted files. Both reject with the taxonomy validation_error
 * and person-readable copy — never a stack trace or a partial fill
 * (VAL-PDF-004).
 */
export async function assertLoadablePdf(bytes: Uint8Array): Promise<PDFDocument> {
  let pdf: PDFDocument;
  try {
    // Encrypted files load only with the flag set; the isEncrypted check
    // below rejects them, so the flag never reaches a decrypt attempt.
    // preserveXFA keeps the XFA evidence in place — the fork strips it at
    // getForm() time otherwise, and the XFA check must see it to reject.
    pdf = await PDFDocument.load(bytes, {
      ignoreEncryption: true,
      preserveXFA: true,
    });
  } catch {
    throw new AppError(
      "validation_error",
      "That file doesn't look like a PDF we can read. Try downloading the application form again.",
    );
  }
  if (pdf.isEncrypted) {
    throw new AppError(
      "validation_error",
      "This application PDF is password-protected, so we can't fill it. A password-free copy of the form can be filled instead.",
    );
  }
  // XFA lives in the document catalog in some writers and under the AcroForm
  // dictionary in others — check both before declaring the form fillable.
  const catalogXfa = pdf.catalog.get(PDFName.of("XFA"));
  let acroformXfa: unknown;
  try {
    const acroformRef = pdf.catalog.get(PDFName.of("AcroForm"));
    if (acroformRef) {
      const acroform = pdf.context.lookupMaybe(acroformRef, PDFDict);
      acroformXfa = acroform?.get(PDFName.of("XFA"));
    }
  } catch {
    acroformXfa = undefined;
  }
  if (catalogXfa !== undefined || acroformXfa !== undefined) {
    throw new AppError(
      "validation_error",
      "This application PDF uses a form technology (XFA) we can't fill. We'll need a different copy of the form.",
    );
  }
  return pdf;
}

// ---------------------------------------------------------------------------
// Stage 1: AcroForm discovery
// ---------------------------------------------------------------------------

/** Discover every AcroForm field with its name, kind, page, and rectangle. */
export function discoverAcroFormFields(pdf: PDFDocument): DiscoveredField[] {
  const pages = pdf.getPages();
  const discovered: DiscoveredField[] = [];
  for (const field of pdf.getForm().getFields()) {
    const kind = fieldKindOf(field);
    if (!kind) {
      continue;
    }
    const widgets = field.acroField.getWidgets();
    for (const widget of widgets) {
      const rect = widget.getRectangle();
      const pageIndex = pages.findIndex((page) => page.ref === widget.P());
      discovered.push({
        name: field.getName(),
        kind,
        page: pageIndex + 1,
        rect: {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        },
      });
    }
  }
  return discovered;
}

function fieldKindOf(field: PDFField): DiscoveredFieldKind | null {
  if (field instanceof PDFTextField) {
    return "text";
  }
  if (field instanceof PDFCheckBox) {
    return "checkbox";
  }
  if (field instanceof PDFDropdown) {
    return "dropdown";
  }
  if (field instanceof PDFRadioGroup) {
    return "radio";
  }
  if (field instanceof PDFOptionList) {
    return "optionlist";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Stage 2: label extraction (pdfjs text items + proximity matching)
// ---------------------------------------------------------------------------

interface TextBox {
  readonly text: string;
  /** Baseline-left corner (PDF coordinates, origin bottom-left). */
  readonly x: number;
  /** Baseline y. */
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

// Minimal structural typing for the pdfjs surface this module uses; the
// package's own types vary between major versions and we need exactly one
// call: page.getTextContent().
interface PdfJsTextItem {
  readonly str: string;
  readonly transform: readonly number[];
  readonly width: number;
  readonly height: number;
}

interface PdfJsPageProxy {
  readonly getTextContent: () => Promise<{ items: PdfJsTextItem[] }>;
}

interface PdfJsDocumentProxy {
  readonly numPages: number;
  readonly getPage: (pageNumber: number) => Promise<PdfJsPageProxy>;
}

interface PdfJsLoadingTask {
  readonly promise: Promise<PdfJsDocumentProxy>;
  readonly destroy?: () => Promise<void>;
}

interface PdfJsModule {
  readonly getDocument: (params: {
    data: Uint8Array;
    isEvalSupported: boolean;
  }) => PdfJsLoadingTask;
}

async function pdfjsModule(): Promise<PdfJsModule> {
  return (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as PdfJsModule;
}

/** Baseline-anchored box of one text item. */
function itemBox(item: PdfJsTextItem): TextBox {
  const transform = item.transform;
  return {
    text: item.str,
    x: transform[4],
    y: transform[5],
    width: item.width,
    height: item.height,
  };
}

/**
 * Merge text items on the same baseline that sit close together into one
 * box: pdfjs splits sentences into several items, and labels match better
 * as whole lines.
 */
function mergeIntoLines(boxes: readonly TextBox[]): TextBox[] {
  const sorted = [...boxes].sort((a, b) => a.y - b.y || a.x - b.x);
  const lines: TextBox[] = [];
  for (const box of sorted) {
    const line = lines.find(
      (candidate) =>
        Math.abs(candidate.y - box.y) <= 2 &&
        box.x >= candidate.x + candidate.width - 6 &&
        box.x - (candidate.x + candidate.width) <= 14,
    );
    if (line) {
      const right = Math.max(line.x + line.width, box.x + box.width);
      lines.splice(lines.indexOf(line), 1, {
        text: `${line.text} ${box.text}`.replace(/\s+/g, " ").trim(),
        x: Math.min(line.x, box.x),
        y: Math.max(line.y, box.y),
        width: right - Math.min(line.x, box.x),
        height: Math.max(line.height, box.height),
      });
    } else {
      lines.push({ ...box });
    }
  }
  return lines;
}

function rectsOverlap(
  a: FieldRect,
  page: number,
  b: TextBox,
  bPage: number,
): boolean {
  return (
    page === bPage &&
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

/**
 * Distance from a label line to a field rect; lower is a better match.
 * Two label positions are recognized:
 * - ABOVE the box, overlapping its column (distance = vertical gap);
 * - on the same visual row, ending just LEFT of the box (vertical gap plus
 *   a damped horizontal term, so a near-left label beats a far-above one).
 */
function labelDistance(line: TextBox, field: DiscoveredField): number | null {
  const rectTop = field.rect.y + field.rect.height;
  const rectRight = field.rect.x + field.rect.width;
  const lineRight = line.x + line.width;
  const dy = line.y - rectTop;
  if (dy < -2 || dy > 96) {
    return null;
  }
  const overlapsColumn = line.x <= rectRight && lineRight >= field.rect.x - 8;
  if (overlapsColumn) {
    return dy;
  }
  // Same row, entirely left of the box: the classic side label.
  if (lineRight <= field.rect.x + 8 && dy <= 24) {
    return dy + (field.rect.x - lineRight) * 0.25;
  }
  return null;
}

/**
 * Extract the label text for every field: the nearest merged text line
 * above (or ending just left of) each field's rectangle, excluding text
 * that lives inside a widget (dropdown option labels render there).
 */
export async function extractFieldLabels(
  bytes: Uint8Array,
  fields: readonly DiscoveredField[],
): Promise<Record<string, string>> {
  const labels: Record<string, string> = {};
  if (fields.length === 0) {
    return labels;
  }
  const pdfjs = await pdfjsModule();
  const task = pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false });
  const doc = await task.promise;
  try {
    const linesByPage = new Map<number, TextBox[]>();
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      const boxes = content.items
        .filter((item) => item.str.trim() !== "")
        .map(itemBox);
      linesByPage.set(pageNumber, mergeIntoLines(boxes));
    }
    for (const field of fields) {
      const pageLines = linesByPage.get(field.page) ?? [];
      const candidates = pageLines
        .filter((line) => line.text.trim() !== "")
        // Widget-rendered text (e.g. a dropdown's own option list) is not a label.
        .filter((line) => !rectsOverlap(field.rect, field.page, line, field.page));
      let best: { line: TextBox; distance: number } | null = null;
      for (const line of candidates) {
        const distance = labelDistance(line, field);
        if (distance !== null && (best === null || distance < best.distance)) {
          best = { line, distance };
        }
      }
      labels[field.name] = best ? best.line.text : field.name;
    }
  } finally {
    // Optional on the legacy build; skip silently when absent.
    await task.destroy?.();
  }
  return labels;
}

// ---------------------------------------------------------------------------
// Stage 3: LLM-assisted mapping (scriptable via the model transport)
// ---------------------------------------------------------------------------

const MAPPING_SYSTEM_PROMPT = [
  "You map PDF form fields to plain-language questions for a benefits-application helper.",
  "You receive the app's question spec (id, prompt, and whether it is private) and a list of form fields",
  "(name, kind, nearby label text). Return STRICT JSON only, no prose, in this shape:",
  '{"mappings":[{"fieldName":"<a field name>","question":"<short plain-language question>",',
  '"specQuestionId":"<a spec id or null>","piiLikely":true}]}',
  "Rules: question must be phrased so a person can answer it out loud in one sentence.",
  "specQuestionId must be either null or an id copied EXACTLY from the spec list; map a field to a spec id",
  "only when the label or name clearly asks the same thing.",
  "piiLikely is true when the answer looks like identity data (full names, birth dates, contact details,",
  "case or ID numbers, anywhere-people-live details). Never invent ids or fields.",
].join(" ");

/** The data the mapping call sees (form text + the spec — never person data). */
export interface MappingInput {
  readonly fields: readonly {
    readonly name: string;
    readonly kind: string;
    readonly label: string;
  }[];
}

interface RawMapping {
  readonly fieldName: unknown;
  readonly question: unknown;
  readonly specQuestionId: unknown;
  readonly piiLikely: unknown;
}

const MAX_QUESTION_LENGTH = 200;

/**
 * The LLM-assisted mapping pass: (field name, kind, nearby label) →
 * plain-language question + optional spec id + pii-likelihood. Any model
 * failure degrades honestly: every field falls back to its label text with
 * no spec mapping (a human reviews the proposal before it is committed).
 */
export async function mapFieldsToQuestions(
  fields: readonly DiscoveredField[],
  labels: Readonly<Record<string, string>>,
): Promise<readonly FieldMapping[]> {
  if (fields.length === 0) {
    return [];
  }
  try {
    const specList = QUESTIONS.map((question) => ({
      id: question.id,
      prompt: question.prompt,
      pii: question.pii,
    }));
    const fieldList = fields.map((field) => ({
      name: field.name,
      kind: field.kind,
      label: labels[field.name] ?? field.name,
    }));
    const messages: ChatMessage[] = [
      { role: "system", content: MAPPING_SYSTEM_PROMPT },
      {
        role: "user",
        content: JSON.stringify({ specQuestions: specList, fields: fieldList }),
      },
    ];
    const result = await chatCompletion(messages, {
      maxTokens: MAPPING_MAX_TOKENS,
    });
    const raw = parseMappingResponse(result.content, fields);
    return fields.map((field) => {
      const proposed = raw.get(field.name);
      if (proposed) {
        return proposed;
      }
      return fallbackMapping(field, labels[field.name]);
    });
  } catch (error) {
    logWarn("form_mapping_degraded", {
      reason: error instanceof AppError ? error.code : "invalid_response",
    });
    return fields.map((field) => fallbackMapping(field, labels[field.name]));
  }
}

/** Parse + validate the model's JSON against the discovered fields. */
function parseMappingResponse(
  content: string,
  fields: readonly DiscoveredField[],
): Map<string, FieldMapping> {
  const parsed: unknown = JSON.parse(stripCodeFences(content));
  const mappings = (parsed as { mappings?: unknown[] }).mappings;
  if (!Array.isArray(mappings)) {
    throw new AppError("internal", "Mapping response was not the expected shape.");
  }
  const knownIds = new Set(QUESTIONS.map((question) => question.id));
  const byName = new Map<string, FieldMapping>();
  for (const item of mappings) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const raw = item as RawMapping;
    if (typeof raw.fieldName !== "string") {
      continue;
    }
    if (!fields.some((field) => field.name === raw.fieldName)) {
      continue;
    }
    if (typeof raw.question !== "string" || raw.question.trim() === "") {
      continue;
    }
    const question = raw.question.trim().slice(0, MAX_QUESTION_LENGTH);
    const specQuestionId =
      typeof raw.specQuestionId === "string" && knownIds.has(raw.specQuestionId)
        ? raw.specQuestionId
        : null;
    if (byName.has(raw.fieldName)) {
      continue;
    }
    byName.set(raw.fieldName, {
      fieldName: raw.fieldName,
      question,
      specQuestionId,
      piiLikely: raw.piiLikely === true,
    });
  }
  return byName;
}

function stripCodeFences(content: string): string {
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json)?\n([\s\S]*?)\n```$/);
  return fenced ? fenced[1] : trimmed;
}

/**
 * The honest no-model fallback: ask the label verbatim (or a humanized field
 * name when no label was found) and map nothing to the spec — the proposal
 * stays reviewable and never guesses.
 */
function fallbackMapping(
  field: DiscoveredField,
  label: string | undefined,
): FieldMapping {
  const text = (label ?? "").trim();
  const question = text !== "" ? text : humanizeFieldName(field.name);
  return {
    fieldName: field.name,
    question: question.slice(0, MAX_QUESTION_LENGTH),
    specQuestionId: null,
    piiLikely: false,
  };
}

function humanizeFieldName(name: string): string {
  return name
    .replace(/[_\-.]+/g, " ")
    .replace(/\d+/g, "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .join(" ") || name;
}

// ---------------------------------------------------------------------------
// The full parse
// ---------------------------------------------------------------------------

/**
 * Parse an application PDF end to end: discovery → labels → LLM-assisted
 * mapping proposal. The caller (the registry tooling) reviews the proposal
 * and commits it as a form-registry entry; nothing here writes to disk.
 */
export async function parseFormPdf(
  bytes: Uint8Array,
): Promise<ParsedForm> {
  const pdf = await assertLoadablePdf(bytes);
  const fields = discoverAcroFormFields(pdf);
  logInfo("form_parse_discovered", { fieldCount: fields.length });
  const labels = await extractFieldLabels(bytes, fields);
  const mapping = await mapFieldsToQuestions(fields, labels);
  return { fields, labels, mapping };
}
