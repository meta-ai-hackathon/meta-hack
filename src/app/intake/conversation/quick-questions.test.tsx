// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findBannedClaims } from "../../../lib/honesty";
import type {
  ClientQuestion,
  IntakeClientState,
} from "../../../lib/intake/serialize";
import {
  NONE_OPTION_VALUE,
  SENSITIVE_QUESTION_IDS,
  QuickQuestionsStage,
  counterCopy,
  groupRemainingQuestions,
  toggleNoneExclusive,
} from "./quick-questions";

// The quick-questions stage (VAL-QQ-002..006, 012, 013): the engine's
// computed still-to-ask set rendered as grouped question cards between
// the entry stage and the talk stage. The honest counter ("N questions
// instead of M") renders the requirements engine's live numbers; answers
// submit through the EXISTING tri-state path (POST /api/intake/answer);
// sensitive questions render LAST, optional, with a why-we-ask note and
// a skip affordance that never blocks progress.

function question(overrides: Partial<ClientQuestion> & { id: string }): ClientQuestion {
  return {
    prompt: `The ${overrides.id} prompt`,
    help: "",
    type: "text",
    required: true,
    pii: false,
    ...overrides,
  };
}

const INCOME_SOURCES: ClientQuestion = question({
  id: "income_sources",
  prompt: "Where does money come from for your household?",
  type: "multi_select",
  options: [
    { value: "job", label: "A job" },
    { value: "benefits", label: "Benefits like disability or retirement checks" },
    { value: "none", label: "No money coming in right now" },
  ],
});

const MAIN_GOAL: ClientQuestion = question({
  id: "main_goal",
  prompt: "What kind of help are you looking for right now?",
  type: "single_select",
  options: [
    { value: "food", label: "Food" },
    { value: "healthcare", label: "Healthcare" },
  ],
});

const HOUSEHOLD_SIZE: ClientQuestion = question({
  id: "household_size",
  prompt: "How many people do you buy and share food with?",
  type: "number",
});

const CITIZENSHIP: ClientQuestion = question({
  id: "citizenship_status",
  prompt: "How would you describe your citizenship or immigration status?",
  type: "single_select",
  required: false,
  pii: true,
  options: [
    { value: "us_citizen", label: "US citizen" },
    { value: "not_sure", label: "Not sure" },
  ],
});

const DISABILITY: ClientQuestion = question({
  id: "disability_status",
  prompt: "Does anyone in your household have a disability or a health condition that limits daily life?",
  type: "single_select",
  required: false,
  pii: true,
  options: [
    { value: "yes", label: "Yes" },
    { value: "no", label: "No" },
  ],
});

const ALL_QUESTIONS = [INCOME_SOURCES, MAIN_GOAL, HOUSEHOLD_SIZE, CITIZENSHIP, DISABILITY];

// The income gate's block for this fixture set: income_sources is the one
// income question present, unanswered — the income stage owns it, so the
// gate is closed (handled false) until the income stage's own paths save.
const INCOME_BLOCK = {
  questionIds: ["income_sources"],
  answeredCount: 0,
  confirmedCount: 0,
  totalCount: 1,
  handled: false,
};

function stageState(overrides?: Partial<IntakeClientState>): IntakeClientState {
  return {
    questions: ALL_QUESTIONS,
    answers: {},
    progress: { answered: 0, remaining: ALL_QUESTIONS.length, total: ALL_QUESTIONS.length },
    currentIndex: 0,
    complete: false,
    quickQuestions: {
      programs: ["nc_medicaid"],
      requiredIds: ALL_QUESTIONS.map((q) => q.id),
      requiredCount: ALL_QUESTIONS.length,
      remainingIds: ALL_QUESTIONS.map((q) => q.id),
      remainingCount: ALL_QUESTIONS.length,
      complete: false,
    },
    income: INCOME_BLOCK,
    ...overrides,
  };
}

function freshStateAfterSave(): IntakeClientState {
  // What POST /api/intake/answer returns: the engine's recomputed state
  // with one question answered (ask-once — it leaves the stage).
  return stageState({
    answers: { main_goal: { status: "known", value: "food" } },
    progress: { answered: 1, remaining: 4, total: 5 },
    currentIndex: 1,
    quickQuestions: {
      programs: ["nc_medicaid"],
      requiredIds: ALL_QUESTIONS.map((q) => q.id),
      requiredCount: 5,
      remainingIds: ["income_sources", "household_size", "citizenship_status", "disability_status"],
      remainingCount: 4,
      complete: false,
    },
  });
}

describe("the None-of-these exclusion (VAL-QQ-005)", () => {
  it("selecting none clears every other selection", () => {
    expect(toggleNoneExclusive(["job", "benefits"], "none")).toEqual(["none"]);
  });
  it("selecting a real option clears none", () => {
    expect(toggleNoneExclusive(["none"], "job")).toEqual(["job"]);
  });
  it("toggles a real option without disturbing the others", () => {
    expect(toggleNoneExclusive(["job", "benefits"], "job")).toEqual(["benefits"]);
    expect(toggleNoneExclusive(["job"], "benefits")).toEqual(["job", "benefits"]);
  });
  it("deselecting none clears it cleanly", () => {
    expect(toggleNoneExclusive(["none"], "none")).toEqual([]);
  });
  it("accepts a fresh (undefined) draft", () => {
    expect(toggleNoneExclusive(undefined, "job")).toEqual(["job"]);
  });
});

describe("the honest counter copy (VAL-QQ-004)", () => {
  it("renders the engine's N of M, plural", () => {
    expect(counterCopy(5, 34)).toBe("5 questions instead of 34");
  });
  it("renders the singular honestly", () => {
    expect(counterCopy(1, 34)).toBe("1 question instead of 34");
  });
});

describe("grouping the remaining questions", () => {
  it("buckets the remaining set into topical groups in stage order, sensitive LAST (VAL-QQ-006)", () => {
    const groups = groupRemainingQuestions(stageState());
    expect(groups[groups.length - 1]?.sensitive).toBe(true);
    expect(groups.slice(0, -1).every((group) => !group.sensitive)).toBe(true);
    // The sensitive ids are exactly the owner-named set: citizenship /
    // immigration status and disability.
    expect(SENSITIVE_QUESTION_IDS).toEqual(["citizenship_status", "disability_status"]);
    const sensitive = groups[groups.length - 1]!;
    expect(sensitive.questions.map((q) => q.id)).toEqual([
      "citizenship_status",
      "disability_status",
    ]);
    // Non-sensitive cards never render after the sensitive group.
    const sensitiveFirstIndex = sensitive.questions[0]!.id;
    const flat = groups.flatMap((group) => group.questions.map((q) => q.id));
    expect(flat.lastIndexOf(sensitiveFirstIndex)).toBe(flat.length - 2);
  });
  it("keeps only questions present in the state's questions list — nothing fabricated", () => {
    const state = stageState({
      quickQuestions: {
        programs: ["nc_medicaid"],
        requiredIds: ["income_sources", "ghost_question"],
        requiredCount: 2,
        remainingIds: ["income_sources", "ghost_question"],
        remainingCount: 2,
        complete: false,
      },
    });
    const flat = groupRemainingQuestions(state).flatMap((group) =>
      group.questions.map((q) => q.id),
    );
    expect(flat).toEqual(["income_sources"]);
  });
});

describe("the quick-questions stage component", () => {
  let posts: { body: string }[] = [];
  let onStateChange: ReturnType<typeof vi.fn>;
  let onNotice: ReturnType<typeof vi.fn>;
  let onToTalk: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    posts = [];
    onStateChange = vi.fn();
    onNotice = vi.fn();
    onToTalk = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        posts.push({ body: String(init?.body) });
        return new Response(JSON.stringify(freshStateAfterSave()), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  async function renderStage(state: IntakeClientState = stageState()): Promise<{
    container: HTMLElement;
    act: (fn: () => Promise<void> | void) => Promise<void>;
  }> {
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const act = async (fn: () => Promise<void> | void) => {
      await React.act(async () => {
        await fn();
        for (let i = 0; i < 6; i += 1) {
          await new Promise((done) => setTimeout(done, 0));
        }
      });
    };
    await act(async () => {
      root.render(
        React.createElement(QuickQuestionsStage, {
          state,
          onStateChange: (next: IntakeClientState) => onStateChange(next),
          onNotice: (message: string) => onNotice(message),
          onToTalk: () => onToTalk(),
        }),
      );
    });
    await act(async () => undefined);
    return { container, act };
  }

  const q = (container: HTMLElement, attr: string): Element | null =>
    container.querySelector(`[data-${attr}]`);

  it("renders one card per remaining question, grouped, with the engine's counter live (VAL-QQ-004, VAL-QQ-012)", async () => {
    const { container } = await renderStage();
    expect(q(container, "quick-questions-stage")).not.toBeNull();
    expect(q(container, "qq-counter")).not.toBeNull();
    expect(q(container, "qq-counter")?.getAttribute("aria-live")).toBe("polite");
    expect(q(container, "qq-counter")?.textContent).toContain(
      "5 questions instead of 5",
    );
    const cards = container.querySelectorAll("[data-qq-card]");
    expect(cards).toHaveLength(5);
    // The heading is an H2 — the page's single H1 stays the page's.
    expect(container.querySelectorAll("h1")).toHaveLength(0);
    expect(q(container, "qq-heading")?.tagName).toBe("H2");
  });

  it("renders the multi-select card as a checkbox group with 44px rows (VAL-QQ-005, VAL-QQ-012)", async () => {
    const { container } = await renderStage();
    const card = q(container, 'qq-card="income_sources"');
    expect(card).not.toBeNull();
    const checkboxes = card?.querySelectorAll('input[type="checkbox"]');
    expect(checkboxes?.length).toBe(3);
    // 44px+ touch targets: every option row carries the min-height pin.
    card?.querySelectorAll("label").forEach((label) => {
      expect(label.className).toContain("min-h-11");
    });
  });

  it("enforces None-of-these exclusion in the UI before submission (VAL-QQ-005)", async () => {
    const { container, act } = await renderStage();
    const card = q(container, 'qq-card="income_sources"')!;
    const checkbox = (value: string): HTMLInputElement =>
      card.querySelector(`input[value="${value}"]`) as HTMLInputElement;
    await act(async () => {
      checkbox("job").click();
      checkbox("benefits").click();
    });
    expect(checkbox("job").checked).toBe(true);
    expect(checkbox("benefits").checked).toBe(true);
    // Selecting none deselects the others…
    await act(async () => {
      checkbox("none").click();
    });
    expect(checkbox("none").checked).toBe(true);
    expect(checkbox("job").checked).toBe(false);
    expect(checkbox("benefits").checked).toBe(false);
    // …and picking a real option again clears none.
    await act(async () => {
      checkbox("job").click();
    });
    expect(checkbox("none").checked).toBe(false);
    expect(checkbox("job").checked).toBe(true);
  });

  it("submits a multi-value selection as ONE multi_select answer through the existing tri-state path (VAL-QQ-005)", async () => {
    const { container, act } = await renderStage();
    const card = q(container, 'qq-card="income_sources"')!;
    await act(async () => {
      (card.querySelector('input[value="job"]') as HTMLInputElement).click();
      (card.querySelector('input[value="benefits"]') as HTMLInputElement).click();
    });
    await act(async () => {
      q(container, 'qq-save="income_sources"')?.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    expect(posts).toHaveLength(1);
    const body = JSON.parse(posts[0]!.body);
    expect(body).toMatchObject({
      questionId: "income_sources",
      status: "known",
      value: ["job", "benefits"],
    });
    // The parent applies the route's fresh state (the card then leaves the
    // stage — ask-once) and the counter is re-rendered from it.
    expect(onStateChange).toHaveBeenCalledWith(freshStateAfterSave());
  });

  it("submits a single-select and a number answer through the same path", async () => {
    const { container, act } = await renderStage();
    await act(async () => {
      (
        q(container, 'qq-card="main_goal"')!.querySelector(
          'input[value="food"]',
        ) as HTMLInputElement
      ).click();
    });
    await act(async () => {
      q(container, 'qq-save="main_goal"')?.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    const goalBody = JSON.parse(posts[0]!.body);
    expect(goalBody).toMatchObject({
      questionId: "main_goal",
      status: "known",
      value: "food",
    });
    await act(async () => {
      const input = q(container, 'qq-card="household_size"')!.querySelector(
        "input",
      ) as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(input, "3");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      q(container, 'qq-save="household_size"')?.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    expect(JSON.parse(posts[1]!.body)).toMatchObject({
      questionId: "household_size",
      status: "known",
      value: 3,
    });
  });

  it("carries the tri-state honesty affordances: I'm not sure submits unknown (VAL-QQ-007)", async () => {
    const { container, act } = await renderStage();
    await act(async () => {
      q(container, 'qq-not-sure="main_goal"')?.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    expect(JSON.parse(posts[0]!.body)).toMatchObject({
      questionId: "main_goal",
      status: "unknown",
    });
  });

  it("renders sensitive questions LAST with a why-we-ask note, optional, and skippable — and skipping never blocks (VAL-QQ-006)", async () => {
    const { container, act } = await renderStage();
    const cards = Array.from(container.querySelectorAll("[data-qq-card]"));
    const ids = cards.map((card) => card.getAttribute("data-qq-card"));
    // Sensitive cards render after every non-sensitive card.
    expect(ids.slice(-2)).toEqual(["citizenship_status", "disability_status"]);
    // Each sensitive card carries a visible why-we-ask note and the
    // optional mark.
    for (const id of ["citizenship_status", "disability_status"]) {
      const note = q(container, `qq-why="${id}"`);
      expect(note).not.toBeNull();
      expect(note?.textContent).toContain("Why we ask");
      const card = q(container, `qq-card="${id}"`);
      expect(card?.getAttribute("data-qq-optional")).toBe("true");
      expect(q(container, `qq-skip="${id}"`)).not.toBeNull();
    }
    // Skipping writes NOTHING (the conversation can pick the question up)
    // and never blocks: the calm CTA stays available.
    posts = [];
    await act(async () => {
      q(container, 'qq-skip="citizenship_status"')?.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    expect(posts).toHaveLength(0);
    expect(q(container, 'qq-card="citizenship_status"')?.getAttribute("data-qq-skipped")).toBe("true");
    expect(q(container, "qq-to-talk")).not.toBeNull();
    await act(async () => {
      q(container, "qq-to-talk")?.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    expect(onToTalk).toHaveBeenCalledTimes(1);
  });

  it("offers the skip affordance on every optional card but never on a required one (VAL-QQ-006)", async () => {
    const { container } = await renderStage();
    expect(q(container, 'qq-skip="citizenship_status"')).not.toBeNull();
    expect(q(container, 'qq-skip="disability_status"')).not.toBeNull();
    // Required cards: no skip affordance — the spec marks them needed.
    expect(q(container, 'qq-skip="main_goal"')).toBeNull();
    expect(q(container, 'qq-skip="income_sources"')).toBeNull();
  });

  it("shows a card error on an empty required save — never a fake save", async () => {
    const { container, act } = await renderStage();
    posts = [];
    await act(async () => {
      q(container, 'qq-save="main_goal"')?.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    expect(posts).toHaveLength(0);
    expect(q(container, 'qq-error="main_goal"')).not.toBeNull();
  });

  it("the calm CTA to talk is present with its honest caption", async () => {
    const { container } = await renderStage();
    const cta = q(container, "qq-to-talk");
    expect(cta).not.toBeNull();
    expect(cta?.textContent).toContain("Let's talk");
    expect(container.textContent).toContain("conversation");
  });

  it("keeps every visible string banned-claims clean, and a seeded counter-phrased promise provably bites (VAL-QQ-013)", async () => {
    const { container } = await renderStage();
    expect(findBannedClaims(container.textContent ?? "")).toEqual([]);
    // The seeded fixture: an eligibility promise phrased as stage/counter
    // copy must bite the detector — the gate covers this stage's copy.
    const seeded =
      "Quick questions finished — 0 questions instead of 34, so you are eligible for benefits.";
    expect(findBannedClaims(seeded).length).toBeGreaterThan(0);
  });
});

describe("the quick-questions stage properties (fast-check)", () => {
  const OPTION_VALUES = ["job", "benefits", "child_support", "other", "none"];

  it("the None-of-these exclusion holds for ANY draft and pick: none never coexists with a real option, no duplicates, toggle round-trips (VAL-QQ-005)", () => {
    const picks = fc.constantFrom(...OPTION_VALUES);
    const drafts = fc.array(fc.constantFrom(...OPTION_VALUES), {
      maxLength: 8,
    });
    fc.assert(
      fc.property(drafts, picks, (draft, pick) => {
        const result = toggleNoneExclusive(draft, pick);
        // Never a duplicate, and only spec-known values.
        expect(new Set(result).size).toBe(result.length);
        for (const value of result) {
          expect(OPTION_VALUES).toContain(value);
        }
        if (pick === NONE_OPTION_VALUE) {
          // none alone, or cleared — never alongside a real source.
          expect(
            result.length === 0 ||
              (result.length === 1 && result[0] === NONE_OPTION_VALUE),
          ).toBe(true);
        } else {
          // A real pick never leaves none in the draft.
          expect(result.includes(NONE_OPTION_VALUE)).toBe(false);
          // Toggle semantics over the DEDUPLICATED draft (the same
          // canonical rule the store applies): pick added when absent,
          // removed when present.
          const canonical = [...new Set(draft)];
          const expected = canonical.includes(pick)
            ? canonical.filter(
                (value) => value !== pick && value !== NONE_OPTION_VALUE,
              )
            : [
                ...canonical.filter((value) => value !== NONE_OPTION_VALUE),
                pick,
              ];
          expect(result).toEqual(expected);
        }
      },
    ),
    );
  });

  it("grouping is a lossless partition of the defined remaining set — sensitive ids only in the LAST group, order preserved (VAL-QQ-006)", () => {
    const ids = ALL_QUESTIONS.map((q) => q.id);
    const remainingArb = fc.subarray(ids, { minLength: 1 });
    fc.assert(
      fc.property(remainingArb, (remainingIds) => {
        const state = stageState({
          quickQuestions: {
            programs: ["nc_medicaid"],
            requiredIds: remainingIds,
            requiredCount: remainingIds.length,
            remainingIds,
            remainingCount: remainingIds.length,
            complete: false,
          },
        });
        const groups = groupRemainingQuestions(state);
        const flat = groups.flatMap((group) =>
          group.questions.map((q) => q.id),
        );
        // Lossless: every defined remaining id exactly once, none else —
        // the grouping reorders into cards (groups first, sensitive last),
        // so the partition is a SET claim; within a group the engine's
        // spec order holds (checked below).
        expect(new Set(flat)).toEqual(new Set(remainingIds));
        expect(flat.length).toBe(remainingIds.length);
        // Sensitive ids appear ONLY in the sensitive group, which is LAST
        // whenever it is present at all (an empty sensitive set yields no
        // group — an empty stage is never shown).
        const sensitiveGroups = groups.filter((group) => group.sensitive);
        expect(sensitiveGroups.length).toBeLessThanOrEqual(1);
        if (sensitiveGroups.length === 1) {
          expect(groups[groups.length - 1]).toBe(sensitiveGroups[0]!);
          expect(sensitiveGroups[0]!.questions.map((q) => q.id)).toEqual(
            flat.filter((id) => SENSITIVE_QUESTION_IDS.includes(id)),
          );
        }
        expect(
          groups
            .filter((group) => !group.sensitive)
            .flatMap((group) => group.questions.map((q) => q.id))
            .filter((id) => SENSITIVE_QUESTION_IDS.includes(id)),
        ).toEqual([]);
        // Order within a group follows the engine's spec order.
        for (const group of groups) {
          const groupIds = group.questions.map((q) => q.id);
          const inEngineOrder = state.quickQuestions.remainingIds.filter(
            (id) => groupIds.includes(id),
          );
          expect(groupIds).toEqual(inEngineOrder);
        }
      },
    ),
    );
  });

  it("the counter copy always carries both engine numbers, N first, with the honest singular (VAL-QQ-004)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 99 }),
        fc.integer({ min: 0, max: 99 }),
        (n, m) => {
          const copy = counterCopy(n, m);
          expect(copy).toBe(
            n === 1
              ? `1 question instead of ${m}`
              : `${n} questions instead of ${m}`,
          );
          // N never exceeds M in any honest rendering the stage receives
          // (the engine guarantees remainingCount <= requiredCount).
          expect(copy.indexOf(String(n))).toBeLessThanOrEqual(
            copy.indexOf(String(m)),
          );
        },
      ),
    );
  });
});

describe("the quick-questions stage static markup", () => {
  it("renders SSR-clean with the engine's numbers and the sensitive group last", () => {
    const html = renderToStaticMarkup(
      <QuickQuestionsStage
        state={stageState()}
        onStateChange={() => undefined}
        onNotice={() => undefined}
        onToTalk={() => undefined}
      />,
    );
    expect(html).toContain("data-quick-questions-stage");
    expect(html).toContain("5 questions instead of 5");
    expect(html).toContain("Why we ask");
    expect(findBannedClaims(html)).toEqual([]);
  });
});

describe("work-activity reporting renders on the stage (VAL-WR-005)", () => {
  // The complement case of the skip chains, proven on the live stage:
  // when no exemption, income, or student path applies, the three
  // work-activity reporting questions are in the still-to-ask set and
  // RENDER as cards. (Until the wr-stage-ui part claims them in
  // GROUP_SPECS, they arrive through the stage's "Other questions"
  // fallback bucket — a spec addition can never silently drop off.)
  const WORK_ACTIVITY = [
    question({
      id: "wr_work_activity_who",
      prompt: "Who completed work activities last month?",
      type: "text",
      required: false,
      pii: true,
    }),
    question({
      id: "wr_work_activity_types",
      prompt: "What kinds of work activities did they do last month?",
      type: "multi_select",
      required: false,
      options: [
        { value: "job_internship", label: "A job or internship" },
        { value: "self_employment", label: "Self-employment" },
        { value: "caregiving", label: "Caregiving" },
      ],
    }),
    question({
      id: "wr_work_activity_hours",
      prompt: "About how many hours of work activities were completed last month?",
      type: "number",
      required: false,
    }),
  ];
  const ids = WORK_ACTIVITY.map((q) => q.id);

  async function renderWrStage(): Promise<HTMLElement> {
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.append(container);
    const state = stageState({
      questions: WORK_ACTIVITY,
      progress: { answered: 0, remaining: 3, total: 3 },
      quickQuestions: {
        programs: ["nc_medicaid"],
        requiredIds: ids,
        requiredCount: 3,
        remainingIds: ids,
        remainingCount: 3,
        complete: false,
      },
      income: {
        questionIds: [],
        answeredCount: 0,
        confirmedCount: 0,
        totalCount: 0,
        handled: true,
      },
    });
    await React.act(async () => {
      createRoot(container).render(
        <QuickQuestionsStage
          state={state}
          onStateChange={() => undefined}
          onNotice={() => undefined}
          onToTalk={() => undefined}
        />,
      );
    });
    await React.act(async () => undefined);
    return container;
  }

  it("renders the three work-activity cards in spec order for a no-exemption session", async () => {
    const container = await renderWrStage();
    const cards = [...container.querySelectorAll("[data-qq-card]")].map(
      (card) => card.getAttribute("data-qq-card"),
    );
    expect(cards).toEqual(ids);
    // The fallback group catches them until the stage's group mapping
    // claims them — the stage renders whatever the engine's set contains.
    expect(container.textContent).toContain("Other questions");
    for (const wr of WORK_ACTIVITY) {
      expect(container.textContent).toContain(wr.prompt);
    }
    expect(findBannedClaims(container.textContent ?? "")).toEqual([]);
  });
});
