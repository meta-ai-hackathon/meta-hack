// @vitest-environment jsdom
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONSENT_PROVIDER_ID,
  saveConsentReceipt,
  type ConsentReceipt,
} from "../../../lib/consent";
import type { IntakeClientState } from "../../../lib/intake/serialize";
import { INCOME_STAGE_QUESTION_IDS } from "../../../lib/intake/income";
import { ConversationChat } from "./conversation-chat";
import { deriveThemeProgress } from "./coming-together";
import { WAVEFORM_HEIGHTS, VoiceWaveform } from "./voice-deck";

// The owner-spec presentation layer on the journey stages (VAL-VJS2-001):
// the talk stage gains the "Coming Together" sidebar derived from REAL
// engine state, finalized transcript chips beside live-caret partials, and
// the bottom voice deck with the 15-bar waveform; the results stage gains
// the staggered rules-check (citation chip) and the real-data fill reveal.
// Every number and label here derives from the engine/session payloads the
// tests feed in — nothing on these surfaces may be fabricated.

type SessionCallbacks = {
  onUtterance: (blob: Blob) => void;
  onPhase: (phase: "listening" | "transcribing" | null) => void;
  onRecorderError: () => void;
};
const sessionCallbacks: SessionCallbacks = {
  onUtterance: () => undefined,
  onPhase: () => undefined,
  onRecorderError: () => undefined,
};
let sessionOps: string[] = [];

vi.mock("../../../lib/audio/voice-session", () => ({
  DEFAULT_ENDPOINTING: {},
  createVoiceSession: (callbacks: SessionCallbacks) => {
    Object.assign(sessionCallbacks, callbacks);
    return {
      begin: async () => {
        sessionOps.push("begin");
      },
      listen: () => {
        sessionOps.push("listen");
      },
      endpointNow: () => {
        sessionOps.push("endpoint");
      },
      hold: () => {
        sessionOps.push("hold");
      },
      resume: () => {
        sessionOps.push("resume");
      },
      stop: () => {
        sessionOps.push("stop");
      },
      get isActive() {
        return true;
      },
      get isPaused() {
        return false;
      },
    };
  },
}));

const queueSpeechMock = vi.fn((...args: unknown[]) => {
  const onended = args[2] as (() => void) | undefined;
  onended?.();
  return true;
});

vi.mock("../../../lib/audio/capture", () => ({
  queueSpeech: (...args: unknown[]) => queueSpeechMock(...(args as [])),
  recordedBlobToWav: () => new Blob([new Uint8Array(8)], { type: "audio/wav" }),
  voiceCaptureSupported: () => true,
}));

function voiceReceipt(): ConsentReceipt {
  return {
    v: 2,
    providerId: CONSENT_PROVIDER_ID,
    ai: true,
    voice: true,
    at: "2026-10-31T12:00:00.000Z",
  };
}

const THEME_QUESTIONS: IntakeClientState["questions"] = [
  {
    id: "household_size",
    prompt: "How many people are in your household?",
    help: "",
    type: "text",
    required: true,
    pii: false,
  },
  {
    id: "housing_status",
    prompt: "What is your housing situation?",
    help: "",
    type: "single_select",
    required: true,
    pii: false,
  },
  {
    id: "mailing_situation",
    prompt: "Where do you get your mail?",
    help: "",
    type: "single_select",
    required: true,
    pii: false,
  },
  {
    id: "income_sources",
    prompt: "Where does money come from for your household?",
    help: "",
    type: "multi_select",
    required: true,
    pii: false,
  },
];

function stateWith(
  answered: Record<string, { status: "known" | "unknown" | "unverified"; value?: unknown }>,
  questions: IntakeClientState["questions"] = THEME_QUESTIONS,
): IntakeClientState {
  // The income gate's block, derived over this fixture's questions with
  // the same engine semantics (no income-stage provenances here, so the
  // gate is closed unless no income question is visible at all).
  const incomeVisible = questions.filter((question) =>
    (INCOME_STAGE_QUESTION_IDS as readonly string[]).includes(question.id),
  );
  const incomeAnswered = incomeVisible.filter(
    (question) => answered[question.id] !== undefined,
  );
  return {
    questions,
    answers: answered,
    progress: {
      answered: Object.keys(answered).length,
      remaining: questions.length - Object.keys(answered).length,
      total: questions.length,
    },
    currentIndex: null,
    complete: false,
    quickQuestions: {
      programs: ["nc_medicaid"],
      requiredIds: questions.map((question) => question.id),
      requiredCount: questions.length,
      remainingIds: questions
        .filter((question) => answered[question.id] === undefined)
        .map((question) => question.id),
      remainingCount: questions.length - Object.keys(answered).length,
      complete: questions.length - Object.keys(answered).length === 0,
    },
    income: {
      questionIds: incomeVisible.map((question) => question.id),
      answeredCount: incomeAnswered.length,
      confirmedCount: 0,
      totalCount: incomeVisible.length,
      handled: incomeVisible.length === 0,
    },
  };
}

const OPEN_STATE = stateWith({});

const HOUSEHOLD_ANSWERED_STATE = stateWith({
  household_size: { status: "known", value: "3" },
});

// A realistic engine view with income_sources = "job": the job follow-up
// questions stay visible (skip logic), so the income theme is "told" only
// when they all carry answers.
const INCOME_THEME_QUESTIONS: IntakeClientState["questions"] = [
  ...THEME_QUESTIONS,
  {
    id: "income_kind",
    prompt: "What kind of income?",
    help: "",
    type: "single_select",
    required: true,
    pii: false,
  },
  {
    id: "job_income_amount",
    prompt: "How much per paycheck?",
    help: "",
    type: "text",
    required: true,
    pii: false,
  },
  {
    id: "job_income_frequency",
    prompt: "How often?",
    help: "",
    type: "single_select",
    required: true,
    pii: false,
  },
];

const COMPLETE_STATE: IntakeClientState = {
  questions: THEME_QUESTIONS,
  answers: {
    household_size: { status: "known", value: "3" },
    housing_status: { status: "known", value: "rent" },
    mailing_situation: { status: "known", value: "home" },
    income_sources: { status: "known", value: "job" },
  },
  progress: { answered: 4, remaining: 0, total: 4 },
  currentIndex: null,
  complete: true,
  quickQuestions: {
    programs: ["nc_medicaid"],
    requiredIds: THEME_QUESTIONS.map((question) => question.id),
    requiredCount: THEME_QUESTIONS.length,
    remainingIds: [],
    remainingCount: 0,
    complete: true,
  },
  income: {
    questionIds: ["income_sources"],
    answeredCount: 1,
    // UPDATED for the income-capture redefinition (VAL-QQ-011): results
    // = intake complete AND income handled. This fixture drives the
    // results-stage rendering tests, so its income block must be
    // HANDLED (confirmed) — under the old gate `handled: false` was
    // inert; now it reroutes the journey to the income stage.
    confirmedCount: 1,
    totalCount: 1,
    handled: true,
  },
};

function historyResponse(state: IntakeClientState): Response {
  return new Response(JSON.stringify({ turns: [], state }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function turnResponse(state: IntakeClientState): Response {
  return new Response(
    JSON.stringify({
      assistantReply: "Got it. That's what I needed.",
      assistantTurnId: "turn-9",
      redactedUserTranscript: "there are three of us",
      nextQuestionId: state.complete ? null : "housing_status",
      state,
      voiceUrl: null,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

// Clean match/review payloads shaped exactly like the routes' responses:
// the results stage reuses the existing sections, so the stagger, citation
// chip, and fill reveal must derive from THESE fields — the tests assert
// the rendered numbers equal the payload numbers.
const MATCH_PAYLOAD = {
  hasSession: true,
  matches: [
    {
      entryId: "nc-medicaid",
      entryTitle: "NC Medicaid",
      entryVersion: 3,
      score: 1,
      framing: "This may be worth pursuing.",
      reasons: [
        {
          text: "Your answers touch what this program asks about.",
          source: {
            entryId: "nc-medicaid",
            entryTitle: "NC Medicaid",
            entryVersion: 3,
            entryStatus: "active",
            sourceUrl: "https://medicaid.ncdhhs.gov/apply",
            retrievedAt: "2026-10-30",
          },
        },
      ],
      requirements: [
        {
          kind: "deadline",
          text: "The official page states it can take up to 45 days for the Department of Social Services to decide.",
          source: {
            entryId: "nc-medicaid",
            entryTitle: "NC Medicaid",
            entryVersion: 3,
            entryStatus: "active",
            sourceUrl: "https://medicaid.ncdhhs.gov/apply",
            retrievedAt: "2026-10-30",
          },
        },
      ],
      links: [],
      explanation: {
        text: "Based on your answers, this may be worth pursuing.",
        source: "facts",
      },
      terms: [],
    },
  ],
  toResolve: [],
};

const REVIEW_FIELDS = [
  { fieldName: "full_name", question: "Full legal name", state: "prefilled", specQuestionId: null, required: true, piiLikely: true, status: "known", provenance: "user_supplied", value: "given value" },
  { fieldName: "home_address", question: "Home address", state: "prefilled", specQuestionId: null, required: true, piiLikely: true, status: "known", provenance: "user_supplied", value: "given value" },
  { fieldName: "dob", question: "Date of birth", state: "prefilled", specQuestionId: null, required: true, piiLikely: true, status: "known", provenance: "user_supplied", value: "given value" },
  { fieldName: "phone", question: "Phone", state: "asked", specQuestionId: null, required: false, piiLikely: true },
  { fieldName: "email", question: "Email", state: "asked", specQuestionId: null, required: false, piiLikely: false },
  { fieldName: "household_count", question: "Household size", state: "prefilled", specQuestionId: null, required: true, piiLikely: false, status: "known", provenance: "user_supplied", value: "3" },
  { fieldName: "income_note", question: "Income source", state: "asked", specQuestionId: null, required: false, piiLikely: false },
  { fieldName: "county", question: "County", state: "not_applicable", specQuestionId: null, required: false, piiLikely: false },
] as const;

const REVIEW_PAYLOAD = {
  hasSession: true,
  form: {
    id: "dhb-5200",
    title: "The official application form",
    version: "1",
    sourceUrl: "https://example.gov/form.pdf",
    retrievedAt: "2026-10-30",
  },
  fields: REVIEW_FIELDS,
  toResolve: [{ fieldName: "signature", question: "Your signature — you sign it yourself" }],
  counts: { prefilled: 4, asked: 3, notApplicable: 1 },
  sessionStatus: "draft",
  portalLinks: [],
  steps: [{ title: "Review the filled form", detail: "Check every answer." }],
};

function stubFetch(state: IntakeClientState, turnState?: IntakeClientState): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/conversation/history") {
        return historyResponse(state);
      }
      if (url === "/api/conversation/turn") {
        return turnResponse(turnState ?? state);
      }
      if (url === "/api/conversation/speak") {
        return new Response(JSON.stringify({ audio: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url === "/api/match") {
        return new Response(JSON.stringify(MATCH_PAYLOAD), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url === "/api/forms/dhb-5200/review") {
        return new Response(JSON.stringify(REVIEW_PAYLOAD), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected request to ${url}`);
    }),
  );
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Element.prototype.scrollIntoView = function scrollIntoView(): void {
    // Scrolling is presentation-only in these tests.
  };
  localStorage.clear();
  sessionOps = [];
  queueSpeechMock.mockClear();
  stubFetch(OPEN_STATE);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  document.body.replaceChildren();
});

async function renderChat(
  historyState: IntakeClientState = OPEN_STATE,
  turnState?: IntakeClientState,
): Promise<{
  container: HTMLElement;
  act: (fn: () => Promise<void> | void) => Promise<void>;
}> {
  stubFetch(historyState, turnState);
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
    root.render(React.createElement(ConversationChat));
  });
  await act(async () => undefined);
  return { container, act };
}

const q = (container: HTMLElement, attr: string): Element | null =>
  container.querySelector(`[data-${attr}]`);

const all = (container: HTMLElement, attr: string): Element[] =>
  Array.from(container.querySelectorAll(`[data-${attr}]`));

async function beginTalkStage(
  container: HTMLElement,
  act: (fn: () => Promise<void> | void) => Promise<void>,
): Promise<void> {
  await act(async () => {
    saveConsentReceipt(voiceReceipt());
  });
  await act(async () => {
    const radio = q(container, 'mode-option="voice-only"')?.querySelector("input");
    if (radio) {
      (radio as HTMLInputElement).click();
    }
    q(container, "mode-begin")?.dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
  });
  // The inserted QUICK QUESTIONS stage (VAL-QQ-002): traverse it with the
  // calm CTA whenever the engine's questions are pending — a zero-pending
  // session passes straight through to the talk stage.
  if (q(container, "quick-questions-stage")) {
    await act(async () => {
      q(container, "qq-to-talk")?.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
  }
}

describe("the Coming Together sidebar (VAL-VJS2-001)", () => {
  it("derives every badge from REAL engine state — told only when a theme's visible questions are all answered", () => {
    // Nothing answered: every theme is upcoming.
    const open = deriveThemeProgress(OPEN_STATE);
    expect(open.map((theme) => theme.told)).toEqual([false, false, false, false]);
    // The spec's four themes, in the question spec's order.
    expect(open.map((theme) => theme.label)).toEqual([
      "Living situation",
      "Who's with you",
      "Mailing address",
      "Work & income",
    ]);
  });

  it("marks a theme told only when its answered set covers its visible questions", () => {
    const partial = deriveThemeProgress(
      stateWith({
        household_size: { status: "known", value: "3" },
        housing_status: { status: "known", value: "rent" },
      }),
    );
    const byId = Object.fromEntries(partial.map((theme) => [theme.id, theme]));
    // household_size AND housing_status answered: both themes told…
    expect(byId.household.told).toBe(true);
    expect(byId.living.told).toBe(true);
    // …the rest still coming. Counts are real: 1 of 1 asked, 0 of 1 mailing.
    expect(byId.household.answeredCount).toBe(1);
    expect(byId.mailing.told).toBe(false);
    expect(byId.mailing.answeredCount).toBe(0);
  });

  it("is skip-aware: a theme counts only the questions the engine still asks", () => {
    // income_sources = "job" keeps the job follow-ups visible (the real
    // engine's skip logic): the theme is not "told" until its remaining
    // visible questions carry answers too.
    const withJob = deriveThemeProgress(
      stateWith(
        { income_sources: { status: "known", value: "job" } },
        INCOME_THEME_QUESTIONS,
      ),
    );
    const income = withJob.find((theme) => theme.id === "income");
    expect(income?.told).toBe(false);
    expect(income?.answeredCount).toBe(1);
    expect(income?.visibleCount).toBe(4);
  });

  it("a null state (history still loading) shows every theme as upcoming — never a fabricated check", () => {
    const derived = deriveThemeProgress(null);
    expect(derived.every((theme) => !theme.told)).toBe(true);
  });

  it("renders the sidebar on the talk stage: heading, themes, badges, summary, footer", async () => {
    const { container, act: actFn } = await renderChat(HOUSEHOLD_ANSWERED_STATE);
    await beginTalkStage(container, actFn);
    const sidebar = q(container, "coming-together");
    expect(sidebar).not.toBeNull();
    expect(sidebar?.getAttribute("data-journey-stage")).toBe("talk");
    const text = sidebar?.textContent ?? "";
    expect(text).toContain("Coming Together");
    expect(text).toContain("Living situation");
    expect(text).toContain("Who's with you");
    expect(text).toContain("Mailing address");
    expect(text).toContain("Work & income");
    expect(text).toContain("You told us");
    expect(text).toContain("Coming up");
    expect(text).toContain("A clearer picture, little by little.");
    expect(text).toContain("One conversation. Your own words.");
    // REAL state: the household theme (answered in the fixture) shows the
    // told badge; the others show coming-up.
    const told = all(container, "sidebar-theme-told").map((el) =>
      el.getAttribute("data-sidebar-theme-told"),
    );
    expect(told).toContain("household");
    const upcoming = all(container, "sidebar-theme-upcoming").map((el) =>
      el.getAttribute("data-sidebar-theme-upcoming"),
    );
    expect(upcoming).toEqual(["living", "mailing", "income"]);
  });

  it("the sidebar does not render on the entry or results stages", async () => {
    // Entry stage.
    const entry = await renderChat(OPEN_STATE);
    await entry.act(async () => {
      saveConsentReceipt(voiceReceipt());
    });
    expect(q(entry.container, "coming-together")).toBeNull();
    // Results stage: a completed session renders results on load, with no
    // sidebar and no talk stage in between.
    const results = await renderChat(COMPLETE_STATE);
    await results.act(async () => {
      saveConsentReceipt(voiceReceipt());
    });
    expect(q(results.container, "coming-together")).toBeNull();
    expect(
      q(results.container, "journey-stage")?.getAttribute("data-journey-stage"),
    ).toBe("results");
  });
});

describe("finalized transcript chips and live-caret partials (VAL-VJS2-001)", () => {
  it("a user turn that answered spec questions carries a [✓ theme] chip derived from the engine diff", async () => {
    const { container, act: actFn } = await renderChat(OPEN_STATE, HOUSEHOLD_ANSWERED_STATE);
    await beginTalkStage(container, actFn);
    // The turn response answers household_size (OPEN_STATE had no answers):
    // the user bubble gains the chip for that question's theme.
    await actFn(async () => {
      sessionCallbacks.onUtterance(new Blob([new Uint8Array(8)], { type: "audio/wav" }));
    });
    const chips = all(container, "turn-chip");
    expect(chips.map((el) => el.getAttribute("data-turn-chip"))).toEqual([
      "household",
    ]);
    expect(chips[0]?.textContent).toContain("✓");
    expect(chips[0]?.textContent).toContain("Who's with you");
  });

  it("a turn that answers nothing new carries no chip", async () => {
    const { container, act: actFn } = await renderChat(OPEN_STATE);
    await beginTalkStage(container, actFn);
    // The stubbed turn returns the SAME state: no newly answered questions.
    await actFn(async () => {
      sessionCallbacks.onUtterance(new Blob([new Uint8Array(8)], { type: "audio/wav" }));
    });
    expect(q(container, "turn-chip")).toBeNull();
  });

  it("while listening, the transcript shows the live-caret partial bubble — decorative, never fabricated text", async () => {
    const { container, act: actFn } = await renderChat();
    await beginTalkStage(container, actFn);
    await actFn(async () => {
      sessionCallbacks.onPhase("listening");
    });
    const partial = q(container, "live-partial");
    expect(partial).not.toBeNull();
    // The state is also conveyed outside the bubble (state bar/notice), so
    // the decorative bubble is hidden from the accessibility tree.
    expect(partial?.getAttribute("aria-hidden")).toBe("true");
    expect(q(container, "live-caret")).not.toBeNull();
    // No fabricated words: the partial carries no transcript text.
    expect(partial?.textContent?.trim()).toBe("");
  });

  it("the live partial disappears when the phase ends", async () => {
    const { container, act: actFn } = await renderChat();
    await beginTalkStage(container, actFn);
    await actFn(async () => {
      sessionCallbacks.onPhase("listening");
    });
    expect(q(container, "live-partial")).not.toBeNull();
    await actFn(async () => {
      sessionCallbacks.onPhase("transcribing");
    });
    expect(q(container, "live-partial")).toBeNull();
  });
});

describe("the bottom voice deck waveform (VAL-VJS2-001)", () => {
  it("renders exactly 15 bars with the spec heights", async () => {
    expect(WAVEFORM_HEIGHTS).toEqual([3, 5, 9, 16, 11, 22, 28, 17, 11, 23, 15, 7, 12, 5, 3]);
    const React = await import("react");
    const reactDom = await import("react-dom/client");
    const host = document.createElement("div");
    document.body.append(host);
    const root = reactDom.createRoot(host);
    await React.act(async () => {
      root.render(React.createElement(VoiceWaveform, { phase: "listening" }));
      await new Promise((done) => setTimeout(done, 0));
    });
    const bars = Array.from(host.querySelectorAll("[data-wave-bar]"));
    expect(bars).toHaveLength(15);
    expect(bars.map((bar) => Number(bar.getAttribute("data-wave-bar")))).toEqual([
      ...WAVEFORM_HEIGHTS,
    ]);
  });

  it("flattens when thinking or transcribing, animates when listening or speaking", async () => {
    const React = await import("react");
    const reactDom = await import("react-dom/client");
    const host = document.createElement("div");
    document.body.append(host);
    const root = reactDom.createRoot(host);
    const renderPhase = async (phase: "listening" | "transcribing" | "thinking" | "speaking" | null) => {
      await React.act(async () => {
        root.render(React.createElement(VoiceWaveform, { phase }));
        await new Promise((done) => setTimeout(done, 0));
      });
    };
    await renderPhase("listening");
    const wave = host.querySelector("[data-voice-waveform]");
    expect(wave).not.toBeNull();
    expect(wave?.getAttribute("aria-hidden")).toBe("true");
    expect(wave?.getAttribute("data-waveform-flat")).toBe("false");
    await renderPhase("thinking");
    expect(wave?.getAttribute("data-waveform-flat")).toBe("true");
    await renderPhase("transcribing");
    expect(wave?.getAttribute("data-waveform-flat")).toBe("true");
    await renderPhase("speaking");
    expect(wave?.getAttribute("data-waveform-flat")).toBe("false");
    await renderPhase(null);
    expect(wave?.getAttribute("data-waveform-flat")).toBe("false");
  });

  it("the deck hosts the waveform, the four state captions, and the existing controls on the talk stage", async () => {
    const { container, act: actFn } = await renderChat();
    await beginTalkStage(container, actFn);
    await actFn(async () => {
      sessionCallbacks.onPhase("listening");
    });
    const deck = q(container, "voice-deck");
    expect(deck).not.toBeNull();
    expect(deck?.getAttribute("data-voice-session")).toBe("active");
    expect(q(container, "voice-waveform")).not.toBeNull();
    // The four state captions keep their validated copy, in the deck.
    expect(deck?.textContent).toContain("Listening — go ahead, we're right here.");
    // The existing controls stay reachable inside the deck.
    expect(q(container, "voice-pause")).not.toBeNull();
  });
});

describe("the staggered rules-check and citation chip (VAL-VJS2-001)", () => {
  // A completed session renders the results stage straight on consent —
  // the auto-advance's reload path (VAL-VJS-003), no turns needed.
  it("the results stage staggers the rules-check sections", async () => {
    const { container, act: actFn } = await renderChat(COMPLETE_STATE);
    await actFn(async () => {
      saveConsentReceipt(voiceReceipt());
    });
    const group = q(container, "stagger-group");
    expect(group).not.toBeNull();
    // The match section (the rules-check) staggers its reason items.
    const reasonItems = container.querySelectorAll("[data-match-section] ul li");
    expect(reasonItems.length).toBeGreaterThan(0);
    expect(reasonItems[0]?.className).toContain("stagger-item");
  });

  it("each match card shows a citation chip derived from the entry's real source and retrieval date", async () => {
    const { container, act: actFn } = await renderChat(COMPLETE_STATE);
    await actFn(async () => {
      saveConsentReceipt(voiceReceipt());
    });
    const chip = q(container, "citation-chip");
    expect(chip).not.toBeNull();
    expect(chip?.textContent).toContain("medicaid.ncdhhs.gov");
    expect(chip?.textContent).toContain("retrieved 2026-10-30");
    const link = chip?.querySelector("a");
    expect(link?.getAttribute("href")).toBe("https://medicaid.ncdhhs.gov/apply");
  });

  it("the KB-sourced 45-day deadline note renders with its source", async () => {
    const { container, act: actFn } = await renderChat(COMPLETE_STATE);
    await actFn(async () => {
      saveConsentReceipt(voiceReceipt());
    });
    const text = q(container, "match-section")?.textContent ?? "";
    expect(text).toContain("up to 45 days");
    expect(text).toContain("retrieved 2026-10-30");
  });
});

describe("the real-data fill reveal (VAL-VJS2-001)", () => {
  it("the fill counter reads the ACTUAL review payload — prefilled count of the real mapped fields", async () => {
    const { container, act: actFn } = await renderChat(COMPLETE_STATE);
    await actFn(async () => {
      saveConsentReceipt(voiceReceipt());
    });
    const reveal = q(container, "fill-reveal");
    expect(reveal).not.toBeNull();
    expect(reveal?.textContent).toContain("Filling your application");
    const counter = q(container, "fill-count");
    // 4 prefilled of the 8 real mapped fields in the fixture payload.
    expect(counter?.textContent).toBe("4 of 8 fields");
    expect(counter?.getAttribute("data-fill-count")).toBe("4 of 8 fields");
  });

  it("the reveal staggers the real field list and keeps the honest toResolve display", async () => {
    const { container, act: actFn } = await renderChat(COMPLETE_STATE);
    await actFn(async () => {
      saveConsentReceipt(voiceReceipt());
    });
    const fields = container.querySelectorAll("[data-review-fields] li");
    expect(fields).toHaveLength(8);
    expect(fields[0]?.className).toContain("stagger-item");
    // Honest unknowns: the toResolve section still renders, never hidden
    // by the reveal.
    expect(q(container, "form-to-resolve")).not.toBeNull();
    expect(q(container, "form-to-resolve")?.textContent).toContain(
      "Your signature — you sign it yourself",
    );
  });
});

describe("reduced-motion variants for all new motion (VAL-VJS2-001)", () => {
  it("every new animation is defined only inside the no-preference media block", () => {
    const cssPath = path.resolve(__dirname, "../../../app/globals.css");
    expect(existsSync(cssPath)).toBe(true);
    const css = readFileSync(cssPath, "utf8");
    const noPreference = css.indexOf("@media (prefers-reduced-motion: no-preference)");
    expect(noPreference).toBeGreaterThan(-1);
    // Every animation shorthand in the file must live inside (or after)
    // the no-preference block: under prefers-reduced-motion: reduce, none
    // of the new motion applies — bars, caret, and stagger render static
    // and fully visible.
    const shorthand = /animation\s*:/g;
    for (const match of css.matchAll(shorthand)) {
      expect(match.index ?? -1).toBeGreaterThanOrEqual(noPreference);
    }
    // The new motion primitives exist.
    expect(css).toContain("@keyframes voice-wave-a");
    expect(css).toContain("@keyframes voice-wave-b");
    expect(css).toContain("@keyframes caret-blink");
    expect(css).toContain("@keyframes stagger-rise");
  });
});
