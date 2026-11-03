// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONSENT_PROVIDER_ID,
  saveConsentReceipt,
  type ConsentReceipt,
} from "../../../lib/consent";
import type { IntakeClientState } from "../../../lib/intake/serialize";
import {
  ConversationChat,
  TRANSCRIPT_STICK_THRESHOLD_PX,
  isPinnedToLatest,
} from "./conversation-chat";

// VAL-FIX-002 (owner-reported demo-day bug): the talk-stage transcript
// grew the page without bound as the conversation continued. It must
// render as a FIXED-HEIGHT scrollable pane instead: latest turns in view
// (auto-scroll on new turns AND on the streaming live-caret partial),
// page height stable, keyboard and scrollbar operable, a11y roles and
// labels preserved — and the pane must never yank to the bottom while
// the person has scrolled up to read.

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

vi.mock("../../../lib/audio/voice-session", () => ({
  DEFAULT_ENDPOINTING: {},
  createVoiceSession: (callbacks: SessionCallbacks) => {
    Object.assign(sessionCallbacks, callbacks);
    return {
      begin: async () => undefined,
      listen: () => undefined,
      endpointNow: () => undefined,
      hold: () => undefined,
      resume: () => undefined,
      stop: () => undefined,
      get isActive() {
        return true;
      },
      get isPaused() {
        return false;
      },
    };
  },
}));

vi.mock("../../../lib/audio/capture", () => ({
  queueSpeech: (
    _text: string,
    _synth?: unknown,
    onEnded?: () => void,
  ) => {
    onEnded?.();
    return true;
  },
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

const EMPTY_STATE: IntakeClientState = {
  questions: [
    {
      id: "application_role",
      prompt: "Who is this application for?",
      help: "",
      type: "text",
      required: true,
      pii: false,
    },
  ],
  answers: {},
  progress: { answered: 0, remaining: 1, total: 1 },
  currentIndex: 0,
  complete: false,
  quickQuestions: {
    programs: ["nc_medicaid"],
    requiredIds: ["application_role"],
    requiredCount: 1,
    remainingIds: ["application_role"],
    remainingCount: 1,
    complete: false,
  },
  income: {
    questionIds: [],
    answeredCount: 0,
    confirmedCount: 0,
    totalCount: 0,
    handled: true,
  },
};

function turnResponse(): Response {
  return new Response(
    JSON.stringify({
      assistantReply: "Got it. What is your zip code?",
      assistantTurnId: "turn-9",
      redactedUserTranscript: "a household of three",
      nextQuestionId: "state",
      state: EMPTY_STATE,
      voiceUrl: null,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function stubFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/conversation/history") {
        return new Response(
          JSON.stringify({ turns: [], state: EMPTY_STATE }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url === "/api/conversation/turn") {
        return turnResponse();
      }
      if (url === "/api/conversation/speak") {
        return new Response(JSON.stringify({ audio: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected request to ${url}`);
    }),
  );
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  // jsdom does not implement scrollIntoView; the transcript's scroll
  // effect calls it on the non-talk (single-scroll) paths.
  Element.prototype.scrollIntoView = function scrollIntoView(): void {
    // Scrolling is presentation-only in these tests.
  };
  localStorage.clear();
  stubFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  document.body.replaceChildren();
});

const q = (container: HTMLElement, attr: string): Element | null =>
  container.querySelector(`[data-${attr}]`);

async function renderChat(): Promise<{
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
    root.render(React.createElement(ConversationChat));
  });
  await act(async () => undefined);
  return { container, act };
}

async function beginTalkStage(
  container: HTMLElement,
  act: (fn: () => Promise<void> | void) => Promise<void>,
): Promise<HTMLElement> {
  await act(async () => {
    saveConsentReceipt(voiceReceipt());
  });
  await act(async () => {
    const radio = q(container, `mode-option="voice-plus-typing"`)?.querySelector(
      "input",
    );
    (radio as HTMLInputElement | null)?.click();
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
  const pane = q(container, "transcript-pane");
  if (!(pane instanceof HTMLElement)) {
    throw new Error("the talk stage did not render the transcript pane");
  }
  return pane;
}

/** Fake the pane's scroll geometry; records every scrollTop assignment. */
function installGeometry(
  pane: HTMLElement,
  geometry: { scrollTop: number; scrollHeight: number; clientHeight: number },
): { assigned: number[] } {
  const assigned: number[] = [];
  let top = geometry.scrollTop;
  Object.defineProperty(pane, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (value: number) => {
      assigned.push(value);
      top = value;
    },
  });
  Object.defineProperty(pane, "scrollHeight", {
    configurable: true,
    get: () => geometry.scrollHeight,
  });
  Object.defineProperty(pane, "clientHeight", {
    configurable: true,
    get: () => geometry.clientHeight,
  });
  return { assigned };
}

describe("isPinnedToLatest (the pane's stick decision)", () => {
  it("is pinned when the pane sits at the bottom", () => {
    expect(isPinnedToLatest(600, 1000, 400)).toBe(true);
  });

  it("is pinned within the stick threshold of the bottom", () => {
    expect(
      isPinnedToLatest(600 - TRANSCRIPT_STICK_THRESHOLD_PX, 1000, 400),
    ).toBe(true);
  });

  it("is unpinned once the person has scrolled up", () => {
    expect(isPinnedToLatest(300, 1000, 400)).toBe(false);
  });
});

describe("the talk-stage transcript pane (VAL-FIX-002)", () => {
  it("renders a fixed-height, keyboard-operable scrollable pane with the transcript's roles and labels preserved", async () => {
    const { container, act } = await renderChat();
    const pane = await beginTalkStage(container, act);
    expect(pane.getAttribute("tabindex")).toBe("0");
    expect(pane.getAttribute("role")).toBe("region");
    expect(pane.getAttribute("aria-label")).toBe("Conversation transcript");
    expect(pane.className).toContain("overflow-y-auto");
    // The prototype's .voice-scroll cap (VAL-FIX-006): the pane scrolls
    // at a 620px max height on wide viewports (60vh-bounded on phones) —
    // the page stops growing once the conversation passes the cap.
    expect(pane.className).toContain("max-h-[min(60vh,620px)]");
    expect(pane.className).toContain("min-[761px]:max-h-[620px]");
    // The a11y structure the transcript already carried is intact.
    expect(
      container.querySelector(
        'section[aria-labelledby="conversation-transcript-heading"]',
      ),
    ).not.toBeNull();
    expect(
      pane.querySelector("ul[data-conversation-transcript]"),
    ).not.toBeNull();
  });

  it("keeps the Coming Together sidebar beside the transcript on the prototype's stage grid (VAL-FIX-006) with the pane's clip intact", async () => {
    const { container, act } = await renderChat();
    await beginTalkStage(container, act);
    // The talk-stage layout is the prototype's grid: the conversation
    // column (fluid) plus the Coming Together sidebar as a fixed 195px
    // right rail on wide viewports. Below 1101px the rail collapses into
    // the flow (a stacked section under a top border — the a11y
    // adjudication on claude-review's round-1 P2), never vanishing.
    const aside = q(container, "coming-together");
    expect(aside).not.toBeNull();
    expect(aside?.parentElement?.className).toContain(
      "min-[1101px]:grid-cols-[minmax(0,1fr)_195px]",
    );
    // The VAL-FIX-002 guards ride along unchanged: the pane keeps its
    // positioning context (the sr-only labels' containing block) and its
    // overflow clip, so page height stays byte-stable as turns grow.
    const pane = q(container, "transcript-pane");
    expect(pane?.className).toContain("relative");
    expect(pane?.className).toContain("overflow-y-auto");
  });

  it("is a positioning context so the absolute sr-only labels stay inside its overflow clip", async () => {
    const { container, act } = await renderChat();
    const pane = await beginTalkStage(container, act);
    installGeometry(pane, {
      scrollTop: 0,
      scrollHeight: 1000,
      clientHeight: 400,
    });
    // A turn on the books: its screen-reader label must live in the pane.
    await act(async () => {
      sessionCallbacks.onUtterance(new Blob(["audio"], { type: "audio/webm" }));
    });
    expect(pane.querySelectorAll(".sr-only").length).toBeGreaterThanOrEqual(2);
    // Tailwind's sr-only is position:absolute. With a fully static
    // ancestor chain the labels' containing block is the document root,
    // so they escape the pane's overflow-y-auto clip and each turn's
    // label grows the PAGE instead of the pane's scroll (real browser:
    // +114 px per turn — the VAL-FIX-002 defect). jsdom cannot compute
    // Tailwind CSS, so this guards the class the stylesheet resolves
    // into a positioning context; scroll geometry is measured in a real
    // browser per the validator directive.
    expect(pane.className).toContain("relative");
  });

  it("auto-scrolls the pane to the latest turn while the person is parked at the bottom", async () => {
    const { container, act } = await renderChat();
    const pane = await beginTalkStage(container, act);
    const { assigned } = installGeometry(pane, {
      scrollTop: 600,
      scrollHeight: 1000,
      clientHeight: 400,
    });
    await act(async () => {
      sessionCallbacks.onUtterance(new Blob(["audio"], { type: "audio/webm" }));
    });
    expect(assigned).toContain(1000);
  });

  it("never yanks the pane when the person has scrolled up", async () => {
    const { container, act } = await renderChat();
    const pane = await beginTalkStage(container, act);
    const { assigned } = installGeometry(pane, {
      scrollTop: 0,
      scrollHeight: 1000,
      clientHeight: 400,
    });
    // The person scrolls up: the scroll event unpins the pane.
    await act(async () => {
      pane.dispatchEvent(new Event("scroll"));
    });
    // A new turn arrives — the pane stays exactly where they put it.
    await act(async () => {
      sessionCallbacks.onUtterance(new Blob(["audio"], { type: "audio/webm" }));
    });
    expect(assigned).toEqual([]);
  });

  it("keeps the streaming live-caret partial in view while pinned", async () => {
    const { container, act } = await renderChat();
    const pane = await beginTalkStage(container, act);
    const { assigned } = installGeometry(pane, {
      scrollTop: 600,
      scrollHeight: 1000,
      clientHeight: 400,
    });
    // The streaming partial (the live caret rides the listening phase).
    await act(async () => {
      sessionCallbacks.onPhase("listening");
    });
    expect(q(container, "live-partial")).not.toBeNull();
    expect(assigned).toContain(1000);
  });

  it("the non-voice paths keep the single-scroll transcript — no pane", async () => {
    const { container, act } = await renderChat();
    await act(async () => {
      saveConsentReceipt({ ...voiceReceipt(), ai: false, voice: false });
    });
    expect(q(container, "zero-send-mode")).not.toBeNull();
    expect(q(container, "transcript-pane")).toBeNull();
    expect(q(container, "conversation-transcript")).not.toBeNull();
  });

  it("a re-entered talk stage starts pinned again — auto-scroll never silently dies", async () => {
    const { container, act } = await renderChat();
    const pane = await beginTalkStage(container, act);
    // The person scrolls up: the pane unpins.
    installGeometry(pane, {
      scrollTop: 0,
      scrollHeight: 1000,
      clientHeight: 400,
    });
    await act(async () => {
      pane.dispatchEvent(new Event("scroll"));
    });
    // They leave the voice journey and return (revoke + re-grant voice
    // consent): the pane detaches and a FRESH one attaches.
    await act(async () => {
      saveConsentReceipt({ ...voiceReceipt(), voice: false });
    });
    await act(async () => {
      saveConsentReceipt(voiceReceipt());
    });
    const freshPane = q(container, "transcript-pane");
    if (!(freshPane instanceof HTMLElement)) {
      throw new Error("the talk stage pane did not re-attach");
    }
    const { assigned } = installGeometry(freshPane, {
      scrollTop: 0,
      scrollHeight: 1000,
      clientHeight: 400,
    });
    // A new turn on the re-entered stage scrolls the fresh pane to the
    // latest turn — the stale scrolled-up pin did not survive the
    // detach.
    await act(async () => {
      sessionCallbacks.onUtterance(new Blob(["audio"], { type: "audio/webm" }));
    });
    expect(assigned).toContain(1000);
  });
});
