import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { PII_QUESTION_IDS_IN_SPEC, QUESTIONS } from "../intake/spec";
import acroformEntryJson from "../../../kb/forms/sample-form-acroform.json";
import flatEntryJson from "../../../kb/forms/sample-form-flat.json";
import dhb5200EntryJson from "../../../kb/forms/dhb-5200.json";
import { formRegistryEntries } from "./registry";
import {
  assertRegistryEntryConsistent,
  parseCommittedRegistryEntries,
  parseRegistryEntry,
  type FormRegistryEntry,
} from "./registry-core";

// The browser-safe registry (HACK-115): the step-by-step page reads the
// same committed entries the server fills from, validated by the same code,
// and an entry that would let a form read a vault field it doesn't name
// is refused wherever it is loaded.

class EntryRejected extends Error {}
const reject = (detail: string) => new EntryRejected(detail);

const ENTRIES = parseCommittedRegistryEntries(reject);
const NON_PII_QUESTION_IDS = QUESTIONS.filter((question) => !question.pii).map(
  (question) => question.id,
);

describe("the committed registry entries", () => {
  it("are the very entries the server's registry serves", () => {
    expect(ENTRIES).toEqual(formRegistryEntries());
  });
});

// The committed entries as written, before validation (snake_case, as in kb/forms/).
type RawField = Record<string, unknown>;
type RawEntry = Record<string, unknown> & { readonly fields: readonly RawField[] };
const RAW_ENTRIES = [acroformEntryJson, flatEntryJson, dhb5200EntryJson] as unknown as readonly RawEntry[];

const DISPOSITIONS = [
  "mapped",
  "not_collected_by_interview",
  "optional_unanswered",
  "agency_use_only",
  "duplicate_structural",
] as const;

/** A committed entry with the field at `index` rewritten by `rewrite`. */
const rewrittenFieldArb = (rewrite: fc.Arbitrary<(field: RawField) => RawField>) =>
  fc.constantFrom(...RAW_ENTRIES).chain((entry) =>
    fc.tuple(fc.nat({ max: entry.fields.length - 1 }), rewrite).map(([index, change]) => ({
      index,
      raw: {
        ...entry,
        fields: entry.fields.map((field, at) => (at === index ? change(field) : field)),
      },
    })),
  );

const without = (field: RawField, key: string): RawField =>
  Object.fromEntries(Object.entries(field).filter(([name]) => name !== key));

describe("the full-form mapping fields (VAL-FIX-007)", () => {
  it("keep every committed field's disposition, reason, export values and group as written", () => {
    RAW_ENTRIES.forEach((raw, at) => {
      const entry = parseRegistryEntry(raw, reject);
      expect(entry).toEqual(ENTRIES[at]);
      entry.fields.forEach((field, index) => {
        const written = raw.fields[index];
        expect(field.disposition).toBe(written.disposition);
        expect(field.dispositionReason).toBe(
          typeof written.disposition_reason === "string" ? written.disposition_reason.trim() : undefined,
        );
        expect(field.exportValue).toBe(written.export_value ?? undefined);
        expect(field.exportValues).toEqual(written.export_values ?? undefined);
        expect(field.conflictGroup).toEqual(written.conflict_group ?? undefined);
      });
    });
  });

  it("take any reviewed disposition with a reason, trimmed", () => {
    const rewrite = fc
      .tuple(fc.constantFrom(...DISPOSITIONS), fc.stringMatching(/^ ?[A-Za-z][A-Za-z ,.]{0,40} ?$/))
      .map(([disposition, reason]) => (field: RawField) => ({
        ...field,
        disposition,
        disposition_reason: reason,
      }));
    fc.assert(
      fc.property(rewrittenFieldArb(rewrite), ({ raw, index }) => {
        const field = parseRegistryEntry(raw, reject).fields[index];
        const written = raw.fields[index];
        expect(field.disposition).toBe(written.disposition);
        expect(field.dispositionReason).toBe(String(written.disposition_reason).trim());
      }),
    );
  });

  it("refuse a field without a reviewed disposition, or left blank without its reason", () => {
    const rewrite = fc.oneof(
      fc.constant((field: RawField) => without(field, "disposition")),
      fc
        .constantFrom("", "Mapped", "unmapped", "agency_only", 1, null)
        .map((disposition) => (field: RawField) => ({ ...field, disposition })),
      fc
        .tuple(
          fc.constantFrom(...DISPOSITIONS.filter((disposition) => disposition !== "mapped")),
          fc.constantFrom(undefined, null, "", "   ", 7),
        )
        .map(([disposition, reason]) => (field: RawField) => ({
          ...without(field, "disposition_reason"),
          disposition,
          ...(reason === undefined ? {} : { disposition_reason: reason }),
        })),
    );
    fc.assert(
      fc.property(rewrittenFieldArb(rewrite), ({ raw }) => {
        expect(() => parseRegistryEntry(raw, reject)).toThrow(EntryRejected);
      }),
    );
  });

  it("refuse malformed export values and conflict groups", () => {
    const rewrite = fc.oneof(
      fc
        .constantFrom("", "   ", 1, true)
        .map((value) => (field: RawField) => ({ ...field, export_value: value })),
      fc
        .constantFrom("On", { yes: "On" }, { no: "Off" }, { yes: "", no: "Off" }, { yes: "On", no: " " }, [])
        .map((value) => (field: RawField) => ({ ...field, export_values: value })),
      fc
        .constantFrom(
          "p2-work-status",
          { id: "", kind: "yes_no" },
          { id: "p2-work-status" },
          { id: "p2-work-status", kind: "pick_one" },
          { kind: "single_choice" },
        )
        .map((value) => (field: RawField) => ({ ...field, conflict_group: value })),
    );
    fc.assert(
      fc.property(rewrittenFieldArb(rewrite), ({ raw }) => {
        expect(() => parseRegistryEntry(raw, reject)).toThrow(EntryRejected);
      }),
    );
  });
});

describe("the consistency check", () => {
  it("refuses a field mapped to a pii question its form's allowlist doesn't name", () => {
    const remapped = fc
      .constantFrom(...ENTRIES)
      .chain((entry) =>
        fc.record({
          entry: fc.constant(entry),
          fieldIndex: fc.nat({ max: entry.fields.length - 1 }),
          questionId: fc.constantFrom(
            ...PII_QUESTION_IDS_IN_SPEC.filter((id) => !entry.vaultFieldAllowlist.includes(id)),
          ),
        }),
      );
    fc.assert(
      fc.property(remapped, ({ entry, fieldIndex, questionId }) => {
        const tampered: FormRegistryEntry = {
          ...entry,
          fields: entry.fields.map((field, index) =>
            index === fieldIndex ? { ...field, specQuestionId: questionId } : field,
          ),
        };
        expect(() => assertRegistryEntryConsistent(tampered, reject)).toThrow(EntryRejected);
      }),
    );
  });

  it("refuses an allowlist that names a question that isn't private", () => {
    const widened = fc.record({
      entry: fc.constantFrom(...ENTRIES),
      questionId: fc.constantFrom(...NON_PII_QUESTION_IDS),
    });
    fc.assert(
      fc.property(widened, ({ entry, questionId }) => {
        const tampered: FormRegistryEntry = {
          ...entry,
          vaultFieldAllowlist: [...entry.vaultFieldAllowlist, questionId],
        };
        expect(() => assertRegistryEntryConsistent(tampered, reject)).toThrow(EntryRejected);
      }),
    );
  });

  it("accepts every committed entry as it is", () => {
    for (const entry of ENTRIES) {
      expect(assertRegistryEntryConsistent(entry, reject)).toBe(entry);
    }
  });
});
