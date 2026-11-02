import {
  PDFCheckBox,
  PDFDocument,
  type PDFField,
  PDFTextField,
} from "@cantoo/pdf-lib";

// Deterministic, in-memory IRS Form 1040 parser (milestone income-capture,
// part 1; VAL-INC-004/005/009; HACK-86/92).
//
// WHAT IT IS: a pure function of PDF bytes → a typed result. It reads
// AcroForm field values (most tax software saves a fillable 1040 with the
// values still in the fields) and, when field values are absent (the return
// was flattened or printed), falls back to positional text-layer rules.
// It is the ONLY computation step for tax-return-derived figures: an LLM
// never computes, rounds, classifies, or estimates anything here — the
// import-boundary test (tax-parse-boundary.test.ts) proves the module (and
// everything it imports) cannot reach model/LLM code.
//
// PURITY CONTRACT: no persistence, no logging of values (or of anything
// else), no side effects, no network, no environment reads, no wall-clock
// or randomness — same bytes in, same result out, the caller's buffer is
// never mutated. The uploaded document never touches disk or storage: this
// module never writes anything, anywhere.
//
// THE PDF IS READ-ONLY: the committed fixture (fixtures/f1040.pdf, the real
// 2025 template from https://www.irs.gov/pub/irs-pdf/f1040.pdf, retrieved
// 2026-11-01) carries a hybrid-XFA entry. XFA matters only to fill/flatten
// pipelines (the forms pipeline rejects it, since it must WRITE); for
// read-only parsing the AcroForm side of a hybrid file is read normally and
// the XFA side is ignored — the file is never rewritten, so the entry is
// harmless here by construction.
//
// LAYOUT PINNING: the AcroForm field names and the positional-rect constants
// below were verified against the pinned 2025 fixture (field names by
// dump, rects by widget geometry vs. page text). The AcroForm mapping and
// the status/dependent rect rules apply ONLY when the document identifies
// as "Form 1040 (2025)" — an honest parser never guesses at a layout it
// hasn't pinned. The wage/AGI text rules key off the amount-column line
// markers ("1a", "11a") and are kept usable for other 1040 layouts that
// share that convention; every other year falls back honestly to typing.

// ---------------------------------------------------------------------------
// Public types and the one derived figure
// ---------------------------------------------------------------------------

export type TaxFilingStatus =
  | "single"
  | "married_filing_jointly"
  | "married_filing_separately"
  | "head_of_household"
  | "qualifying_surviving_spouse";

export type TaxFindingField =
  | "wages_line_1a"
  | "agi_line_11"
  | "filing_status"
  | "dependent_count";

export type TaxFindingOrigin = "acroform_field" | "text_layer";

export interface TaxFinding {
  readonly field: TaxFindingField;
  /** Dollars (amounts), the canonical status, or a row count. */
  readonly value: number | string;
  readonly origin: TaxFindingOrigin;
  /** 1 for an exact AcroForm field read; 0.9 for a positional text read. */
  readonly confidence: number;
}

export interface TaxParseResult {
  /** True only when the bytes identify as a readable Form 1040. */
  readonly readable: boolean;
  /** Canonical order: wages, AGI, filing status, dependent count. */
  readonly findings: readonly TaxFinding[];
  /**
   * The only derived figure: the annual AGI divided by 12 by the documented
   * deterministic rule (see deriveMonthlyFromAnnualAgi). Null when no AGI
   * was found — never guessed.
   */
  readonly monthlyDerived: number | null;
}

// Confidence is a documented, deterministic constant per origin — never a
// model score. An exact field read is certain; a positional text read sits
// just under it (right value, weaker evidence).
export const FIELD_READ_CONFIDENCE = 1;
export const TEXT_LAYER_CONFIDENCE = 0.9;

/**
 * The one derived figure, by DOCUMENTED DETERMINISTIC RULE (VAL-INC-009):
 * the monthly figure is the PRIOR-YEAR annual AGI divided by 12, rounded
 * to the nearest whole dollar with halves rounding up —
 * floor(annual / 12 + 0.5).
 *
 * Honesty framing (the person confirms or corrects every proposal before
 * anything is saved — parts 2-3 of the milestone): this is a proposal
 * derived from the PRIOR-YEAR return. AGI is net of adjustments, while
 * benefit screens typically use current gross monthly income, so the
 * derived figure is presented for confirmation, provenance-tagged
 * `tax_return`, never as a computed truth about current income.
 *
 * A negative or non-finite annual value yields null — an unknown, never a
 * confident 0 (a self-employment loss must not masquerade as a real zero
 * income). Pure and total: same input → same output, always.
 */
export function deriveMonthlyFromAnnualAgi(
  annualAgiDollars: number,
): number | null {
  if (!Number.isFinite(annualAgiDollars) || annualAgiDollars < 0) {
    return null;
  }
  return Math.floor(annualAgiDollars / 12 + 0.5);
}

const UNREADABLE: TaxParseResult = {
  readable: false,
  findings: [],
  monthlyDerived: null,
};

// ---------------------------------------------------------------------------
// Pinned 2025 layout (verified against the committed fixture bytes)
// ---------------------------------------------------------------------------

const FORM_2025 = {
  wages: "topmostSubform[0].Page1[0].f1_47[0]",
  agi: "topmostSubform[0].Page1[0].f1_75[0]",
  status: {
    single: "topmostSubform[0].Page1[0].Checkbox_ReadOrder[0].c1_8[0]",
    married_filing_jointly:
      "topmostSubform[0].Page1[0].Checkbox_ReadOrder[0].c1_8[1]",
    married_filing_separately:
      "topmostSubform[0].Page1[0].Checkbox_ReadOrder[0].c1_8[2]",
    head_of_household: "topmostSubform[0].Page1[0].c1_8[0]",
    qualifying_surviving_spouse: "topmostSubform[0].Page1[0].c1_8[1]",
  },
  // Four dependent rows × four columns (first name, last name, SSN,
  // relationship): f1_31..f1_46. Rows 5-7 of the table are credit
  // elections for >4 dependents and cannot raise the count.
  dependents: [0, 1, 2, 3].map((row) =>
    [0, 1, 2, 3].map(
      (column) =>
        `topmostSubform[0].Page1[0].Table_Dependents[0].Row${row + 1}[0].f1_${
          31 + row * 4 + column
        }[0]`,
    ),
  ),
} as const;

interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

// Widget rectangles from the pinned 2025 fixture, for positional text rules
// on flattened copies (where the fields are gone but the printed marks and
// values remain in the text layer at the same coordinates).
const LAYOUT_2025 = {
  statusBoxes: {
    single: { x: 97.6, y: 578, width: 8, height: 8 },
    married_filing_jointly: { x: 97.6, y: 566, width: 8, height: 8 },
    married_filing_separately: { x: 97.6, y: 554, width: 8, height: 8 },
    head_of_household: { x: 349.6, y: 578, width: 8, height: 8 },
    qualifying_surviving_spouse: { x: 349.6, y: 566, width: 8, height: 8 },
  } as Record<TaxFilingStatus, Rect>,
  dependentRows: [0, 1, 2, 3].map((row) => ({
    columns: [145, 253, 361, 469].map((x) => ({
      x,
      y: 471 - 12 * row,
      width: 106.3,
      height: 12,
    })),
  })),
} as const;

// The mark a checked box bakes into the text layer when a filled 1040 is
// flattened: the ZapfDingbats check glyph ("4" in that font) or a typed X.
const CHECK_GLYPHS = new Set(["4", "X", "x", "✓", "✔"]);

// ---------------------------------------------------------------------------
// pdfjs-dist (text layer) — minimal structural surface, as in forms/parse.ts
// ---------------------------------------------------------------------------

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
  readonly getPage: (pageNumber: number) => Promise<PdfJsPageProxy>;
}

interface PdfJsLoadingTask {
  readonly promise: Promise<PdfJsDocumentProxy>;
  readonly destroy?: () => Promise<void>;
}

interface PdfJsModule {
  readonly getDocument: (params: { data: Uint8Array }) => PdfJsLoadingTask;
}

/**
 * pdf.js's version-pinned signature of a broken worker environment: its
 * fake-worker loader (Node has no DOM worker) rejects the loading task
 * with `Setting up fake worker failed: "<reason>".` when the worker chunk
 * cannot be imported — under the Turbopack route bundle the runtime
 * module-relative import pointed at .next/dev/server/chunks/ and no
 * pdf.worker.mjs exists there (the VAL-INC-007/010/012 live failure).
 */
export const PDFJS_FAKE_WORKER_FAILURE_PREFIX = "Setting up fake worker failed";

/**
 * A PDF-ENGINE failure: the pdfjs module or its worker chunk failed to
 * LOAD. That is bundler/runtime breakage — never a verdict on the uploaded
 * document — so it must never surface as the honest-unreadable result
 * (readable:false), which is reserved for genuine content findings.
 * parse1040Pdf throws this and the route maps it to the internal taxonomy
 * error, keeping engine breakage visible instead of masquerading as "not
 * a 1040". Defined here rather than as a telemetry AppError because the
 * parse module's import boundary admits nothing outside src/lib/income.
 */
export class PdfEnvironmentError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PdfEnvironmentError";
  }
}

/**
 * The total, exact engine-failure classifier: TRUE only for a
 * PdfEnvironmentError (already classified) or an Error carrying pdf.js's
 * version-pinned fake-worker failure prefix; FALSE for everything else,
 * which stays a genuine content verdict at the call site. Exported for the
 * classification property test.
 */
export function isPdfEnvironmentFailure(error: unknown): boolean {
  if (error instanceof PdfEnvironmentError) {
    return true;
  }
  return (
    error instanceof Error &&
    error.message.startsWith(PDFJS_FAKE_WORKER_FAILURE_PREFIX)
  );
}

let pdfjsModulePromise: Promise<PdfJsModule> | null = null;

/**
 * The engine module, loaded once. The specifier resolves because
 * next.config.ts keeps pdfjs-dist OUT of the server bundle
 * (serverExternalPackages): pdf.js's fake-worker setup imports its
 * sibling pdf.worker.mjs at runtime with a module-relative path, which
 * only resolves from the real node_modules layout — bundled into a
 * Turbopack server chunk it points at .next/dev/server/chunks/ and fails.
 * The load itself happens OUTSIDE every content-verdict try/catch
 * (parse1040Pdf wraps it in PdfEnvironmentError): a module-load failure
 * must surface as engine breakage, never be swallowed into "not a 1040".
 */
function pdfjsModule(): Promise<PdfJsModule> {
  pdfjsModulePromise ??= import(
    "pdfjs-dist/legacy/build/pdf.mjs"
  ) as Promise<PdfJsModule>;
  return pdfjsModulePromise;
}

/**
 * Page text items (the identity markers span both pages of the 2025
 * template: the page-1 masthead carries the split "Form"/"1040" items while
 * the page-2 footer carries "Form 1040 (2025)" with the year). Takes a
 * defensive copy: pdfjs may take ownership of the buffer it is handed, and
 * the caller's bytes must never be touched.
 */
async function pageItems(
  bytes: Uint8Array,
  pageNumber: number,
): Promise<PdfJsTextItem[]> {
  const pdfjs = await pdfjsModule();
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes) });
  try {
    const doc = await task.promise;
    const page = await doc.getPage(pageNumber);
    const content = await page.getTextContent();
    return content.items;
  } catch (error) {
    // Engine failure first: a broken worker environment rejects the
    // loading task exactly like bad bytes would, but it must escape the
    // honest-unreadable content verdicts below — bundler breakage is
    // visible, never "not a 1040".
    if (isPdfEnvironmentFailure(error)) {
      throw error instanceof PdfEnvironmentError
        ? error
        : new PdfEnvironmentError("the PDF engine worker failed to load", {
          cause: error,
        });
    }
    throw error;
  } finally {
    await task.destroy?.();
  }
}

/** Whitespace-normalized text of one page's items. */
function normalizedText(items: readonly PdfJsTextItem[]): string {
  return items
    .map((item) => item.str)
    .join(" ")
    .replace(/\s+/g, " ");
}

// ---------------------------------------------------------------------------
// Value parsing (never guesses)
// ---------------------------------------------------------------------------

/**
 * Parse a printed dollar amount: optional $, thousands commas, optional
 * cents, IRS parentheses convention for negatives. Anything else → null
 * (an absent finding), never a guess.
 */
function parseMoney(text: string): number | null {
  const cleaned = text.replace(/[$,\s]/g, "");
  const parenthesized = /^\((\d{1,12}(?:\.\d{1,2})?)\)$/.exec(cleaned);
  const plain = /^(\d{1,12}(?:\.\d{1,2})?)$/.test(cleaned);
  if (parenthesized) {
    const value = Number(parenthesized[1]);
    return Number.isFinite(value) ? -value : null;
  }
  if (!plain) {
    return null;
  }
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

// ---------------------------------------------------------------------------
// Identity: is this a readable Form 1040 at all?
// ---------------------------------------------------------------------------

interface Identity {
  readonly year: string | null;
}

async function identify1040(bytes: Uint8Array): Promise<Identity | null> {
  const pageOne = await pageItems(bytes, 1);
  const pageTwo = await pageItems(bytes, 2);
  const joined = `${normalizedText(pageOne)} ${normalizedText(pageTwo)}`;
  // The BASE Form 1040 only: amended (1040-X) and other variants carry a
  // different line grid, so a right-column value at the line-11 marker
  // would be a different quantity — never read one, never identify one.
  if (joined.includes("Amended U.S. Individual Income Tax Return")) {
    return null;
  }
  if (/Form\s+1040\s*-\s*[A-Za-z]/.test(joined)) {
    return null;
  }
  if (!joined.includes("Individual Income Tax Return")) {
    return null;
  }
  if (!/Form\s+1040/.test(joined)) {
    return null;
  }
  const year = /Form 1040\s*\((\d{4})\)/.exec(joined)?.[1] ?? null;
  return { year };
}

// ---------------------------------------------------------------------------
// Stage 1: AcroForm field values (exact reads)
// ---------------------------------------------------------------------------

function fieldMap(fields: readonly PDFField[]): Map<string, PDFField> {
  const byName = new Map<string, PDFField>();
  for (const field of fields) {
    byName.set(field.getName(), field);
  }
  return byName;
}

function textValue(fields: Map<string, PDFField>, name: string): string | null {
  const field = fields.get(name);
  if (!(field instanceof PDFTextField)) {
    return null;
  }
  const value = field.getText();
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function checkedStatuses(
  fields: Map<string, PDFField>,
): TaxFilingStatus[] {
  const checked: TaxFilingStatus[] = [];
  for (const [status, name] of Object.entries(FORM_2025.status) as [
    TaxFilingStatus,
    string,
  ][]) {
    const field = fields.get(name);
    if (field instanceof PDFCheckBox && field.isChecked()) {
      checked.push(status);
    }
  }
  return checked;
}

function dependentCount(fields: Map<string, PDFField>): number {
  let count = 0;
  for (const row of FORM_2025.dependents) {
    const occupied = row.some((name) => textValue(fields, name) !== null);
    if (occupied) {
      count += 1;
    }
  }
  return count;
}

/**
 * Exact reads from the AcroForm, only where the layout is pinned (2025).
 * Findings are emitted only for values actually present; a form with two
 * filing-status boxes checked yields no status finding (never a guess).
 */
async function acroFormFindings(
  bytes: Uint8Array,
  identity: Identity,
): Promise<TaxFinding[]> {
  const findings: TaxFinding[] = [];
  if (identity.year !== "2025") {
    return findings;
  }
  let fields: Map<string, PDFField>;
  try {
    // ignoreEncryption lets the load succeed; the isEncrypted check below
    // still refuses an encrypted file's (garbage) content. The hybrid-XFA
    // entry of the 2025 template is fine here: reads only touch the
    // AcroForm side, and the file is never saved back.
    const pdf = await PDFDocument.load(bytes, {
      ignoreEncryption: true,
      updateMetadata: false,
    });
    if (pdf.isEncrypted) {
      return findings;
    }
    fields = fieldMap(pdf.getForm().getFields());
  } catch {
    // A PDF whose AcroForm cannot be read still gets its text-layer shot.
    return findings;
  }

  const wages = parseMoney(textValue(fields, FORM_2025.wages) ?? "");
  if (wages !== null) {
    findings.push({
      field: "wages_line_1a",
      value: wages,
      origin: "acroform_field",
      confidence: FIELD_READ_CONFIDENCE,
    });
  }
  const agi = parseMoney(textValue(fields, FORM_2025.agi) ?? "");
  if (agi !== null) {
    findings.push({
      field: "agi_line_11",
      value: agi,
      origin: "acroform_field",
      confidence: FIELD_READ_CONFIDENCE,
    });
  }
  const checked = checkedStatuses(fields);
  if (checked.length === 1) {
    findings.push({
      field: "filing_status",
      value: checked[0] as string,
      origin: "acroform_field",
      confidence: FIELD_READ_CONFIDENCE,
    });
  }
  const count = dependentCount(fields);
  if (count > 0) {
    findings.push({
      field: "dependent_count",
      value: count,
      origin: "acroform_field",
      confidence: FIELD_READ_CONFIDENCE,
    });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Stage 2: positional text-layer rules (fills the gaps)
// ---------------------------------------------------------------------------

/**
 * The amount-column marker sits just left of the amount boxes (x≈486-489
 * on the pinned layout); the printed amount sits at x≥500 on the same
 * baseline (±2.5pt). Items are concatenated left-to-right so an amount
 * split across pdfjs items still parses as one number.
 */
function amountFromTextLayer(
  items: readonly PdfJsTextItem[],
  marker: RegExp,
): number | null {
  const markerItem = items.find(
    (item) =>
      marker.test(item.str.trim()) &&
      item.transform[4] >= 470 &&
      item.transform[4] <= 500,
  );
  if (!markerItem) {
    return null;
  }
  const y = markerItem.transform[5];
  const pieces = items
    .filter(
      (item) =>
        item.transform[4] >= 500 &&
        Math.abs(item.transform[5] - y) <= 2.5 &&
        item.str.trim().length > 0,
    )
    .sort((a, b) => a.transform[4] - b.transform[4])
    .map((item) => item.str.trim())
    .join("");
  return parseMoney(pieces);
}

function pointInRect(rect: Rect, x: number, y: number, tolerance = 2): boolean {
  return (
    x >= rect.x - tolerance &&
    x <= rect.x + rect.width + tolerance &&
    y >= rect.y - tolerance &&
    y <= rect.y + rect.height + tolerance
  );
}

/**
 * Flattened-copy rules for the pinned 2025 layout: a checked box bakes a
 * check glyph inside its rect; a dependent row bakes text inside one of its
 * four column rects. Contradictory marks (>1 box) yield no finding — the
 * parser never picks a side.
 */
function layoutFromTextLayer(
  items: readonly PdfJsTextItem[],
): Pick<TaxFinding, "field" | "value" | "origin" | "confidence">[] {
  const findings: TaxFinding[] = [];

  const checked: TaxFilingStatus[] = [];
  for (const [status, rect] of Object.entries(LAYOUT_2025.statusBoxes) as [
    TaxFilingStatus,
    Rect,
  ][]) {
    const marked = items.some(
      (item) =>
        CHECK_GLYPHS.has(item.str.trim()) &&
        pointInRect(rect, item.transform[4], item.transform[5]),
    );
    if (marked) {
      checked.push(status);
    }
  }
  if (checked.length === 1) {
    findings.push({
      field: "filing_status",
      value: checked[0] as string,
      origin: "text_layer",
      confidence: TEXT_LAYER_CONFIDENCE,
    });
  }

  let occupiedRows = 0;
  for (const row of LAYOUT_2025.dependentRows) {
    const occupied = items.some(
      (item) =>
        !CHECK_GLYPHS.has(item.str.trim()) &&
        item.str.trim() !== "." &&
        item.str.trim().length > 0 &&
        row.columns.some((rect) =>
          pointInRect(rect, item.transform[4], item.transform[5]),
        ),
    );
    if (occupied) {
      occupiedRows += 1;
    }
  }
  if (occupiedRows > 0) {
    findings.push({
      field: "dependent_count",
      value: occupiedRows,
      origin: "text_layer",
      confidence: TEXT_LAYER_CONFIDENCE,
    });
  }
  return findings;
}

/**
 * Text-layer findings for exactly the fields the AcroForm could not supply.
 * Amount rules run for any 1040 layout with the standard amount-column
 * markers; the status/dependent rect rules need the pinned 2025 layout.
 */
async function textLayerFindings(
  bytes: Uint8Array,
  missing: readonly TaxFindingField[],
  identity: Identity,
): Promise<TaxFinding[]> {
  if (missing.length === 0) {
    return [];
  }
  const items = await pageItems(bytes, 1);
  const findings: TaxFinding[] = [];

  if (missing.includes("wages_line_1a")) {
    const wages = amountFromTextLayer(items, /^1a$/);
    if (wages !== null) {
      findings.push({
        field: "wages_line_1a",
        value: wages,
        origin: "text_layer",
        confidence: TEXT_LAYER_CONFIDENCE,
      });
    }
  }
  if (missing.includes("agi_line_11")) {
    const agi = amountFromTextLayer(items, /^11(?:a)?$/);
    if (agi !== null) {
      findings.push({
        field: "agi_line_11",
        value: agi,
        origin: "text_layer",
        confidence: TEXT_LAYER_CONFIDENCE,
      });
    }
  }
  const needsLayout =
    missing.includes("filing_status") || missing.includes("dependent_count");
  if (needsLayout && identity.year === "2025") {
    for (const finding of layoutFromTextLayer(items)) {
      if (missing.includes(finding.field)) {
        findings.push(finding);
      }
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const FINDING_ORDER: readonly TaxFindingField[] = [
  "wages_line_1a",
  "agi_line_11",
  "filing_status",
  "dependent_count",
];

/**
 * Parse a 1040 PDF deterministically and in memory. Returns
 * {readable: false, findings: [], monthlyDerived: null} for anything that
 * is not a readable Form 1040 (scanned, flat non-1040, encrypted, or
 * garbage bytes) — an honest verdict with nothing invented. Throws only on
 * programmer or environment error, never on input: a PDF-engine load
 * failure (module or worker chunk) throws PdfEnvironmentError, which the
 * route surfaces as the distinct internal taxonomy error — bundler
 * breakage is visible, never masquerading as "not a 1040".
 */
export async function parse1040Pdf(input: Uint8Array): Promise<TaxParseResult> {
  // Defensive copy: the caller's buffer is never mutated (pdfjs may claim
  // the buffer it is handed).
  const bytes = new Uint8Array(input);
  // ENGINE LAYER — loaded before and outside every content-verdict
  // try/catch: a failure to LOAD the engine (the module or its worker
  // chunk) is bundler/runtime breakage and surfaces as
  // PdfEnvironmentError. It must never be swallowed into the honest-
  // unreadable verdict below, which is reserved for genuine content
  // findings about the bytes.
  try {
    await pdfjsModule();
  } catch (error) {
    throw new PdfEnvironmentError("the PDF engine failed to load", {
      cause: error,
    });
  }
  // An encrypted document is never honestly readable (the content streams
  // may be garbage under the encryption wrapper): verdict it unreadable up
  // front rather than parsing whatever decrypts by accident.
  try {
    const loaded = await PDFDocument.load(bytes, {
      ignoreEncryption: true,
      updateMetadata: false,
    });
    if (loaded.isEncrypted) {
      return UNREADABLE;
    }
  } catch {
    // pdf-lib load failures stay with the pdfjs identification pass below.
  }
  let identity: Identity | null;
  try {
    identity = await identify1040(bytes);
  } catch (error) {
    // Engine failures escape (never a verdict); genuine content failures
    // (corrupt or garbage bytes) stay an honest unreadable.
    if (error instanceof PdfEnvironmentError) {
      throw error;
    }
    return UNREADABLE;
  }
  if (!identity) {
    return UNREADABLE;
  }

  let exact: TaxFinding[];
  try {
    exact = await acroFormFindings(bytes, identity);
  } catch {
    exact = [];
  }
  const exactFields = new Set(exact.map((finding) => finding.field));
  const missing = FINDING_ORDER.filter((field) => !exactFields.has(field));

  let fromText: TaxFinding[];
  try {
    fromText = await textLayerFindings(bytes, missing, identity);
  } catch (error) {
    // Same split as the identity pass: engine failures escape; content
    // failures mean the text layer simply offers nothing.
    if (error instanceof PdfEnvironmentError) {
      throw error;
    }
    fromText = [];
  }

  const findings = [...exact, ...fromText].sort(
    (a, b) =>
      FINDING_ORDER.indexOf(a.field) - FINDING_ORDER.indexOf(b.field),
  );

  const agi = findings.find((finding) => finding.field === "agi_line_11");
  const monthlyDerived =
    agi && typeof agi.value === "number"
      ? deriveMonthlyFromAnnualAgi(agi.value)
      : null;

  return { readable: true, findings, monthlyDerived };
}
