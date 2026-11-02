import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { AnswerMap } from "../intake/flow";
import { PII_QUESTION_IDS_IN_SPEC, QUESTION_BY_ID } from "../intake/spec";
import { buildFormFlow, type FormFlowFieldView } from "./flow";
import { getFormRegistryEntry } from "./registry";
import { assertNoPiiValuesInFormReview } from "./review-pii";

// The review payload's pii defense in depth (the DSS-8207 milestone, part
// 2): mirrors the match module's check — a payload about to leave for the
// client carries NO stored value of a pii:true question. The structural
// half (a pii-likely view never carries a value key) plus the needle half
// (no specific pii value appears anywhere in the serialized view, unless
// it rides inside the person's own non-pii display content or is the
// spec's own public option vocabulary).
//
// Property-based per the repo skill: the soundness property runs the REAL
// buildFormFlow + check pair over arbitrary session answer maps; the bite
// property proves any specific private value echoed into a view is
// flagged, wherever it lands.

const DSS_ENTRY = getFormRegistryEntry("dss-8207");

function fieldView(overrides: Partial<FormFlowFieldView>): FormFlowFieldView {
  return {
    fieldName: "SomeField",
    type: "text",
    question: "What is this?",
    state: "prefilled",
    specQuestionId: null,
    required: false,
    piiLikely: false,
    ...overrides,
  };
}

const cleanFields: readonly FormFlowFieldView[] = [
  fieldView({
    fieldName: "Text5",
    question: "Which state is the household's residence in?",
    specQuestionId: "state",
    value: "NC",
  }),
  fieldView({
    fieldName: "Birth DateSelf",
    question: "What is your date of birth?",
    specQuestionId: "date_of_birth",
    piiLikely: true,
    status: "known",
  }),
];

// The free-text pii values the arbitraries use: realistic specific values
// (dates, phones, emails, narratives) built by construction — never
// filtered, so the shrinker has a clean path.
const phoneArb = fc.nat({ max: 9999 }).map(
  (line) => `704-555-${String(line).padStart(4, "0")}`,
);
const emailArb = fc.nat({ max: 9999 }).map((n) => `user${n}@example.org`);
const narrativeArb = fc
  .tuple(fc.nat({ max: 9999 }), fc.nat({ max: 99 }))
  .map(([n, m]) => `apartment ${n} follow-up ${m}`);

const answerValueArb: fc.Arbitrary<unknown> = fc.oneof(
  phoneArb,
  emailArb,
  narrativeArb,
  fc.constant("1988-04-12"),
);

/** A canonical value for one spec question, by its type. */
function valueArbFor(questionId: string): fc.Arbitrary<unknown> {
  const question = QUESTION_BY_ID[questionId]!;
  switch (question.type) {
    case "boolean":
      return fc.boolean();
    case "number":
      return fc.nat({ max: 4000 });
    case "date":
      return fc.constant("1988-04-12");
    case "single_select": {
      const values = (question.options ?? []).map((option) => option.value);
      return fc.constantFrom(...values);
    }
    case "multi_select": {
      // Flat mask-based subsets (the fc.subarray-in-.chain shrinker
      // crash); at least one option, at most three, in spec order.
      const values = (question.options ?? []).map((option) => option.value);
      return fc
        .array(fc.boolean(), { minLength: values.length, maxLength: values.length })
        .map((mask) => {
          const picked = values.filter((_, index) => mask[index]).slice(0, 3);
          return picked.length > 0 ? picked : [values[0]!];
        });
    }
    default:
      return narrativeArb;
  }
}

/**
 * An arbitrary answer map over a random sample of the spec's questions:
 * pii answers carry specific free-form values; non-pii answers carry
 * canonical values of their own types. Flat mask-based picks (never
 * fc.subarray inside a chain), so the shrinker never crashes.
 */
function answersArb(): fc.Arbitrary<AnswerMap> {
  const piiIds = PII_QUESTION_IDS_IN_SPEC;
  const nonPiiIds = Object.keys(QUESTION_BY_ID).filter(
    (id) => !PII_QUESTION_IDS_IN_SPEC.includes(id),
  );
  return fc
    .record({
      piiMask: fc.array(fc.boolean(), {
        minLength: piiIds.length,
        maxLength: piiIds.length,
      }),
      nonPiiMask: fc.array(fc.boolean(), {
        minLength: nonPiiIds.length,
        maxLength: nonPiiIds.length,
      }),
    })
    .chain(({ piiMask, nonPiiMask }) => {
      const pickedPii = piiIds.filter((_, index) => piiMask[index]);
      const pickedNonPii = nonPiiIds.filter((_, index) => nonPiiMask[index]);
      return fc
        .tuple(
          ...pickedPii.map((id) => valueArbFor(id)),
          ...pickedNonPii.map((id) => valueArbFor(id)),
        )
        .map((values) => {
          const map: Record<string, { status: "known"; value: unknown }> = {};
          pickedPii.forEach((id, index) => {
            map[id] = { status: "known", value: values[index] };
          });
          pickedNonPii.forEach((id, offset) => {
            map[id] = {
              status: "known",
              value: values[pickedPii.length + offset],
            };
          });
          return map as AnswerMap;
        });
    });
}

describe("assertNoPiiValuesInFormReview — properties", () => {
  it("the build+check pair is sound: the route-shaped payload never throws, over arbitrary sessions", () => {
    let cases = 0;
    fc.assert(
      fc.property(answersArb(), (answers) => {
        cases += 1;
        const view = buildFormFlow(DSS_ENTRY, answers);
        // The pair the review route runs: build, then check. Sound by
        // construction — pii values are structurally omitted, and any
        // residue the display path produces is the person's own non-pii
        // content or the spec's public vocabulary.
        expect(() =>
          assertNoPiiValuesInFormReview(view.fields, answers, DSS_ENTRY),
        ).not.toThrow();
        // Every pii-linked view in the built payload carries no value key.
        for (const field of view.fields) {
          if (field.piiLikely) {
            expect("value" in field, field.fieldName).toBe(false);
          }
        }
      }),
      { numRuns: 60 },
    );
    expect(cases).toBeGreaterThan(0);
  });

  it("any specific private value echoed into a view is flagged, wherever it lands", () => {
    fc.assert(
      fc.property(
        answerValueArb,
        fc.constantFrom("value", "question", "fieldName"),
        (leaked, where) => {
          const base = fieldView({
            fieldName: "SomeField",
            question: "What is this?",
          });
          const view =
            where === "value"
              ? ({ ...base, value: leaked } as FormFlowFieldView)
              : where === "question"
                ? { ...base, question: `Echo: ${leaked}` }
                : ({ ...base, fieldName: leaked } as FormFlowFieldView);
          const answers: AnswerMap = {
            phone_contact: { status: "known", value: leaked },
          };
          expect(() =>
            assertNoPiiValuesInFormReview([view], answers, DSS_ENTRY),
          ).toThrow("private answer value");
        },
      ),
      { numRuns: 40 },
    );
  });

  it("the check is pure: same inputs, same outcome, twice", () => {
    fc.assert(
      fc.property(answersArb(), (answers) => {
        const view = buildFormFlow(DSS_ENTRY, answers);
        const run = (): "ok" | "threw" => {
          try {
            assertNoPiiValuesInFormReview(view.fields, answers, DSS_ENTRY);
            return "ok";
          } catch {
            return "threw";
          }
        };
        expect(run()).toBe(run());
      }),
      { numRuns: 25 },
    );
  });
});

describe("assertNoPiiValuesInFormReview — directed cases", () => {
  it("passes a payload whose pii views carry status only", () => {
    const answers: AnswerMap = {
      date_of_birth: { status: "known", value: "1988-04-12" },
      state: { status: "known", value: "NC" },
    };
    expect(() =>
      assertNoPiiValuesInFormReview(cleanFields, answers, DSS_ENTRY),
    ).not.toThrow();
  });

  it("bites when a pii-likely view structurally carries a value", () => {
    const answers: AnswerMap = {
      date_of_birth: { status: "known", value: "1988-04-12" },
    };
    const leaked = [
      fieldView({
        fieldName: "Birth DateSelf",
        question: "What is your date of birth?",
        specQuestionId: "date_of_birth",
        piiLikely: true,
        // The bug the boundary exists for: the value key on a pii view.
        value: "1988-04-12",
      } as FormFlowFieldView & { value: string }),
    ];
    expect(() => assertNoPiiValuesInFormReview(leaked, answers, DSS_ENTRY)).toThrow(
      "private answer value",
    );
  });

  it("bites when a specific pii value is echoed into the view copy", () => {
    const answers: AnswerMap = {
      phone_contact: { status: "known", value: "704-555-0134" },
    };
    // The leak rides the registry question text — a place user content
    // never belongs; the excusal rules never cover it.
    const echoed = [
      fieldView({
        fieldName: "Message Number",
        question: "Call 704-555-0134?",
        state: "asked",
        piiLikely: true,
      }),
    ];
    expect(() => assertNoPiiValuesInFormReview(echoed, answers, DSS_ENTRY)).toThrow(
      "private answer value",
    );
  });

  it("excuses a value that equals a non-pii answer's display content", () => {
    const answers: AnswerMap = {
      // The same string is BOTH answers: the pii question's value is
      // indistinguishable from the display content the non-pii answer
      // legitimately renders — not a disclosure. (The spec has no non-pii
      // free-text question, so the carrier id here is synthetic on the
      // non-pii side; the pii side is the real mailing-situation question
      // whose option value is "shelter".)
      demo_non_pii_note: { status: "known", value: "shelter" },
      mailing_situation: { status: "known", value: "shelter" },
    };
    const displayed = [
      fieldView({
        fieldName: "DemoNote",
        question: "What is this note?",
        value: "shelter",
      }),
    ];
    expect(() =>
      assertNoPiiValuesInFormReview(displayed, answers, DSS_ENTRY),
    ).not.toThrow();
  });

  it("skips short digit-only answers that cannot diagnose a leak", () => {
    const answers: AnswerMap = {
      // A legal pii number answer ("0" hours): the view's own structural
      // numbers (field names, printed years) would over-match a one-digit
      // needle, so digits-only needles under five digits never fire.
      wr_work_activity_hours: { status: "known", value: 0 },
      mailing_situation: { status: "known", value: "shelter" },
    };
    expect(() =>
      assertNoPiiValuesInFormReview(cleanFields, answers, DSS_ENTRY),
    ).not.toThrow();
  });

  it("excuses the spec's own public option vocabulary", () => {
    const answers: AnswerMap = {
      // A pii free-text answer that happens to equal a spec option label
      // ("Staying with family or friends" — the housing question's own
      // public vocabulary) the display path can render.
      goal_detail: { status: "known", value: "Staying with family or friends" },
      housing_status: { status: "known", value: "staying_with_others" },
    };
    const displayed = [
      fieldView({
        fieldName: "DemoNote",
        question: "Which best describes the household's housing?",
        value: "Staying with family or friends",
      }),
    ];
    expect(() =>
      assertNoPiiValuesInFormReview(displayed, answers, DSS_ENTRY),
    ).not.toThrow();
  });

  it("skips generic values that would over-match ordinary copy", () => {
    const answers: AnswerMap = {
      disability_status: { status: "known", value: "yes" },
    };
    expect(() =>
      assertNoPiiValuesInFormReview(cleanFields, answers, DSS_ENTRY),
    ).not.toThrow();
  });

  it("passes when the pii question has no stored value", () => {
    const answers: AnswerMap = {
      date_of_birth: { status: "unknown" },
    };
    expect(() =>
      assertNoPiiValuesInFormReview(cleanFields, answers, DSS_ENTRY),
    ).not.toThrow();
  });

  it("scans the extra serialized parts (toResolve, steps) too, not just the fields", () => {
    const answers: AnswerMap = {
      phone_contact: { status: "known", value: "704-555-0134" },
    };
    // The route serializes the still-needed questions and the handoff
    // steps alongside the fields; a future change routing user content
    // into either must bite the same way a field echo does.
    expect(() =>
      assertNoPiiValuesInFormReview(cleanFields, answers, DSS_ENTRY, [
        [{ fieldId: "CallBack", question: "Call 704-555-0134?" }],
      ]),
    ).toThrow("private answer value");
    // And the real payload shape (registry text only) passes.
    expect(() =>
      assertNoPiiValuesInFormReview(cleanFields, answers, DSS_ENTRY, [
        [
          {
            fieldId: "Message Number",
            question: "What is your phone number?",
          },
        ],
        [{ title: "Send it yourself", detail: "You submit the form." }],
      ]),
    ).not.toThrow();
  });
});
