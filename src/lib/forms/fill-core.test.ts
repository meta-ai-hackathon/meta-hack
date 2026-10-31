import { readFileSync } from "node:fs";
import path from "node:path";
import fc from "fast-check";
import { PDFDocument, StandardFonts } from "@cantoo/pdf-lib";
import { describe, expect, it } from "vitest";
import type { AnswerStatus } from "../honesty";
import { QUESTIONS, type Question } from "../intake/spec";
import {
  FILL_FONT,
  assembleFillValues,
  checkedFormValues,
  fillLoadedPdf,
  skippedFieldNames,
  type FillAnswerRecord,
} from "./fill-core";
import { parseCommittedRegistryEntries, type FormRegistryEntry } from "./registry-core";

// The browser-safe fill core (HACK-115): the half of the forms fill that
// runs on the device as well as on the server. Two guarantees matter most
// here. A form only ever reads the private answers its committed allowlist
// names, whatever the caller hands it; and the fill accounts for every
// field exactly once, as filled, left for the person to resolve, or not
// applicable, so the outcome never claims a field it didn't fill.

const ENTRIES = parseCommittedRegistryEntries((detail) => new Error(detail));
const ACROFORM_ENTRIES = ENTRIES.filter((entry) => entry.kind === "acroform");

const templates = new Map<string, Uint8Array>();
function templateFor(entry: FormRegistryEntry): Uint8Array {
  let bytes = templates.get(entry.id);
  if (!bytes) {
    bytes = new Uint8Array(readFileSync(path.resolve(entry.pdfPath)));
    templates.set(entry.id, bytes);
  }
  return bytes;
}

const PII_QUESTIONS = QUESTIONS.filter((question) => question.pii);

/** A canonical value for `question`, the shape both stores keep. */
function valueFor(question: Question): fc.Arbitrary<unknown> {
  const options = (question.options ?? []).map((option) => option.value);
  switch (question.type) {
    case "single_select":
      return fc.constantFrom(...options);
    case "multi_select":
      return fc.uniqueArray(fc.constantFrom(...options), { minLength: 1, maxLength: 3 });
    case "number":
      return fc.integer({ min: 0, max: 5000 });
    case "boolean":
      return fc.boolean();
    case "date":
      return fc
        .date({ min: new Date("1930-01-01"), max: new Date("2026-10-30"), noInvalidDate: true })
        .map((date) => date.toISOString().slice(0, 10));
    case "text":
    case "address":
      // WinAnsi text, and text the form's standard font can't draw.
      return fc.oneof(
        fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9 .,'#-]{0,30}$/),
        fc.constantFrom("Nguyễn Văn An", "李小龍", "Zoë Ñúñez"),
      );
  }
}

const statusArb: fc.Arbitrary<AnswerStatus> = fc.constantFrom("known", "unknown", "unverified");

/** One answer-table row: pii rows hold no value (it lives in the vault). */
function recordFor(question: Question): fc.Arbitrary<FillAnswerRecord> {
  return fc
    .tuple(statusArb, valueFor(question), fc.constantFrom("user_supplied", "source_verified", "ai_drafted"))
    .map(([status, value, provenance]) => ({
      status,
      value: status === "unknown" || question.pii ? null : value,
      provenance: provenance === "ai_drafted" && status !== "unverified" ? "user_supplied" : provenance,
    }));
}

const recordsArb = fc.record(
  Object.fromEntries(QUESTIONS.map((question) => [question.id, recordFor(question)])),
  { requiredKeys: [] },
) as fc.Arbitrary<Record<string, FillAnswerRecord>>;

/** A private value for EVERY pii question, allowlisted or not. */
const everyVaultValueArb = fc.record(
  Object.fromEntries(PII_QUESTIONS.map((question) => [question.id, valueFor(question)])),
) as fc.Arbitrary<Record<string, unknown>>;

/**
 * A committed entry, possibly with some mapped fields pointed at private
 * questions its allowlist leaves out — an entry the registry's own check
 * would refuse, handed to the core directly.
 */
const entryArb: fc.Arbitrary<FormRegistryEntry> = fc
  .constantFrom(...ENTRIES)
  .chain((entry) =>
    fc
      .array(
        fc.record({
          index: fc.nat({ max: entry.fields.length - 1 }),
          questionId: fc.constantFrom(...PII_QUESTIONS.map((question) => question.id)),
        }),
        { maxLength: 3 },
      )
      .map((remaps) => ({
        ...entry,
        fields: entry.fields.map((field, index) => {
          const remap = remaps.find((candidate) => candidate.index === index);
          return remap ? { ...field, specQuestionId: remap.questionId } : field;
        }),
      })),
  );

describe("assembleFillValues", () => {
  it("reads only the private answers the entry's allowlist names", () => {
    fc.assert(
      fc.property(entryArb, recordsArb, everyVaultValueArb, (entry, records, vault) => {
        const { values, answerMap } = assembleFillValues(entry, records, vault);
        const allowlist = new Set(entry.vaultFieldAllowlist);
        for (const field of entry.fields) {
          const value = values[field.name];
          if (value?.source === "vault") {
            expect(allowlist.has(field.specQuestionId ?? "")).toBe(true);
          }
          const question = PII_QUESTIONS.find((candidate) => candidate.id === field.specQuestionId);
          if (question && !allowlist.has(question.id)) {
            expect(value).toBeUndefined();
          }
        }
        // The skip logic sees a private value only when the form may read it.
        for (const question of PII_QUESTIONS) {
          if (!allowlist.has(question.id)) {
            expect(answerMap[question.id]?.value ?? null).toBe(records[question.id]?.value ?? null);
          }
        }
      }),
      { numRuns: 300 },
    );
  });

  it("fills unmapped fields only from the checked in-request values", () => {
    const formValuesArb = fc.constantFrom(...ENTRIES).chain((entry) => {
      const unmapped = entry.fields.filter((field) => field.specQuestionId === null);
      return fc.record({
        entry: fc.constant(entry),
        raw: fc.dictionary(
          fc.constantFrom(...unmapped.map((field) => field.name)),
          fc.stringMatching(/^ ?[A-Za-z0-9][A-Za-z0-9 .-]{0,40} ?$/),
        ),
      });
    });
    fc.assert(
      fc.property(formValuesArb, recordsArb, ({ entry, raw }, records) => {
        const formValues = checkedFormValues(entry, raw);
        expect(formValues).not.toBeNull();
        const { values } = assembleFillValues(entry, records, {}, formValues ?? {});
        for (const field of entry.fields.filter((candidate) => candidate.specQuestionId === null)) {
          const given = raw[field.name];
          expect(values[field.name]).toEqual(
            given === undefined
              ? undefined
              : { display: given.trim(), provenance: "user_supplied", source: "in_request" },
          );
        }
      }),
    );
  });
});

describe("fillLoadedPdf", () => {
  it("draws in pdf-lib's standard Helvetica, named by its value", () => {
    expect(FILL_FONT).toBe(StandardFonts.Helvetica);
  });

  it("accounts for every field exactly once: filled, to resolve, or not applicable", async () => {
    const cases = fc.record({
      entry: fc.constantFrom(...ACROFORM_ENTRIES),
      records: recordsArb,
      vault: everyVaultValueArb,
      keep: fc.boolean(),
    });
    await fc.assert(
      fc.asyncProperty(cases, async ({ entry, records, vault, keep }) => {
        const { values, answerMap } = assembleFillValues(entry, records, keep ? vault : {});
        const pdf = await PDFDocument.load(templateFor(entry));
        const { filled, toResolve } = await fillLoadedPdf(pdf, entry, values, answerMap);
        const skipped = skippedFieldNames(entry, answerMap);
        const seen = [
          ...filled.map((field) => field.fieldName),
          ...toResolve.map((item) => item.fieldName),
          ...skipped,
        ];
        expect([...seen].sort()).toEqual(entry.fields.map((field) => field.name).sort());
        for (const field of filled) {
          expect(field.provenance).toBe(values[field.fieldName]?.provenance);
        }
      }),
      { numRuns: 40 },
    );
  });
});
