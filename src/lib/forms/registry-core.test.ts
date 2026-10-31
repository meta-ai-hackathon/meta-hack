import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { PII_QUESTION_IDS_IN_SPEC, QUESTIONS } from "../intake/spec";
import { formRegistryEntries } from "./registry";
import {
  assertRegistryEntryConsistent,
  parseCommittedRegistryEntries,
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
