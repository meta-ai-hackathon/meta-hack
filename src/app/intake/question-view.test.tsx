import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ClientAnswer, ClientQuestion } from "../../lib/intake/serialize";
import { QUESTIONS } from "../../lib/intake/spec";
import { ANSWER_STATUS_LABELS, type AnswerStatus } from "../../lib/honesty";
import { QuestionView } from "./question-view";

// Render tests for the intake question view (BN-09, a11y per BN-07): every
// spec question renders its plain-language prompt, help text, options, and an
// explicit "not sure" control; choice questions use fieldset/legend groups;
// scalar questions use the labeled Field; stored answers show the honest
// status badge; pii answers never render a value.

const NOOP = () => undefined;

function renderView(
  question: ClientQuestion,
  props?: Partial<Parameters<typeof QuestionView>[0]>,
): string {
  return renderToStaticMarkup(
    <QuestionView
      question={question}
      value={undefined}
      onValueChange={NOOP}
      bestGuess={false}
      onBestGuessChange={NOOP}
      onNotSure={NOOP}
      onSubmit={NOOP}
      onSkip={NOOP}
      busy={false}
      {...props}
    />,
  );
}

/** Misses collector so a loop failure reports every gap at once. */
function collectMisses(cases: Array<[string, boolean]>): string[] {
  return cases.filter(([, ok]) => !ok).map(([name]) => name);
}

describe("QuestionView across the whole spec", () => {
  it("renders every question with prompt, help, and a not-sure control", () => {
    const misses = collectMisses(
      QUESTIONS.map((question) => {
        const html = renderView(question).replace(/&#x27;/g, "'");
        return [
          question.id,
          html.includes(question.prompt) &&
            html.includes(question.help) &&
            html.includes("I'm not sure"),
        ] as [string, boolean];
      }),
    );
    expect(misses).toEqual([]);
  });

  it("renders spec options for every select question", () => {
    const misses = collectMisses(
      QUESTIONS.filter((question) => question.options).map((question) => {
        const html = renderView(question).replace(/&#x27;/g, "'");
        const allOptions = (question.options ?? []).every((option) =>
          html.includes(option.label),
        );
        return [question.id, allOptions] as [string, boolean];
      }),
    );
    expect(misses).toEqual([]);
  });

  it("marks required questions for screen readers", () => {
    const misses = collectMisses(
      QUESTIONS.map((question) => {
        const html = renderView(question);
        return [
          question.id,
          question.required
            ? html.includes("(required)")
            : !html.includes("(required)"),
        ] as [string, boolean];
      }),
    );
    expect(misses).toEqual([]);
  });
});

describe("choice questions use accessible groups", () => {
  const income = QUESTIONS.find((question) => question.id === "income_sources");
  const role = QUESTIONS.find((question) => question.id === "application_role");

  it("renders single_select as a named radio group", () => {
    const html = renderView(role as ClientQuestion);
    expect(html).toContain("<fieldset");
    expect(html).toContain("<legend");
    expect(html).toContain('type="radio"');
    expect(html).toContain('name=');
  });

  it("renders multi_select as checkboxes", () => {
    const html = renderView(income as ClientQuestion);
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("A job");
    expect(html).toContain("No money coming in right now");
  });

  it("renders boolean questions as Yes/No radios", () => {
    const veteran = QUESTIONS.find((question) => question.id === "veteran_status");
    const html = renderView(veteran as ClientQuestion);
    expect(html).toContain('value="true"');
    expect(html).toContain('value="false"');
  });
});

describe("scalar questions use the labeled Field", () => {
  it("associates label and control for text, number, and date types", () => {
    for (const [id, inputType] of [
      ["county", 'type="text"'],
      ["household_size", 'type="number"'],
      ["date_of_birth", 'type="date"'],
    ] as const) {
      const question = QUESTIONS.find((q) => q.id === id);
      const html = renderView(question as ClientQuestion);
      expect(html, id).toContain(`<label for="intake-${id}"`);
      expect(html, id).toContain(`id="intake-${id}"`);
      expect(html, id).toContain(inputType);
      expect(html, id).toContain(`id="intake-${id}-help"`);
    }
  });
});

describe("stored answers and the honest badge", () => {
  const role = QUESTIONS.find(
    (question) => question.id === "application_role",
  ) as ClientQuestion;
  const county = QUESTIONS.find(
    (question) => question.id === "county",
  ) as ClientQuestion;

  it("shows the plain-language status badge for a stored answer", () => {
    for (const status of Object.keys(ANSWER_STATUS_LABELS) as AnswerStatus[]) {
      const html = renderView(role, { answer: { status } }).replace(
        /&#x27;/g,
        "'",
      );
      expect(html, status).toContain(`data-status="${status}"`);
      expect(html, status).toContain(ANSWER_STATUS_LABELS[status]);
    }
  });

  it("never renders a value for a pii answer and shows the privacy note", () => {
    const html = renderView(county, {
      answer: { status: "known" } as ClientAnswer,
      value: undefined,
    });
    expect(html).toContain('data-status="known"');
    expect(html).toContain("privacy");
    expect(html).not.toContain("value=\"Franklin");
  });

  it("shows the unverified checkbox on every question", () => {
    const misses = collectMisses(
      QUESTIONS.map((question) => {
        const html = renderView(question);
        return [question.id, html.includes("have not verified")] as [string, boolean];
      }),
    );
    expect(misses).toEqual([]);
  });

  it("renders an error with role=alert when given", () => {
    const html = renderView(role, { error: "Pick one to continue." });
    expect(html).toContain('role="alert"');
    expect(html).toContain("Pick one to continue.");
  });

  it("offers the skip control only on optional questions", () => {
    const optional = QUESTIONS.find(
      (question) => !question.required,
    ) as ClientQuestion;
    const required = QUESTIONS.find(
      (question) => question.required,
    ) as ClientQuestion;
    expect(renderView(optional)).toContain("Skip for now");
    expect(renderView(required)).not.toContain("Skip for now");
  });
});
