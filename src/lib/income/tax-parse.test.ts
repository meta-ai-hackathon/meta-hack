import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { PDFDocument, StandardFonts } from "@cantoo/pdf-lib";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  deriveMonthlyFromAnnualAgi,
  parse1040Pdf,
  type TaxFilingStatus,
  type TaxParseResult,
} from "./tax-parse";

// Tests for the deterministic 1040 parser (VAL-INC-004 / VAL-INC-009).
// The fixture is the real IRS 1040 template bytes (sha256-pinned below);
// every "filled" input in this suite is produced in memory from those
// bytes and is never written to disk — the parser gets bytes, returns a
// typed result, and touches nothing else.

const FIXTURE_URL = new URL("./fixtures/f1040.pdf", import.meta.url);
// Real 2025 Form 1040 from https://www.irs.gov/pub/irs-pdf/f1040.pdf
// (retrieved 2026-11-01). The pin fails the suite on any byte drift.
const F1040_SHA256 =
  "3d31c226df0d189ced80e039d01cf0f8820c1019681a0f0ca6264de277b7e982";

// IRS AcroForm field names on the 2025 layout, verified against the pinned
// fixture (widget rects vs. page text). The test fills these to synthesize
// a "saved" 1040; the module reads them back.
const P1 = "topmostSubform[0].Page1[0].";
const STATUS_FIELDS: Record<TaxFilingStatus, string> = {
  single: `${P1}Checkbox_ReadOrder[0].c1_8[0]`,
  married_filing_jointly: `${P1}Checkbox_ReadOrder[0].c1_8[1]`,
  married_filing_separately: `${P1}Checkbox_ReadOrder[0].c1_8[2]`,
  head_of_household: `${P1}c1_8[0]`,
  qualifying_surviving_spouse: `${P1}c1_8[1]`,
};

/** Synthetic-only persona values (HACK-58): SSA never issues 000-area SSNs. */
const DEPENDENT_ROWS = [
  ["Alma", "Rivera", "000-00-0001", "daughter"],
  ["Ben", "Rivera", "000-00-0002", "son"],
] as const;

interface FillSpec {
  wages?: string;
  agi?: string;
  status?: TaxFilingStatus;
  dependents?: readonly (readonly string[])[];
}

async function fillFixture(
  spec: FillSpec,
  flatten: boolean,
): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(readFileSync(FIXTURE_URL), {
    ignoreEncryption: true,
    updateMetadata: false,
  });
  const form = pdf.getForm();
  if (spec.wages !== undefined) {
    form.getTextField(`${P1}f1_47[0]`).setText(spec.wages);
  }
  if (spec.agi !== undefined) {
    form.getTextField(`${P1}f1_75[0]`).setText(spec.agi);
  }
  if (spec.status !== undefined) {
    form.getCheckBox(STATUS_FIELDS[spec.status]).check();
  }
  (spec.dependents ?? []).slice(0, 4).forEach((row, rowIndex) => {
    row.slice(0, 4).forEach((cell, columnIndex) => {
      const name = `${P1}Table_Dependents[0].Row${rowIndex + 1}[0].f1_${
        31 + rowIndex * 4 + columnIndex
      }[0]`;
      form.getTextField(name).setText(cell);
    });
  });
  if (flatten) {
    form.flatten();
  }
  // Default save regenerates field appearances, so a re-loaded copy bakes
  // real ink when flattened again (the appearance-aware flatten test).
  return pdf.save();
}

const FILLED: FillSpec = {
  wages: "52500",
  agi: "48200",
  status: "married_filing_jointly",
  dependents: DEPENDENT_ROWS,
};

describe("fixture pin", () => {
  it("commits the real IRS 1040 template bytes, sha256-pinned", () => {
    const bytes = readFileSync(FIXTURE_URL);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      F1040_SHA256,
    );
  });
});

describe("identity and honesty", () => {
  it("reads the blank template as a 1040 with zero findings (nothing invented)", async () => {
    const result = await parse1040Pdf(readFileSync(FIXTURE_URL));
    expect(result).toEqual({
      readable: true,
      findings: [],
      monthlyDerived: null,
    });
  });

  it("verdicts a synthetic non-1040 PDF honestly (readable:false)", async () => {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([612, 792]);
    page.drawCircle({ x: 100, y: 100, size: 5 }); // no 1040 identity text
    const bytes = await pdf.save();
    const result = await parse1040Pdf(bytes);
    expect(result).toEqual({
      readable: false,
      findings: [],
      monthlyDerived: null,
    });
  });

  it("verdicts a text-free (scanned-like) PDF honestly (readable:false)", async () => {
    // A scanned document is image-only: no text layer, no AcroForm values.
    // A blank page with neither is the same read surface for the parser.
    const pdf = await PDFDocument.create();
    pdf.addPage([612, 792]);
    const bytes = await pdf.save();
    const result = await parse1040Pdf(bytes);
    expect(result).toEqual({
      readable: false,
      findings: [],
      monthlyDerived: null,
    });
  });

  it("verdicts a Form 1040-X (amended) variant honestly (readable:false)", async () => {
    // A 1040-X has a different line grid: the right-column value at the
    // line-11 marker is a different quantity, so the variant must never be
    // identified as a base 1040 (no findings, no monthly figure).
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([612, 792]);
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    page.drawText("Amended U.S. Individual Income Tax Return", {
      x: 40,
      y: 740,
      size: 12,
      font,
    });
    page.drawText("Form 1040-X", { x: 40, y: 720, size: 12, font });
    const bytes = await pdf.save();
    const result = await parse1040Pdf(bytes);
    expect(result).toEqual({
      readable: false,
      findings: [],
      monthlyDerived: null,
    });
  });

  it("verdicts an encrypted PDF honestly (readable:false)", async () => {
    const encrypted = readFileSync(
      new URL("../forms/fixtures/sample-form-encrypted.pdf", import.meta.url),
    );
    const result = await parse1040Pdf(encrypted);
    expect(result).toEqual({
      readable: false,
      findings: [],
      monthlyDerived: null,
    });
  });

  it("verdicts non-PDF garbage honestly and never throws", async () => {
    const garbage = new Uint8Array(1024).map((_, i) => (i * 37) % 256);
    const result = await parse1040Pdf(garbage);
    expect(result.readable).toBe(false);
    expect(result.findings).toEqual([]);
    expect(result.monthlyDerived).toBeNull();
  });

  it("property: arbitrary non-PDF bytes parse honestly to readable:false", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uint8Array({ minLength: 0, maxLength: 512 }),
        async (bytes) => {
          const result = await parse1040Pdf(bytes);
          expect(result.readable).toBe(false);
          expect(result.findings).toEqual([]);
          expect(result.monthlyDerived).toBeNull();
        },
      ),
      { numRuns: 20 },
    );
  });

  it("never mutates the caller's bytes (purity)", async () => {
    const bytes = readFileSync(FIXTURE_URL);
    const before = new Uint8Array(bytes);
    await parse1040Pdf(bytes);
    expect(Buffer.from(bytes).equals(Buffer.from(before))).toBe(true);
  });
});

describe("VAL-INC-004: field extraction from the real bytes", () => {
  it("AcroForm field reads propose the four pinned findings exactly", async () => {
    const bytes = await fillFixture(FILLED, false);
    const result = await parse1040Pdf(bytes);
    expect(result.readable).toBe(true);
    expect(result.findings).toEqual([
      { field: "wages_line_1a", value: 52500, origin: "acroform_field", confidence: 1 },
      { field: "agi_line_11", value: 48200, origin: "acroform_field", confidence: 1 },
      {
        field: "filing_status",
        value: "married_filing_jointly",
        origin: "acroform_field",
        confidence: 1,
      },
      { field: "dependent_count", value: 2, origin: "acroform_field", confidence: 1 },
    ]);
  });

  it("running the parse twice over the same bytes yields identical results", async () => {
    const bytes = await fillFixture(FILLED, false);
    const first: TaxParseResult = await parse1040Pdf(bytes);
    const second: TaxParseResult = await parse1040Pdf(bytes);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    const flatBytes = await fillFixture(FILLED, true);
    const flatFirst = await parse1040Pdf(flatBytes);
    const flatSecond = await parse1040Pdf(flatBytes);
    expect(JSON.stringify(flatFirst)).toBe(JSON.stringify(flatSecond));
  });

  it("flattened bytes (no field values) fall back to positional text-layer rules", async () => {
    const bytes = await fillFixture(FILLED, true);
    const result = await parse1040Pdf(bytes);
    expect(result.readable).toBe(true);
    expect(result.findings).toEqual([
      { field: "wages_line_1a", value: 52500, origin: "text_layer", confidence: 0.9 },
      { field: "agi_line_11", value: 48200, origin: "text_layer", confidence: 0.9 },
      {
        field: "filing_status",
        value: "married_filing_jointly",
        origin: "text_layer",
        confidence: 0.9,
      },
      { field: "dependent_count", value: 2, origin: "text_layer", confidence: 0.9 },
    ]);
  });

  it("prefers AcroForm values and fills only the gaps from the text layer", async () => {
    // Flatten a filled copy (both values baked into the page content, all
    // fields gone), then recreate ONLY the wages field by name: the parser
    // must take wages from the field and AGI from the text layer.
    const flat = await PDFDocument.load(await fillFixture(FILLED, true));
    const form = flat.getForm();
    form.createTextField(`${P1}f1_47[0]`).setText("52500");
    const bytes = await flat.save();
    const result = await parse1040Pdf(bytes);
    const wages = result.findings.find((f) => f.field === "wages_line_1a");
    const agi = result.findings.find((f) => f.field === "agi_line_11");
    expect(wages).toEqual({
      field: "wages_line_1a",
      value: 52500,
      origin: "acroform_field",
      confidence: 1,
    });
    expect(agi).toEqual({
      field: "agi_line_11",
      value: 48200,
      origin: "text_layer",
      confidence: 0.9,
    });
  });

  it("never invents a number from an unparseable field value", async () => {
    const bytes = await fillFixture({ ...FILLED, wages: "see attachment" }, false);
    const result = await parse1040Pdf(bytes);
    expect(result.findings.find((f) => f.field === "wages_line_1a")).toBeUndefined();
  });

  it("never picks a filing status when two boxes are checked", async () => {
    const withMfj = await fillFixture({ ...FILLED }, false);
    const pdf = await PDFDocument.load(withMfj);
    pdf.getForm().getCheckBox(STATUS_FIELDS.single).check();
    const bytes = await pdf.save();
    const result = await parse1040Pdf(bytes);
    expect(
      result.findings.find((f) => f.field === "filing_status"),
    ).toBeUndefined();
  });

  it("reads parenthesized negative amounts honestly (1040 negative convention)", async () => {
    const bytes = await fillFixture({ ...FILLED, agi: "(31,000)" }, false);
    const result = await parse1040Pdf(bytes);
    const agi = result.findings.find((f) => f.field === "agi_line_11");
    expect(agi?.value).toBe(-31000);
  });
});

describe("VAL-INC-009: the monthly derivation is a documented deterministic rule", () => {
  // Documented rule (also in tax-parse.ts and the PR): the monthly figure
  // is the PRIOR-YEAR annual AGI divided by 12, rounded to the nearest
  // whole dollar with halves rounding up — floor(annual / 12 + 0.5). A
  // negative or non-finite annual value yields null (an unknown, never a
  // confident 0); the proposal is confirmed or corrected by the person
  // before anything is saved (parts 2-3).
  it("implements the documented half-up rule on known cases", () => {
    expect(deriveMonthlyFromAnnualAgi(48200)).toBe(4017); // 4016.67 → 4017
    expect(deriveMonthlyFromAnnualAgi(0)).toBe(0);
    expect(deriveMonthlyFromAnnualAgi(12)).toBe(1);
    expect(deriveMonthlyFromAnnualAgi(6)).toBe(1); // 0.5 → half rounds up
    expect(deriveMonthlyFromAnnualAgi(5)).toBe(0); // 0.4167 → 0
    expect(deriveMonthlyFromAnnualAgi(-100)).toBeNull(); // unknown, not 0
    expect(deriveMonthlyFromAnnualAgi(Number.NaN)).toBeNull();
    expect(deriveMonthlyFromAnnualAgi(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("property: pure, total, integral, and equal to the documented formula", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: -1_000_000, max: 100_000_000 }),
        async (annual) => {
          const first = deriveMonthlyFromAnnualAgi(annual);
          const second = deriveMonthlyFromAnnualAgi(annual);
          expect(first).toBe(second); // same input → same output
          if (annual >= 0) {
            expect(Number.isInteger(first as number)).toBe(true);
            expect(first).toBe(Math.floor(annual / 12 + 0.5));
            // within half a month of exact division
            expect((first as number) * 12).toBeGreaterThanOrEqual(annual - 6);
            expect((first as number) * 12).toBeLessThanOrEqual(annual + 6);
          } else {
            expect(first).toBeNull();
          }
        },
      ),
      { numRuns: 500 },
    );
  });

  it("property: monotone non-decreasing over the non-negative domain", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 50_000_000 }),
        fc.integer({ min: 0, max: 500 }),
        async (base, delta) => {
          const atBase = deriveMonthlyFromAnnualAgi(base) as number;
          const atLarger = deriveMonthlyFromAnnualAgi(base + delta) as number;
          expect(atLarger).toBeGreaterThanOrEqual(atBase);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("monthlyDerived applies the documented rule to the extracted AGI, both origins", async () => {
    const acro = await parse1040Pdf(await fillFixture(FILLED, false));
    expect(acro.monthlyDerived).toBe(4017);
    const flat = await parse1040Pdf(await fillFixture(FILLED, true));
    expect(flat.monthlyDerived).toBe(4017);
    const blank = await parse1040Pdf(readFileSync(FIXTURE_URL));
    expect(blank.monthlyDerived).toBeNull();
    const negative = await parse1040Pdf(
      await fillFixture({ ...FILLED, agi: "(31,000)" }, false),
    );
    expect(negative.monthlyDerived).toBeNull(); // unknown, not 0
  });
});
