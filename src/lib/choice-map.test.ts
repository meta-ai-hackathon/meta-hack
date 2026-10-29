import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  CHOICE_OPTION_SYNONYMS,
  mapChoiceAnswer,
  mapChoiceText,
} from "./choice-map";
import { QUESTIONS, QUESTION_BY_ID } from "./intake/spec";

// Choice canonicalization (Mission v2 M2, hardening item 6): the extractor
// saves only exact option values, so a spoken "It's for myself" extracted
// NOTHING while the assistant's ack implied a save. This layer maps
// realistic free-text phrasings onto spec options — and when nothing maps,
// the turn honestly says so instead of implying a save.

const choiceQuestions = QUESTIONS.filter(
  (question) => question.options && question.options.length > 0,
);

const optionValues = new Map(
  choiceQuestions.map((question) => [
    question.id,
    new Set(question.options?.map((option) => option.value)),
  ]),
);

describe("mapChoiceText — the live-observed failures", () => {
  it('maps "It\'s for myself" onto application_role self', () => {
    expect(mapChoiceText(QUESTION_BY_ID.application_role, "It's for myself")).toEqual([
      "self",
    ]);
  });

  it('maps "for me", "Me", and "my own self" onto self', () => {
    const question = QUESTION_BY_ID.application_role;
    expect(mapChoiceText(question, "me")).toEqual(["self"]);
    expect(mapChoiceText(question, "Me")).toEqual(["self"]);
    expect(mapChoiceText(question, "For myself.")).toEqual(["self"]);
    expect(mapChoiceText(question, "my own self")).toEqual(["self"]);
  });

  it("maps common phrasings for other choice questions", () => {
    expect(mapChoiceText(QUESTION_BY_ID.main_goal, "A place to stay")).toEqual([
      "housing",
    ]);
    expect(mapChoiceText(QUESTION_BY_ID.main_goal, "help with food")).toEqual([
      "food",
    ]);
    expect(
      mapChoiceText(QUESTION_BY_ID.disability_status, "I'm not sure"),
    ).toEqual(["not_sure"]);
    expect(
      mapChoiceText(QUESTION_BY_ID.housing_status, "staying with family or friends"),
    ).toEqual(["staying_with_others"]);
    expect(mapChoiceText(QUESTION_BY_ID.application_role, "my family")).toEqual([
      "family_member",
    ]);
  });

  it("collects every option a multi-select text matches", () => {
    expect(
      mapChoiceText(QUESTION_BY_ID.income_sources, "a job and benefits"),
    ).toEqual(["job", "benefits"]);
    // Single-select questions keep only one answer, even when several
    // options are named — the mapped value must be one of them.
    const ambiguous = mapChoiceText(QUESTION_BY_ID.main_goal, "food and housing");
    expect(ambiguous).not.toBeNull();
    expect(ambiguous).toHaveLength(1);
    expect(["food", "housing"]).toContain(ambiguous?.[0]);
  });

  it("returns null for unrelated or empty text, and for questions without options", () => {
    expect(mapChoiceText(QUESTION_BY_ID.application_role, "")).toBeNull();
    expect(
      mapChoiceText(QUESTION_BY_ID.application_role, "purple elephant toaster"),
    ).toBeNull();
    const textQuestion = QUESTIONS.find((question) => !question.options);
    expect(textQuestion).toBeDefined();
    expect(mapChoiceText(textQuestion, "anything at all")).toBeNull();
  });
});

describe("mapChoiceAnswer — extraction cascade", () => {
  it("accepts an exact option value untouched", () => {
    expect(
      mapChoiceAnswer(QUESTION_BY_ID.application_role, "self", undefined, "ignored"),
    ).toEqual(["self"]);
  });

  it("cascades from a non-option value through the verbatim span to the raw turn text", () => {
    const question = QUESTION_BY_ID.application_role;
    // Value alone maps via its own words.
    expect(mapChoiceAnswer(question, "for myself", undefined, undefined)).toEqual([
      "self",
    ]);
    // Value is garbage; the verbatim span carries the answer.
    expect(
      mapChoiceAnswer(question, "martian", "it's for myself", "whatever"),
    ).toEqual(["self"]);
    // Value and verbatim useless; the raw turn text still maps.
    expect(mapChoiceAnswer(question, "martian", undefined, "It's for myself.")).toEqual([
      "self",
    ]);
    // Nothing maps anywhere.
    expect(mapChoiceAnswer(question, "martian", "zap", "purple elephant")).toBeNull();
  });

  it("keeps only the options an extracted multi-select array actually names", () => {
    expect(
      mapChoiceAnswer(
        QUESTION_BY_ID.income_sources,
        ["job", "bananas"],
        undefined,
        undefined,
      ),
    ).toEqual(["job"]);
    expect(
      mapChoiceAnswer(
        QUESTION_BY_ID.income_sources,
        ["bananas"],
        "money from family",
        "ignored",
      ),
    ).toEqual(["family_friends"]);
  });
});

describe("PROPERTY: the canonicalization layer", () => {
  // Filler wrappers model realistic spoken framing around a known phrase.
  const FILLER_PREFIXES = ["", "it's for ", "i'm applying for ", "well ", "honestly "];
  const FILLER_SUFFIXES = ["", " please", " i think", " for now"];

  it("maps every committed synonym (including filler-wrapped variants) to its own option", () => {
    for (const question of choiceQuestions) {
      for (const option of question.options ?? []) {
        const synonyms = [
          option.label,
          ...(CHOICE_OPTION_SYNONYMS[option.value] ?? []),
        ];
        for (const synonym of synonyms) {
          for (const prefix of FILLER_PREFIXES) {
            for (const suffix of FILLER_SUFFIXES) {
              const text = `${prefix}${synonym}${suffix}`;
              const mapped = mapChoiceText(question, text);
              // Filler wrapping must never kick the mapping onto a
              // DIFFERENT option: the target option is among the matches.
              expect(
                mapped,
                `${question.id}: "${text}" mapped to nothing`,
              ).not.toBeNull();
              expect(
                mapped?.includes(option.value),
                `${question.id}: "${text}" mapped to ${JSON.stringify(mapped)}, expected ${option.value}`,
              ).toBe(true);
            }
          }
        }
      }
    }
  });

  it("never maps arbitrary text to anything but a spec option of the question", () => {
    const arbitraryArb = fc
      .array(fc.constantFrom(..."abcdefgh ijklmn opqrstu vwxyz".split("")), {
        minLength: 0,
        maxLength: 40,
      })
      .map((chars) => chars.join(""));
    for (const question of choiceQuestions) {
      const allowed = optionValues.get(question.id);
      fc.assert(
        fc.property(arbitraryArb, (text) => {
          const mapped = mapChoiceText(question, text);
          if (mapped === null) {
            return;
          }
          expect(mapped.length).toBeGreaterThan(0);
          for (const value of mapped) {
            expect(allowed?.has(value)).toBe(true);
          }
          // Single-select questions answer with at most one option.
          if (question.type === "single_select") {
            expect(mapped).toHaveLength(1);
          }
        }),
      );
    }
  });

  it("is deterministic: mapping the same text twice always agrees", () => {
    const sampleArb = fc.constantFrom(
      "It's for myself",
      "me",
      "a place to stay",
      "not sure",
      "a job and benefits",
      "purple elephant",
      "",
    );
    fc.assert(
      fc.property(
        sampleArb,
        fc.constantFrom(...choiceQuestions.map((question) => question.id)),
        (text, questionId) => {
          const question = QUESTION_BY_ID[questionId];
          expect(mapChoiceText(question, text)).toEqual(
            mapChoiceText(question, text),
          );
        },
      ),
    );
  });
});
