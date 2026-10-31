// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONSENT_PROVIDER_ID,
  declinedReceipt,
  saveConsentReceipt,
  type ConsentReceipt,
} from "../../../lib/consent";
import type { IntakeClientState } from "../../../lib/intake/serialize";
import { ConversationChat, RESULTS_WRAP_UP } from "./conversation-chat";

// The three-stage voice journey (VAL-VJS-001..004): a clean mode-choice
// ENTRY stage, a clean TALK stage (flowing transcript bubbles + the state
// bar, no form/recording cluster), and a RESULTS stage the journey
// AUTO-ADVANCES to when the deterministic engine has no unanswered
// question left. The preserved surfaces — consent gate, mode-B typing,
// wizard fallback, purge — stay reachable exactly as before.

// The controllable voice-session fake: the test drives the callbacks the
// component wired and observes the session operations it called.
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

// The mocked built-in voice finishes instantly (the real queueSpeech
// invokes the end callback when the utterance completes — args[2] here),
// so a session's next turn can flow without waiting on real audio.
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

const OPEN_STATE: IntakeClientState = {
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
};

const COMPLETE_STATE: IntakeClientState = {
  questions: OPEN_STATE.questions,
  answers: { application_role: { status: "known", value: "myself" } },
  progress: { answered: 1, remaining: 0, total: 1 },
  currentIndex: null,
  complete: true,
};

function historyResponse(state: IntakeClientState): Response {
  return new Response(
    JSON.stringify({ turns: [], state }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function turnResponse(state: IntakeClientState): Response {
  return new Response(
    JSON.stringify({
      assistantReply: "Got it. That's what I needed.",
      assistantTurnId: "turn-9",
      redactedUserTranscript: "it's for me",
      nextQuestionId: state.complete ? null : "state",
      state,
      voiceUrl: null,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

// Minimal clean match/review payloads: the results stage reuses the
// existing sections, so the stubs answer whatever those sections fetch.
const MATCH_PAYLOAD = {
  hasSession: true,
  matches: [
    {
      entryId: "sample-program",
      entryTitle: "A sample program",
      entryVersion: 3,
      score: 1,
      framing: "This may be worth pursuing.",
      reasons: [
        {
          text: "Your answers touch what this program asks about.",
          source: {
            entryId: "sample-program",
            entryTitle: "A sample program",
            entryVersion: 3,
            entryStatus: "active",
            sourceUrl: "https://example.gov/program",
            retrievedAt: "2026-10-31",
          },
        },
      ],
      requirements: [],
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

const REVIEW_PAYLOAD = {
  hasSession: true,
  form: {
    id: "dhb-5200",
    title: "The official application form",
    version: "1",
    sourceUrl: "https://example.gov/form.pdf",
    retrievedAt: "2026-10-31",
  },
  fields: [],
  toResolve: [],
  counts: { prefilled: 0, asked: 0, notApplicable: 0 },
  sessionStatus: "draft",
  portalLinks: [],
  steps: [
    { title: "Review the filled form", detail: "Check every answer." },
  ],
};

function stubFetch(
  state: IntakeClientState,
  turnState?: IntakeClientState,
  speakStatus = 200,
): void {
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
        return new Response(
          JSON.stringify(
            speakStatus === 200
              ? { audio: null }
              : { error: { code: "model_unavailable", message: "unavailable" } },
          ),
          {
            status: speakStatus,
            headers: { "content-type": "application/json" },
          },
        );
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
  // jsdom does not implement scrollIntoView; the transcript's scroll effect
  // calls it on every turn.
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

const q = (container: HTMLElement, attr: string): Element | null =>
  container.querySelector(`[data-${attr}]`);

async function beginMode(
  container: HTMLElement,
  act: (fn: () => Promise<void> | void) => Promise<void>,
  mode: "voice-only" | "voice-plus-typing",
): Promise<void> {
  await act(async () => {
    saveConsentReceipt(voiceReceipt());
  });
  await act(async () => {
    const radio = q(container, `mode-option="${mode}"`)?.querySelector("input");
    if (radio) {
      (radio as HTMLInputElement).click();
    }
    q(container, "mode-begin")?.dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
  });
}

describe("the three-stage voice journey (VAL-VJS-001..004)", () => {
  it("entry stage: the mode choice renders clean — no transcript, no journey sections (VAL-VJS-001)", async () => {
    const { container, act: actFn } = await renderChat();
    await actFn(async () => {
      saveConsentReceipt(voiceReceipt());
    });
    expect(q(container, "mode-choice")).not.toBeNull();
    expect(q(container, "journey-stage")?.getAttribute("data-journey-stage")).toBe("entry");
    // The frame layout: headline, two cards, begin, trust line — and no
    // journey sections. The PURGE control is the exception: it stays
    // reachable at every point of the journey (VAL-VJS-003).
    expect(q(container, "conversation-transcript")).toBeNull();
    expect(container.textContent).not.toContain("Your answers so far");
    expect(container.textContent).not.toContain(
      "Benefits that may be worth pursuing",
    );
    expect(q(container, "purge-wrapper")).not.toBeNull();
  });

  it("mode A talk stage: bubbles + state bar, no form and no journey sections (VAL-VJS-002)", async () => {
    const { container, act: actFn } = await renderChat();
    await beginMode(container, actFn, "voice-only");
    // The session reports its phase the way the real one does at cycle
    // start; the state bar renders it.
    await actFn(async () => {
      sessionCallbacks.onPhase("listening");
    });
    expect(q(container, "journey-stage")?.getAttribute("data-journey-stage")).toBe("talk");
    expect(q(container, "conversation-transcript")).not.toBeNull();
    expect(q(container, "voice-state-bar")).not.toBeNull();
    expect(container.querySelector("textarea")).toBeNull();
    expect(q(container, "switch-to-typing")).toBeNull();
    expect(container.textContent).not.toContain("Your answers so far");
    expect(container.textContent).not.toContain(
      "Benefits that may be worth pursuing",
    );
    // Purge stays reachable mid-journey (VAL-VJS-003).
    expect(q(container, "purge-wrapper")).not.toBeNull();
  });

  it("mode B talk stage keeps the always-visible switch-to-typing (VAL-VJS-002)", async () => {
    const { container, act: actFn } = await renderChat();
    await beginMode(container, actFn, "voice-plus-typing");
    expect(q(container, "journey-stage")?.getAttribute("data-journey-stage")).toBe("talk");
    expect(q(container, "switch-to-typing")).not.toBeNull();
    expect(container.querySelector("textarea")).toBeNull();
    expect(q(container, "conversation-transcript")).not.toBeNull();
  });

  it("auto-advance: the completed turn transitions to results with no clicks — spoken wrap-up, match, download, purge (VAL-VJS-003/004)", async () => {
    stubFetch(OPEN_STATE, COMPLETE_STATE);
    const { container, act: actFn } = await renderChat();
    await beginMode(container, actFn, "voice-plus-typing");
    await actFn(async () => {
      sessionCallbacks.onUtterance(new Blob(["audio"], { type: "audio/webm" }));
    });
    expect(q(container, "journey-stage")?.getAttribute("data-journey-stage")).toBe("results");
    expect(q(container, "results-stage")).not.toBeNull();
    // The spoken wrap-up is also the visible handoff text.
    expect(q(container, "results-wrap-up")?.textContent).toBe(RESULTS_WRAP_UP);
    // The session ended with the journey: no further listening.
    expect(sessionOps).toContain("stop");
    // Permitted program framing rides the REUSED match section.
    expect(q(container, "match-section")).not.toBeNull();
    expect(container.textContent).toContain("may be worth pursuing");
    // One-click download + person-submits copy ride the REUSED review section.
    expect(q(container, "review-section")).not.toBeNull();
    expect(q(container, 'action="download"')).not.toBeNull();
    expect(container.textContent).toContain("submit it yourself");
    // The purge surface stays reachable.
    expect(q(container, "purge-wrapper")).not.toBeNull();
  });

  it("a completed session reloads straight into the results stage — no clicks, no spoken wrap-up on load (VAL-VJS-003)", async () => {
    stubFetch(COMPLETE_STATE);
    const { container, act: actFn } = await renderChat();
    await actFn(async () => {
      saveConsentReceipt(voiceReceipt());
    });
    expect(q(container, "journey-stage")?.getAttribute("data-journey-stage")).toBe("results");
    expect(q(container, "results-stage")).not.toBeNull();
    expect(queueSpeechMock).not.toHaveBeenCalled();
  });

  it("consent refusal never blocks the journey: zero-send mode still reaches every section (VAL-VJS-003)", async () => {
    const { container, act: actFn } = await renderChat();
    await actFn(async () => {
      saveConsentReceipt(declinedReceipt());
    });
    expect(q(container, "zero-send-mode")).not.toBeNull();
    expect(container.textContent).toContain("Your answers so far");
  });

  it("an ai-only typed completion never speaks the wrap-up (claude-review P2: speech rides the voice journey)", async () => {
    // AI sharing ON, voice OFF: the typed single-scroll path — completing
    // it must not produce audio (and shows the sections inline).
    stubFetch(OPEN_STATE, COMPLETE_STATE);
    const { container, act: actFn } = await renderChat();
    await actFn(async () => {
      saveConsentReceipt({ ...voiceReceipt(), voice: false });
    });
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    expect(textarea).not.toBeNull();
    await actFn(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      setter?.call(textarea, "it is for me");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      textarea.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    expect(queueSpeechMock).not.toHaveBeenCalled();
    // The ai-only path is unstaged: sections render inline as before.
    expect(container.textContent).toContain("Your answers so far");
    expect(q(container, "results-stage")).toBeNull();
  });
});

describe("fallback honesty (VAL-TTS2-002)", () => {
  it("a failed speak shows the built-in-voice badge — never silent OS-voice degradation", async () => {
    // The speak route fails (e.g. the provider is down/rate-limited): the
    // turn still completes and the built-in voice covers the reply, but
    // the UI SAYS SO — silent degradation to the OS voice is the exact bug
    // that caused the ElevenLabs switch (HACK-116).
    stubFetch(OPEN_STATE, OPEN_STATE, 503);
    const { container, act: actFn } = await renderChat();
    await beginMode(container, actFn, "voice-only");
    await actFn(async () => {
      sessionCallbacks.onUtterance(new Blob(["audio"], { type: "audio/webm" }));
    });
    // The built-in voice actually covered the reply…
    expect(queueSpeechMock).toHaveBeenCalled();
    // …visibly: a DOM badge says the built-in voice is in use.
    expect(q(container, "voice-fallback-badge")).not.toBeNull();
    expect(container.textContent).toContain("built-in voice");
  });

  it("a successful provider speak renders no fallback badge", async () => {
    const { container, act: actFn } = await renderChat();
    await beginMode(container, actFn, "voice-only");
    await actFn(async () => {
      sessionCallbacks.onUtterance(new Blob(["audio"], { type: "audio/webm" }));
    });
    expect(q(container, "voice-fallback-badge")).toBeNull();
  });

  it("a later successful speak clears the badge again", async () => {
    stubFetch(OPEN_STATE, OPEN_STATE, 503);
    const { container, act: actFn } = await renderChat();
    await beginMode(container, actFn, "voice-only");
    await actFn(async () => {
      sessionCallbacks.onUtterance(new Blob(["audio"], { type: "audio/webm" }));
    });
    expect(q(container, "voice-fallback-badge")).not.toBeNull();

    // The provider recovers: the next spoken reply clears the badge.
    stubFetch(OPEN_STATE);
    await actFn(async () => {
      sessionCallbacks.onUtterance(new Blob(["audio"], { type: "audio/webm" }));
    });
    expect(q(container, "voice-fallback-badge")).toBeNull();
  });
});
