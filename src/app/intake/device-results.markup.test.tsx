// @vitest-environment jsdom
import fc from "fast-check";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AnswerStatus } from "../../lib/honesty";
import { findBannedClaims } from "../../lib/honesty";
import {
  EMPTY_CLIENT_ANSWERS,
  saveClientAnswer,
  type ClientAnswerProvenance,
  type ClientAnswerState,
} from "../../lib/intake/client-store";
import { deviceFormReview, deviceMatch } from "../../lib/intake/device-form";
import { QUESTIONS, type Question } from "../../lib/intake/spec";
import { KB_ENTRIES } from "../../lib/kb";
import { DEVICE_RESULTS_COPY, DeviceResults } from "./device-results";

// The end of /intake as it renders for any answers on the device (HACK-115).
// The match cards, the form review, and the handoff all come from the
// committed knowledge base and form registry, so every rendering must keep
// the honesty rules (no banned claim anywhere on the screen), keep private
// answers off the screen, and keep a heading outline a screen reader can
// follow. The DOM test in device-results.test.tsx drives one person through
// the page; these properties cover every answer set.

/** A private value no committed copy can contain, so any appearance is the answer itself. */
const privateText = fc.stringMatching(/^PRIV[A-Z0-9]{8}$/);

/** Dates before 2000: the knowledge base and the form registry print only 2020s dates. */
const privateDate = fc
  .date({ min: new Date("1930-01-01"), max: new Date("1999-12-31"), noInvalidDate: true })
  .map((date) => date.toISOString().slice(0, 10));

/**
 * The answers the knowledge base's match signals look for, by question
 * (the pilot's state, for one). Drawn often, so the cards render in many
 * runs instead of the few where a uniform pick happens to land on them.
 */
const SIGNAL_VALUES: ReadonlyMap<string, readonly string[]> = new Map(
  KB_ENTRIES.flatMap((entry) => entry.facts.match_signals?.items ?? [])
    .filter((signal) => signal.values && signal.values.length > 0)
    .map((signal) => [signal.questionId, signal.values ?? []]),
);

/** A canonical value for `question`, in the shape the device store keeps. */
function valueFor(question: Question): fc.Arbitrary<unknown> {
  const options = (question.options ?? []).map((option) => option.value);
  const wanted = SIGNAL_VALUES.get(question.id);
  switch (question.type) {
    case "single_select":
      return wanted
        ? fc.oneof(
            { weight: 3, arbitrary: fc.constantFrom(...wanted) },
            { weight: 1, arbitrary: fc.constantFrom(...options) },
          )
        : fc.constantFrom(...options);
    case "multi_select":
      return fc.uniqueArray(fc.constantFrom(...options), { minLength: 1, maxLength: 3 });
    case "number":
      return fc.integer({ min: 0, max: 5000 });
    case "boolean":
      return fc.boolean();
    case "date":
      return privateDate;
    case "text":
    case "address":
      return privateText;
  }
}

interface DrawnAnswer {
  readonly status: AnswerStatus;
  readonly provenance: ClientAnswerProvenance;
  readonly value: unknown;
}

function answerFor(question: Question): fc.Arbitrary<DrawnAnswer> {
  return fc
    .tuple(
      fc.constantFrom<AnswerStatus>("known", "unknown", "unverified"),
      fc.constantFrom<ClientAnswerProvenance>("user_supplied", "ai_drafted", "source_verified"),
      valueFor(question),
    )
    .map(([status, provenance, value]) => ({
      status,
      // The store pairs a drafted answer only with "not verified".
      provenance: provenance === "ai_drafted" && status !== "unverified" ? "user_supplied" : provenance,
      value: status === "unknown" ? null : value,
    }));
}

/** Any subset of the spec answered on the device, every status represented. */
const deviceAnswersArb: fc.Arbitrary<ClientAnswerState> = (
  fc.record(
    Object.fromEntries(QUESTIONS.map((question) => [question.id, answerFor(question)])),
    { requiredKeys: [] },
  ) as fc.Arbitrary<Readonly<Record<string, DrawnAnswer>>>
).map((answers) => {
  let state = EMPTY_CLIENT_ANSWERS;
  for (const [questionId, answer] of Object.entries(answers)) {
    state = saveClientAnswer(state, { questionId, ...answer });
  }
  return state;
});

/** The private answers drawn above, in every form the page could print them. */
function privateValuesIn(state: ClientAnswerState): string[] {
  const values: string[] = [];
  for (const question of QUESTIONS) {
    const value = state[question.id]?.value;
    if (!question.pii || typeof value !== "string") {
      continue;
    }
    if (question.type === "date") {
      const [year, month, day] = value.split("-");
      values.push(value, `${month}/${day}/${year}`);
    } else if (question.type === "text" || question.type === "address") {
      values.push(value);
    }
  }
  return values;
}

function render(state: ClientAnswerState): { html: string; root: HTMLElement } {
  const html = renderToStaticMarkup(<DeviceResults answers={state} onAnswer={() => undefined} />);
  const root = document.createElement("div");
  root.innerHTML = html;
  return { html, root };
}

describe("the device results, for any answers on the device", () => {
  it("are drawn with match cards on screen often (non-vacuous)", () => {
    const states = fc.sample(deviceAnswersArb, { numRuns: 200, seed: 115 });
    const withCards = states.filter((state) => deviceMatch(state).matches.length > 0);
    expect(withCards.length).toBeGreaterThan(20);
    expect(states.length - withCards.length).toBeGreaterThan(20);
  });

  it("carry no banned claim anywhere on the screen", () => {
    fc.assert(
      fc.property(deviceAnswersArb, (state) => {
        const { root } = render(state);
        expect(findBannedClaims(root.textContent ?? "")).toEqual([]);
      }),
      { numRuns: 60 },
    );
  });

  it("never put a private answer on the screen, in the text or in an attribute", () => {
    fc.assert(
      fc.property(deviceAnswersArb, (state) => {
        const { html, root } = render(state);
        const attributes = [...root.querySelectorAll("*")].flatMap((element) =>
          [...element.attributes].map((attribute) => attribute.value),
        );
        const shown = [root.textContent ?? "", ...attributes].join("\n");
        for (const value of privateValuesIn(state)) {
          expect(shown, `the screen shows ${value}`).not.toContain(value);
          expect(html, `the markup carries ${value}`).not.toContain(value);
        }
      }),
      { numRuns: 60 },
    );
  });

  it("label every typed answer and describe it with the note on how it's kept", () => {
    fc.assert(
      fc.property(deviceAnswersArb, (state) => {
        const { root } = render(state);
        const inputs = [...root.querySelectorAll<HTMLInputElement>("[data-review-fields] input")];
        expect(inputs.length).toBeGreaterThan(0);
        for (const input of inputs) {
          const label = root.querySelector(`label[for="${input.id}"]`);
          const item = input.closest("[data-review-field]");
          expect(label?.textContent, input.id).toBe(item?.querySelector("label")?.textContent);
          const describedBy = input.getAttribute("aria-describedby") ?? "";
          const note = describedBy === "" ? null : root.querySelector(`[id="${describedBy}"]`);
          expect(note?.textContent, input.id).toBe(DEVICE_RESULTS_COPY.typedNote);
          expect(item?.contains(note ?? null), input.id).toBe(true);
        }
      }),
      { numRuns: 60 },
    );
  });

  it("keep typed answers out of the browser's spellcheck and saved form entries", () => {
    // Enhanced spellcheck in Chrome and Edge sends the text of a field to
    // the vendor's servers, and these fields take names, addresses, and the
    // Social Security number. A field marked spellcheck="false" is never sent.
    fc.assert(
      fc.property(deviceAnswersArb, (state) => {
        const { root } = render(state);
        for (const input of root.querySelectorAll<HTMLInputElement>("[data-review-fields] input")) {
          expect(input.getAttribute("spellcheck"), input.id).toBe("false");
          expect(input.getAttribute("autocomplete"), input.id).toBe("off");
        }
      }),
      { numRuns: 30 },
    );
  });

  it("describe each answer-this-question button with its own field's question", () => {
    fc.assert(
      fc.property(deviceAnswersArb, (state) => {
        const { root } = render(state);
        const review = deviceFormReview(state);
        const buttons = [...root.querySelectorAll<HTMLButtonElement>("[data-review-fields] button")];
        const asked = review.fields.filter(
          (field) => field.state === "asked" && field.specQuestionId !== null,
        );
        expect(buttons).toHaveLength(asked.length);
        for (const button of buttons) {
          expect(button.textContent).toBe(DEVICE_RESULTS_COPY.answerAbove);
          const item = button.closest("[data-review-field]");
          const field = review.fields.find(
            (candidate) => candidate.fieldName === item?.getAttribute("data-review-field"),
          );
          const describedBy = button.getAttribute("aria-describedby") ?? "";
          const question = describedBy === "" ? null : root.querySelector(`[id="${describedBy}"]`);
          expect(question?.textContent).toBe(field?.question);
          expect(item?.contains(question ?? null)).toBe(true);
        }
      }),
      { numRuns: 60 },
    );
  });

  it("keep a heading outline that never skips a level", () => {
    fc.assert(
      fc.property(deviceAnswersArb, (state) => {
        const { root } = render(state);
        const levels = [...root.querySelectorAll("h1, h2, h3, h4, h5, h6")].map((heading) =>
          Number(heading.tagName.slice(1)),
        );
        expect(levels[0]).toBe(2);
        for (let index = 1; index < levels.length; index += 1) {
          expect(levels[index]).toBeLessThanOrEqual(levels[index - 1] + 1);
        }
      }),
      { numRuns: 60 },
    );
  });
});
