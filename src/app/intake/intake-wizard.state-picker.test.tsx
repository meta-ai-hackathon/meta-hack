// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ClientQuestion,
  IntakeClientState,
} from "../../lib/intake/client-state";

// HACK-164 (VAL-UX-001), the /intake wizard path: typing the full state
// name into the compact picker and pressing Continue used to show the
// needed-to-continue error, because typing only filtered and the error
// never cleared once a pick landed. The fix commits the typed input on
// the blur a Continue press causes, and clears the error the moment a
// state is picked. Server mode isolates that wiring: the answer saves
// through the existing tri-state route, exactly as before.

const STATE_QUESTION: ClientQuestion = {
  id: "state",
  prompt: "Which state do you live in?",
  help: "We ask because the programs are run state by state.",
  type: "single_select",
  required: true,
  pii: false,
  options: [
    { value: "NC", label: "North Carolina" },
    { value: "SC", label: "South Carolina" },
    { value: "AL", label: "Alabama" },
  ],
};

const NEXT_QUESTION: ClientQuestion = {
  id: "city",
  prompt: "The next question's prompt",
  help: "",
  type: "text",
  required: false,
  pii: false,
};

function stateWith(overrides: Partial<IntakeClientState> = {}): IntakeClientState {
  return {
    questions: [STATE_QUESTION, NEXT_QUESTION],
    answers: {},
    progress: { answered: 0, remaining: 2, total: 2 },
    currentIndex: 0,
    complete: false,
    quickQuestions: {
      programs: [],
      requiredIds: [],
      requiredCount: 0,
      remainingIds: [],
      remainingCount: 0,
      complete: false,
    },
    income: {
      questionIds: [],
      answeredCount: 0,
      confirmedCount: 0,
      totalCount: 0,
      handled: true,
    },
    ...overrides,
  };
}

function answeredState(): IntakeClientState {
  return stateWith({
    answers: { state: { status: "known", value: "NC" } },
    progress: { answered: 1, remaining: 1, total: 2 },
    currentIndex: 1,
  });
}

type Call = { readonly url: string; readonly method: string; readonly body: string | undefined };

let calls: Call[];

/** A fetch that serves the initial state and the answer route, recording every call. */
function stubFetch(plan: { state: IntakeClientState; answer?: IntakeClientState }): void {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({
        url,
        method: init?.method ?? "GET",
        body: init?.body === undefined ? undefined : String(init.body),
      });
      if (url === "/api/intake/state") {
        return new Response(JSON.stringify(plan.state), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url === "/api/intake/answer" && plan.answer) {
        return new Response(JSON.stringify(plan.answer), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected request to ${url}`);
    }),
  );
}

describe("IntakeWizard state picker Continue (HACK-164)", () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    document.body.replaceChildren();
  });

  async function visit(): Promise<{
    container: HTMLElement;
    act: (fn: () => Promise<void> | void) => Promise<void>;
    typeIntoStatePicker: (text: string) => void;
    blurStatePicker: () => void;
    clickContinue: () => Promise<void>;
  }> {
    vi.resetModules();
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { IntakeWizard } = await import("./intake-wizard");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const act = async (fn: () => Promise<void> | void) => {
      await React.act(async () => {
        await fn();
        for (let i = 0; i < 30; i += 1) {
          await new Promise((done) => setTimeout(done, 0));
        }
      });
    };
    await act(() => {
      root.render(React.createElement(IntakeWizard));
    });
    const input = (): HTMLInputElement =>
      container.querySelector('[role="combobox"]') as HTMLInputElement;
    const typeIntoStatePicker = (text: string): void => {
      const target = input();
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(target, text);
      target.dispatchEvent(new Event("input", { bubbles: true }));
    };
    const blurStatePicker = (): void => {
      // The focus loss a Continue press causes (mouse or keyboard).
      input().dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    };
    const clickContinue = async (): Promise<void> => {
      const button = container.querySelector<HTMLButtonElement>("#state-continue");
      if (!button) {
        throw new Error(`no Continue button in: ${container.textContent}`);
      }
      await act(() => button.click());
    };
    return { container, act, typeIntoStatePicker, blurStatePicker, clickContinue };
  }

  it("typing the full state name and pressing Continue picks it, saves it, and never shows the error (HACK-164)", async () => {
    stubFetch({ state: stateWith(), answer: answeredState() });
    const page = await visit();
    await page.act(() => page.typeIntoStatePicker("north carolina"));
    page.blurStatePicker();
    await page.act(async () => undefined);
    await page.clickContinue();
    // The typed name reached the existing tri-state route as the spec's
    // own option value — the same save an Enter pick makes.
    const answerCall = calls.find((call) => call.url === "/api/intake/answer");
    expect(answerCall?.method).toBe("POST");
    expect(JSON.parse(answerCall?.body ?? "{}")).toEqual({
      questionId: "state",
      status: "known",
      value: "NC",
    });
    // The needed-to-continue error never showed.
    expect(page.container.querySelector('[role="alert"]')).toBeNull();
    expect(page.container.textContent).not.toContain(
      "This one is needed to continue",
    );
    // The wizard advanced to the next question.
    expect(
      page.container.querySelector('[data-intake-question="city"]'),
    ).not.toBeNull();
  });

  it("the needed-to-continue error clears as soon as a state is picked (HACK-164)", async () => {
    stubFetch({ state: stateWith(), answer: answeredState() });
    const page = await visit();
    // An empty Continue shows the error first (the unchanged required gate).
    await page.clickContinue();
    expect(page.container.querySelector('[role="alert"]')?.textContent).toContain(
      "This one is needed to continue",
    );
    // Typing the full name and blurring picks it — the error clears right
    // then, not on the next submit.
    await page.act(() => page.typeIntoStatePicker("north carolina"));
    page.blurStatePicker();
    await page.act(async () => undefined);
    expect(page.container.querySelector('[role="alert"]')).toBeNull();
    expect(page.container.textContent).toContain("Picked: North Carolina");
    // And the very same Continue now saves the pick (the demo's repro,
    // continued one step).
    await page.clickContinue();
    const answerCall = calls.find((call) => call.url === "/api/intake/answer");
    expect(answerCall?.method).toBe("POST");
    expect(JSON.parse(answerCall?.body ?? "{}")).toEqual({
      questionId: "state",
      status: "known",
      value: "NC",
    });
  });
});
