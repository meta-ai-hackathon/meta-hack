import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { EMPTY_CLIENT_ANSWERS } from "./client-store";
import {
  BOX_ANSWER_WORDS,
  DEVICE_FORM_ENTRY,
  deviceFillValues,
  reviewAnswersForForm,
} from "./device-form";

// The review's typed answers on the step-by-step page (HACK-115), checked
// before the device fill takes them. The fill reads a box as checked only
// for the word checked and prints any other text as an unchecked box that
// counts as filled, so a box answer the fill can't read must never reach
// it: the page lists it to fix instead.

const BOXES = new Set(
  DEVICE_FORM_ENTRY.fields
    .filter((field) => field.type === "checkbox" || field.type === "radio")
    .map((field) => field.name),
);
const TYPED_FIELDS = DEVICE_FORM_ENTRY.fields
  .filter((field) => field.disposition === "mapped" && field.specQuestionId === null)
  .map((field) => field.name);

/** A box word in any case, with spaces around it or not. */
const boxWord = fc
  .tuple(fc.constantFrom(...BOX_ANSWER_WORDS), fc.boolean(), fc.constantFrom("", " ", "  "))
  .map(([word, upper, pad]) => `${pad}${upper ? word.toUpperCase() : word}${pad}`);

/** Whatever a person might type: box words, yes and no, blanks, and other text. */
const typedValue = fc.oneof(
  boxWord,
  fc.constantFrom("yes", "No", "x", "X", "true", "check", "", "   "),
  fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9 .,#'-]{0,30}$/),
);

const typedArb = fc.dictionary(fc.constantFrom(...TYPED_FIELDS), typedValue, { maxKeys: 12 });

describe("reviewAnswersForForm", () => {
  it("draws box fields and other fields (non-vacuous)", () => {
    expect(TYPED_FIELDS.filter((name) => BOXES.has(name)).length).toBeGreaterThan(100);
    expect(TYPED_FIELDS.filter((name) => !BOXES.has(name)).length).toBeGreaterThan(100);
  });

  it("lets a box answer through only as checked or unchecked, and lists any other", () => {
    fc.assert(
      fc.property(typedArb, (typed) => {
        const { values, unreadable } = reviewAnswersForForm(typed);
        for (const [name, value] of Object.entries(typed)) {
          if (!BOXES.has(name)) {
            expect(values[name], name).toBe(value);
            expect(unreadable, name).not.toContain(name);
            continue;
          }
          const word = value.trim().toLowerCase();
          if (word === "") {
            expect(Object.hasOwn(values, name), name).toBe(false);
            expect(unreadable, name).not.toContain(name);
          } else if (BOX_ANSWER_WORDS.includes(word)) {
            expect(values[name], name).toBe(word);
            expect(unreadable, name).not.toContain(name);
          } else {
            expect(Object.hasOwn(values, name), name).toBe(false);
            expect(unreadable, name).toContain(name);
          }
        }
        // Nothing is listed that wasn't typed, and nothing is listed twice.
        expect(new Set(unreadable).size).toBe(unreadable.length);
        for (const name of unreadable) {
          expect(Object.hasOwn(typed, name), name).toBe(true);
        }
      }),
      { numRuns: 300 },
    );
  });

  it("hands the fill only box answers it reads as they were meant", () => {
    fc.assert(
      fc.property(typedArb, (typed) => {
        const assembled = deviceFillValues(EMPTY_CLIENT_ANSWERS, reviewAnswersForForm(typed).values);
        expect(assembled).not.toBeNull();
        for (const [name, value] of Object.entries(assembled?.values ?? {})) {
          if (BOXES.has(name)) {
            expect(BOX_ANSWER_WORDS, name).toContain(value.display);
          }
        }
      }),
      { numRuns: 300 },
    );
  });
});
