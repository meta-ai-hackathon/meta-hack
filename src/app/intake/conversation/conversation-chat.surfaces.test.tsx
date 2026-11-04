// @vitest-environment jsdom
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONSENT_PROVIDER_ID,
  declinedReceipt,
  saveConsentReceipt,
  type ConsentReceipt,
} from "../../../lib/consent";
import { storeEntryMode } from "../../../lib/entry-mode";
import type { IntakeClientState } from "../../../lib/intake/serialize";
import * as rampartGuardModule from "../../../lib/intake/rampart-guard";
import {
  ConversationChat,
  MAX_PENDING_VOICE_TURNS,
} from "./conversation-chat";

const configureShield = (
  rampartGuardModule as unknown as {
    __configureShield: (patch: { status?: string; protective?: boolean }) => void;
  }
).__configureShield;

// The two-mode conversation surface (HACK-106, VAL-NCF-002): the derived
// conditions and transitions the rebuild introduced — exactly two entry
// modes behind the privacy decision, ONE continuous voice session per
// begin, the mid-session exit-to-typing that loses nothing, pause/resume,
// the revoke that stops the microphone, and voice sends that read the
// CURRENT receipt (claude-review P2: no stale closure).

// The controllable voice-session fake: the test drives the callbacks the
// component wired and observes the session operations it called.
type SessionCallbacks = {
  onUtterance: (blob: Blob) => void;
  onPhase: (phase: "listening" | "transcribing" | null) => void;
  onRecorderError: () => void;
  onEndpointTiming?: (timing: {
    speechEndToDecisionMs: number;
    utteranceMs: number;
  }) => void;
};
const sessionCallbacks: SessionCallbacks = {
  onUtterance: () => undefined,
  onPhase: () => undefined,
  onRecorderError: () => undefined,
};
let sessionOps: string[] = [];
// Whether the fake session reports an open recorder cycle (the real
// session's isCapturing) — the tests flip this to simulate speech in
// flight when the reply becomes ready.
let fakeCapturing = false;

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
      get isCapturing() {
        return fakeCapturing;
      },
    };
  },
}));

vi.mock("../../../lib/intake/rampart-guard", () => {
  const state = { status: "ready" as string, protective: true };
  class RampartShield {
    status: string;
    constructor() {
      this.status = state.status;
    }
    async start(): Promise<void> {}
    async protectTyped(
      text: string,
    ): Promise<{ kind: string; text?: string }> {
      if (this.status !== "ready") return { kind: "blocked" };
      if (!state.protective) return { kind: "blocked" };
      return {
        kind: "tokenized",
        text: text.replaceAll("Carlos", "[GIVEN_NAME_1]"),
      };
    }
    reveal(text: string): string {
      return text.replaceAll("[GIVEN_NAME_1]", "Carlos");
    }
  }
  return {
    RampartShield,
    __configureShield: (patch: { status?: string; protective?: boolean }) => {
      Object.assign(state, patch);
    },
  };
});

vi.mock("../../../lib/audio/capture", () => ({
  // The fallback speech resolves immediately (onended), so a turn's
  // playback leg settles in tests instead of dangling.
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

function voiceReceipt(voice: boolean): ConsentReceipt {
  return {
    v: 2,
    providerId: CONSENT_PROVIDER_ID,
    ai: true,
    voice,
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

let turnCalls: { headers: Headers; body: string }[] = [];

// The client state the history stub serves (HACK-160 tests vary it; the
// default is the fresh-session state).
let historyState: IntakeClientState = EMPTY_STATE;

function historyResponse(): Response {
  return new Response(
    JSON.stringify({ turns: [], state: historyState }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

let replyText = "Got it. What is your zip code?";

function turnResponse(): Response {
  return new Response(
    JSON.stringify({
      assistantReply: replyText,
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
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/conversation/history") {
        return historyResponse();
      }
      if (url === "/api/conversation/turn") {
        turnCalls.push({
          headers: new Headers(init?.headers),
          body: String(init?.body),
        });
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
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // jsdom does not implement scrollIntoView; the transcript's scroll effect
  // calls it on every turn.
  Element.prototype.scrollIntoView = function scrollIntoView(): void {
    // Scrolling is presentation-only in these tests.
  };
  localStorage.clear();
  sessionOps = [];
  fakeCapturing = false;
  turnCalls = [];
  historyState = EMPTY_STATE;
  replyText = "Got it. What is your zip code?";
  configureShield({ status: "ready", protective: true });
  stubFetch();
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
    saveConsentReceipt(voiceReceipt(true));
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

describe("the conversation surfaces and transitions (VAL-NCF-002)", () => {
  it("shows the privacy surface first — nothing sendable before the decision", async () => {
    const { container } = await renderChat();
    expect(q(container, "consent-surface")).not.toBeNull();
    expect(q(container, "mode-choice")).toBeNull();
    expect(container.querySelector("textarea")).toBeNull();
    expect(q(container, "voice-session")).toBeNull();
  });

  it("mode B: one continuous session, a visible switch, and no textarea", async () => {
    const { container, act } = await renderChat();
    await beginMode(container, act, "voice-plus-typing");
    expect(sessionOps).toContain("begin");
    expect(q(container, "voice-session")?.getAttribute("data-voice-session")).toBe("active");
    expect(q(container, "switch-to-typing")).not.toBeNull();
    expect(container.querySelector("textarea")).toBeNull();
    expect(q(container, "mode-choice")).toBeNull();
  });

  it("mode A: no typing surface at all — no switch control, no textarea", async () => {
    const { container, act } = await renderChat();
    await beginMode(container, act, "voice-only");
    expect(q(container, "entry-mode")?.getAttribute("data-entry-mode")).toBe("voice-only");
    expect(q(container, "switch-to-typing")).toBeNull();
    expect(container.querySelector("textarea")).toBeNull();
    expect(q(container, "voice-pause")).not.toBeNull();
  });

  it("mid-session switch to typing keeps everything and stops the session", async () => {
    const { container, act } = await renderChat();
    await beginMode(container, act, "voice-plus-typing");
    sessionOps = [];
    await act(async () => {
      q(container, "switch-to-typing")?.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    expect(sessionOps).toContain("stop");
    expect(q(container, "typing-mode")).not.toBeNull();
    expect(container.querySelector("textarea")).not.toBeNull();
    expect(q(container, "switch-to-voice")).not.toBeNull();
    expect(q(container, "voice-session")).toBeNull();
    expect(q(container, "typing-mode")?.textContent ?? "").toContain("Nothing lost");
  });

  it("switching back to voice re-opens the same session", async () => {
    const { container, act } = await renderChat();
    await beginMode(container, act, "voice-plus-typing");
    await act(async () => {
      q(container, "switch-to-typing")?.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    sessionOps = [];
    await act(async () => {
      q(container, "switch-to-voice")?.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    expect(sessionOps).toContain("begin");
    expect(q(container, "voice-session")?.getAttribute("data-voice-session")).toBe("active");
  });

  it("pause holds the session and resume restarts listening", async () => {
    const { container, act } = await renderChat();
    await beginMode(container, act, "voice-plus-typing");
    sessionOps = [];
    await act(async () => {
      q(container, "voice-pause")?.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    expect(sessionOps).toContain("hold");
    expect(q(container, "voice-session")?.getAttribute("data-voice-session")).toBe("paused");
    sessionOps = [];
    await act(async () => {
      q(container, "voice-resume")?.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    expect(sessionOps).toContain("resume");
    expect(q(container, "voice-session")?.getAttribute("data-voice-session")).toBe("active");
  });

  it("a voice turn reads the CURRENT receipt — a receipt saved after begin is what is sent", async () => {
    const { container, act } = await renderChat();
    await beginMode(container, act, "voice-plus-typing");
    // The receipt changes AFTER the session began (the stale-closure
    // scenario): the send must carry the NEW receipt, not the one from
    // the render that began the session.
    const later = { ...voiceReceipt(true), at: "2026-10-31T13:00:00.000Z" };
    await act(async () => {
      saveConsentReceipt(later);
    });
    await act(async () => {
      sessionCallbacks.onUtterance(new Blob(["audio"], { type: "audio/webm" }));
    });
    expect(turnCalls).toHaveLength(1);
    const header = turnCalls[0]!.headers.get("x-bn-consent");
    expect(header).not.toBeNull();
    expect(JSON.parse(header ?? "{}")).toMatchObject({ at: later.at, voice: true });
  });

  it("revoking voice mid-session stops the microphone and lands in typing", async () => {
    const { container, act } = await renderChat();
    await beginMode(container, act, "voice-plus-typing");
    sessionOps = [];
    await act(async () => {
      saveConsentReceipt({ ...voiceReceipt(false) });
    });
    expect(sessionOps).toContain("stop");
    expect(q(container, "voice-session")).toBeNull();
    expect(container.querySelector("textarea")).not.toBeNull();
  });

  it("VAL-FIX-001: continuations spoken while a turn is processing are queued in order and all submitted (never dropped)", async () => {
    const { container, act } = await renderChat();
    await beginMode(container, act, "voice-only");
    // The first turn's POST hangs until the test releases it, so
    // "while the turn is processing" is observable.
    let releaseTurn1: (() => void) | undefined;
    const turn1Promise = new Promise<Response>((resolve) => {
      releaseTurn1 = () => resolve(turnResponse());
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/conversation/history") {
          return historyResponse();
        }
        if (url === "/api/conversation/turn") {
          turnCalls.push({
            headers: new Headers(init?.headers),
            body: String(init?.body),
          });
          return turnCalls.length === 1 ? turn1Promise : turnResponse();
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
    sessionOps = [];
    // The first utterance ends (the gate reported its decision timing).
    await act(async () => {
      sessionCallbacks.onEndpointTiming?.({
        speechEndToDecisionMs: 412,
        utteranceMs: 1_234,
      });
      sessionCallbacks.onUtterance(
        new Blob(["first"], { type: "audio/webm" }),
      );
    });
    // Turn 1 is submitted, and capture CONTINUES while it processes —
    // the session was told to listen again immediately (the endpoint
    // decision re-opens for whatever the person says next).
    expect(turnCalls).toHaveLength(1);
    expect(sessionOps).toContain("listen");
    // TWO continuation utterances end while turn 1 is still processing.
    await act(async () => {
      sessionCallbacks.onUtterance(
        new Blob(["second"], { type: "audio/webm" }),
      );
      sessionCallbacks.onUtterance(
        new Blob(["third"], { type: "audio/webm" }),
      );
    });
    // They are queued — not submitted into the in-flight turn, and not
    // dropped.
    expect(turnCalls).toHaveLength(1);
    // Turn 1 settles: playback HOLDS the mic first (the assistant's own
    // voice must never be captured as a user turn), then the session
    // re-opens and the queued continuations submit in spoken order.
    sessionOps = [];
    await act(async () => {
      releaseTurn1?.();
    });
    expect(sessionOps).toContain("hold");
    expect(sessionOps).toContain("resume");
    expect(turnCalls).toHaveLength(3);
    // The instrumented endpoint decision evidence is on the surface
    // (agent-browser DOM evidence for the timing budget).
    const evidence = q(container, "endpoint-timing")?.getAttribute(
      "data-endpoint-timing",
    );
    expect(evidence ?? "").toContain("412");
    expect(evidence ?? "").toContain("submit=");
  });

  it("VAL-FIX-001: revoking voice sharing while a continuation is queued sends nothing further", async () => {
    const { container, act } = await renderChat();
    await beginMode(container, act, "voice-only");
    let releaseTurn1: (() => void) | undefined;
    const turn1Promise = new Promise<Response>((resolve) => {
      releaseTurn1 = () => resolve(turnResponse());
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/conversation/history") {
          return historyResponse();
        }
        if (url === "/api/conversation/turn") {
          turnCalls.push({
            headers: new Headers(init?.headers),
            body: String(init?.body),
          });
          return turnCalls.length === 1 ? turn1Promise : turnResponse();
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
    await act(async () => {
      sessionCallbacks.onUtterance(
        new Blob(["first"], { type: "audio/webm" }),
      );
    });
    expect(turnCalls).toHaveLength(1);
    // A continuation is captured and queued mid-turn…
    await act(async () => {
      sessionCallbacks.onUtterance(
        new Blob(["second"], { type: "audio/webm" }),
      );
    });
    expect(turnCalls).toHaveLength(1);
    // …and then the person revokes voice sharing while turn 1 is still
    // processing: the mic stops (the revoke effect) and the queued
    // continuation is CLEARED — it must never be uploaded afterwards.
    await act(async () => {
      saveConsentReceipt({ ...voiceReceipt(false) });
    });
    expect(sessionOps).toContain("stop");
    await act(async () => {
      releaseTurn1?.();
    });
    expect(turnCalls).toHaveLength(1);
    expect(q(container, "voice-session")).toBeNull();
  });

  it("VAL-FIX-001: a mid-utterance continuation is flushed before reply playback, never truncated away", async () => {
    const { container: _container, act } = await renderChat();
    await beginMode(_container, act, "voice-only");
    let releaseTurn1: (() => void) | undefined;
    const turn1Promise = new Promise<Response>((resolve) => {
      releaseTurn1 = () => resolve(turnResponse());
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/conversation/history") {
          return historyResponse();
        }
        if (url === "/api/conversation/turn") {
          turnCalls.push({
            headers: new Headers(init?.headers),
            body: String(init?.body),
          });
          return turnCalls.length === 1 ? turn1Promise : turnResponse();
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
    await act(async () => {
      sessionCallbacks.onUtterance(
        new Blob(["first"], { type: "audio/webm" }),
      );
    });
    expect(turnCalls).toHaveLength(1);
    // The person resumed speaking while turn 1 processed and is
    // mid-utterance exactly when the reply becomes ready.
    fakeCapturing = true;
    sessionOps = [];
    await act(async () => {
      releaseTurn1?.();
    });
    // The open recording was flushed GRACEFULLY (endpointNow delivers
    // it) before the mic was held for playback — flush first, hold
    // second.
    const flushAt = sessionOps.indexOf("endpoint");
    const holdAt = sessionOps.indexOf("hold");
    expect(flushAt).toBeGreaterThanOrEqual(0);
    expect(holdAt).toBeGreaterThan(flushAt);
    // The flushed partial arrives (as the real async onstop would) and
    // is queued while turn 1 is still settling — then submitted.
    await act(async () => {
      sessionCallbacks.onUtterance(
        new Blob(["partial"], { type: "audio/webm" }),
      );
    });
    await act(async () => undefined);
    expect(turnCalls).toHaveLength(2);
  });

  it("HACK-107 review: a token-free reply is spoken verbatim — the paraphrase does not replace the stored words", async () => {
    const { container: _container, act } = await renderChat();
    await beginMode(_container, act, "voice-only");
    const speakCalls: string[] = [];
    replyText = "Thanks for the detail. What is your zip code?";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/conversation/history") {
          return historyResponse();
        }
        if (url === "/api/conversation/turn") {
          turnCalls.push({
            headers: new Headers(init?.headers),
            body: String(init?.body),
          });
          // A voice turn whose model rendition DIFFERS from the stored
          // reply, while the stored reply carries no token.
          return new Response(
            JSON.stringify({
              assistantReply: replyText,
              assistantTurnId: "turn-9",
              spokenReply: "Thanks to you — what zip are we talking about?",
              redactedUserTranscript: "a household of three",
              nextQuestionId: "state",
              state: EMPTY_STATE,
              voiceUrl: null,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (url === "/api/conversation/speak") {
          speakCalls.push(String(init?.body) ?? "");
          return new Response(JSON.stringify({ audio: null }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        throw new Error(`unexpected request to ${url}`);
      }),
    );
    await act(async () => {
      sessionCallbacks.onUtterance(new Blob(["x"], { type: "audio/webm" }));
    });
    // Let the reply settle through display, hold, and the speak call.
    await act(async () => undefined);
    await act(async () => undefined);
    // The play path speaks the STORED words via the speak route (by turn
    // id): the differing spoken rendition is never preferred for a reply
    // that carries no token.
    expect(speakCalls.length).toBe(1);
    expect(speakCalls[0]).toContain("turn-9");
  });

  it("HACK-107 review: against a token-bearing reply — a state the server cannot produce — the paraphrase covers (defense in depth)", async () => {
    const { container, act } = await renderChat();
    await beginMode(container, act, "voice-only");
    replyText = "Thanks [GIVEN_NAME_1] — got it. What is your zip code?";
    let speakCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/conversation/history") {
          return historyResponse();
        }
        if (url === "/api/conversation/turn") {
          turnCalls.push({
            headers: new Headers(init?.headers),
            body: String(init?.body),
          });
          return new Response(
            JSON.stringify({
              assistantReply: replyText,
              assistantTurnId: "turn-9",
              spokenReply: "Thanks to you — what zip are we talking about?",
              redactedUserTranscript: "a household of three",
              nextQuestionId: "state",
              state: EMPTY_STATE,
              voiceUrl: null,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (url === "/api/conversation/speak") {
          speakCalls += 1;
          return new Response(JSON.stringify({ audio: null }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        throw new Error(`unexpected request to ${url}`);
      }),
    );
    await act(async () => {
      sessionCallbacks.onUtterance(new Blob(["x"], { type: "audio/webm" }));
    });
    await act(async () => undefined);
    await act(async () => undefined);
    // The display rehydrated the token (defense-in-depth reveal), and the
    // verified spoken rendition went out locally — never to the speak
    // route, which speaks the stored turn verbatim.
    expect(container.textContent).toContain("Carlos");
    expect(speakCalls).toBe(0);
  });

  it("VAL-FIX-001: a flushed blob arriving during reply playback queues without reopening the mic", async () => {
    const { container: _container, act } = await renderChat();
    await beginMode(_container, act, "voice-only");
    let releaseTurn1: (() => void) | undefined;
    const turn1Promise = new Promise<Response>((resolve) => {
      releaseTurn1 = () => resolve(turnResponse());
    });
    // The reply's speak fetch pends until released: "playback in
    // progress" is observable.
    let releaseSpeak: (() => void) | undefined;
    const speakPromise = new Promise<Response>((resolve) => {
      releaseSpeak = () =>
        resolve(
          new Response(JSON.stringify({ audio: null }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/conversation/history") {
          return historyResponse();
        }
        if (url === "/api/conversation/turn") {
          turnCalls.push({
            headers: new Headers(init?.headers),
            body: String(init?.body),
          });
          return turnCalls.length === 1 ? turn1Promise : turnResponse();
        }
        if (url === "/api/conversation/speak") {
          return speakPromise;
        }
        throw new Error(`unexpected request to ${url}`);
      }),
    );
    await act(async () => {
      sessionCallbacks.onUtterance(
        new Blob(["first"], { type: "audio/webm" }),
      );
    });
    expect(turnCalls).toHaveLength(1);
    // The person is mid-utterance when the reply becomes ready: the open
    // recording is flushed, then the mic is held for playback.
    fakeCapturing = true;
    sessionOps = [];
    await act(async () => {
      releaseTurn1?.();
    });
    const holdAt = sessionOps.indexOf("hold");
    expect(holdAt).toBeGreaterThan(sessionOps.indexOf("endpoint"));
    // Playback is now in progress (the speak fetch is still pending).
    // The flushed recording's async onstop delivers DURING playback:
    sessionOps = sessionOps.slice(0, holdAt + 1);
    await act(async () => {
      sessionCallbacks.onUtterance(
        new Blob(["flushed"], { type: "audio/webm" }),
      );
    });
    // It was queued WITHOUT any listen: no capture reopens while the
    // assistant's own voice is playing.
    expect(sessionOps).not.toContain("listen");
    expect(turnCalls).toHaveLength(1);
    // Playback finishes: the turn settles, the mic resumes, and the
    // queued continuation submits.
    await act(async () => {
      releaseSpeak?.();
    });
    expect(sessionOps).toContain("resume");
    expect(turnCalls).toHaveLength(2);
  });

  it("VAL-FIX-001: the continuation queue is bounded and overflow is announced, never silent", async () => {
    const { container, act } = await renderChat();
    await beginMode(container, act, "voice-only");
    let releaseTurn1: (() => void) | undefined;
    const turn1Promise = new Promise<Response>((resolve) => {
      releaseTurn1 = () => resolve(turnResponse());
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/conversation/history") {
          return historyResponse();
        }
        if (url === "/api/conversation/turn") {
          turnCalls.push({
            headers: new Headers(init?.headers),
            body: String(init?.body),
          });
          return turnCalls.length === 1 ? turn1Promise : turnResponse();
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
    await act(async () => {
      sessionCallbacks.onUtterance(
        new Blob(["first"], { type: "audio/webm" }),
      );
    });
    // Fill the queue to its bound…
    await act(async () => {
      for (let i = 0; i < MAX_PENDING_VOICE_TURNS; i += 1) {
        sessionCallbacks.onUtterance(
          new Blob([`extra-${i}`], { type: "audio/webm" }),
        );
      }
    });
    expect(turnCalls).toHaveLength(1);
    // …then overflow: dropped HONESTLY (a visible notice), not silently.
    await act(async () => {
      sessionCallbacks.onUtterance(
        new Blob(["overflow"], { type: "audio/webm" }),
      );
    });
    expect(turnCalls).toHaveLength(1);
    const notice =
      container.querySelector('[role="status"]')?.textContent ?? "";
    expect(notice).toContain("may have missed");
    // The bound queue still drains in order when the turn settles.
    await act(async () => {
      releaseTurn1?.();
    });
    expect(turnCalls).toHaveLength(MAX_PENDING_VOICE_TURNS + 1);
  });

  it("VAL-FIX-001: a user pause outlives a turn — the playback hold never overrides it", async () => {
    const { container, act } = await renderChat();
    await beginMode(container, act, "voice-only");
    await act(async () => {
      q(container, "voice-pause")?.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    sessionOps = [];
    // A turn settles while the person is paused (e.g. a delivery raced
    // the pause): its playback still holds the mic, but the settled
    // cleanup must NOT resume on their behalf — the pause stands.
    await act(async () => {
      sessionCallbacks.onUtterance(
        new Blob(["audio"], { type: "audio/webm" }),
      );
    });
    expect(sessionOps).toContain("hold");
    expect(sessionOps).not.toContain("resume");
    expect(q(container, "voice-session")?.getAttribute("data-voice-session")).toBe("paused");
  });
});

describe("typed sends through the on-device shield (HACK-107)", () => {
  async function typingMode(): Promise<{
    container: HTMLElement;
    act: (fn: () => Promise<void> | void) => Promise<void>;
  }> {
    const rendered = await renderChat();
    await beginMode(rendered.container, rendered.act, "voice-plus-typing");
    await rendered.act(async () => {
      q(rendered.container, "switch-to-typing")?.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    return rendered;
  }

  async function typeText(
    container: HTMLElement,
    act: (fn: () => Promise<void> | void) => Promise<void>,
    text: string,
  ): Promise<void> {
    await act(async () => {
      const ta = container.querySelector("textarea") as HTMLTextAreaElement;
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )!.set!;
      setter.call(ta, text);
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  it("sends text only after protect() — the fetch body carries tokens, not the raw name", async () => {
    const { container, act } = await typingMode();
    await typeText(container, act, "My name is Carlos and this is about Medicaid.");
    await act(async () => {
      (
        container.querySelector('button[type="submit"]') as HTMLButtonElement
      )?.click();
    });
    expect(turnCalls).toHaveLength(1);
    const body = turnCalls[0]!.body;
    expect(body).toContain("[GIVEN_NAME_1]");
    expect(body).not.toContain("Carlos");
    // The stored server reply carried a placeholder; the DISPLAY rehydrated it.
    expect(container.textContent).toContain("a household of three");
  });

  it("displays the assistant reply rehydrated, transcript keeps its marks", async () => {
    // Defense in depth (review P2): the server gates every reply token-free,
    // so it cannot produce a token-bearing reply; this exercises the client
    // reveal path against a misconfigured or future server anyway.
    replyText = "Thanks [GIVEN_NAME_1] — got it. What is your zip code?";
    const { container, act } = await typingMode();
    await typeText(container, act, "My case is for me.");
    await act(async () => {
      (
        container.querySelector('button[type="submit"]') as HTMLButtonElement
      )?.click();
    });
    expect(turnCalls).toHaveLength(1);
    const text = container.textContent ?? "";
    expect(text).toContain("Thanks Carlos — got it. What is your zip code?");
    // The typed user turn keeps its redacted marks (the transcript is the
    // redacted server transcript, never de-redacted on the client).
    expect(text).toContain("a household of three");
  });

  it("blocks a typed send while the shield is loading; nothing is fetched", async () => {
    configureShield({ status: "loading" });
    const { container, act } = await typingMode();
    await typeText(container, act, "Carlos");
    await act(async () => {
      (
        container.querySelector('button[type="submit"]') as HTMLButtonElement
      )?.click();
    });
    expect(turnCalls).toHaveLength(0);
    expect(container.textContent ?? "").toContain("privacy shield is still loading");
  });

  it("blocks a typed send when the shield failed, and says so honestly", async () => {
    configureShield({ status: "failed" });
    const { container, act } = await typingMode();
    await typeText(container, act, "Carlos");
    await act(async () => {
      (
        container.querySelector('button[type="submit"]') as HTMLButtonElement
      )?.click();
    });
    expect(turnCalls).toHaveLength(0);
    expect(container.textContent ?? "").toContain("failed to load");
  });

  // The typed send acknowledges itself (HACK-156, VAL-UX-003): the sent
  // message lands in the transcript IMMEDIATELY, the box clears, a visible
  // in-flight bubble covers the 10-33 s model latency (a recorded known
  // limit, HACK-116), and past ~8 s a still-working line appears. Nothing
  // is ever fabricated: the echo is the person's own words, it is replaced
  // by the server's redacted transcript when the turn lands, and any
  // failure removes the echo and restores the draft. Voice turns keep
  // their own state bar and orb — this window is the typed path's.
  describe("the send acknowledges itself (HACK-156, VAL-UX-003)", () => {
    // A turn fetch that pends until the test releases it, so the
    // in-flight window is observable.
    function stubPendingTurn(): { release: (response?: Response) => void } {
      let releaseTurn: (response: Response) => void = () => undefined;
      const pending = new Promise<Response>((resolve) => {
        releaseTurn = resolve;
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input);
          if (url === "/api/conversation/history") {
            return historyResponse();
          }
          if (url === "/api/conversation/turn") {
            turnCalls.push({
              headers: new Headers(init?.headers),
              body: String(init?.body),
            });
            return pending;
          }
          throw new Error(`unexpected request to ${url}`);
        }),
      );
      return { release: (response) => releaseTurn(response ?? turnResponse()) };
    }

    const transcriptBubbles = (container: HTMLElement): Element[] =>
      Array.from(
        // Turn bubbles only — the in-flight typing bubble is also a list
        // child while a send is pending, and it is not a turn; neither is
        // the display-only seeded first question (HACK-160), which is
        // engine content, never a stored or echoed message.
        container.querySelectorAll(
          "[data-conversation-transcript] > li:not([data-typing-indicator]):not([data-first-question])",
        ),
      );

    // An act that works while fake timers are installed: the real helper's
    // setTimeout(0) settling loops would never fire on a frozen clock.
    const fakeAct = async (fn: () => Promise<void> | void): Promise<void> => {
      const React = await import("react");
      await React.act(async () => {
        await fn();
        for (let i = 0; i < 10; i += 1) {
          await Promise.resolve();
        }
        await vi.advanceTimersByTimeAsync(0);
      });
    };

    it("the echo: a sent message is in the transcript and the box is cleared while the reply is still on its way", async () => {
      const { container, act } = await typingMode();
      const { release } = stubPendingTurn();
      await typeText(
        container,
        act,
        "Hi, I'm Testy McTestface and I need Medicaid.",
      );
      await act(async () => {
        (
          container.querySelector('button[type="submit"]') as HTMLButtonElement
        )?.click();
      });
      // Before ANY response: the person's words are in the transcript…
      const echoed = transcriptBubbles(container).filter((li) =>
        li.textContent?.includes("Testy McTestface"),
      );
      expect(echoed).toHaveLength(1);
      // …the box is clear…
      expect(
        (container.querySelector("textarea") as HTMLTextAreaElement).value,
      ).toBe("");
      // …and the assistant side shows a visible in-flight bubble while
      // the button is honestly busy.
      expect(q(container, "typing-indicator")).not.toBeNull();
      const send = container.querySelector(
        'button[type="submit"]',
      ) as HTMLButtonElement;
      expect(send.textContent).toBe("Sending…");
      expect(send.disabled).toBe(true);
      // The turn lands: the echo is CONFIRMED — replaced by the server's
      // redacted transcript, never duplicated — the reply renders, and the
      // in-flight bubble leaves.
      await act(async () => release());
      expect(transcriptBubbles(container)).toHaveLength(2);
      expect(container.textContent).toContain("a household of three");
      expect(container.textContent).toContain("Got it. What is your zip code?");
      expect(container.textContent ?? "").not.toContain("Testy McTestface");
      expect(q(container, "typing-indicator")).toBeNull();
    });

    it("property: for any typed message the echo shows the words immediately, confirms to exactly one redacted bubble, and clears the box", async () => {
      await fc.assert(
        // The send trims the draft (what goes out is the trimmed words),
        // so the arbitrary constructs already-trimmed strings — word
        // character first and last, no filter.
        fc.asyncProperty(
          fc.stringMatching(/^[\w](?:[\w ,.!?'-]{0,58}[\w])?$/u),
          async (text) => {
            const { container, act } = await typingMode();
            const { release } = stubPendingTurn();
            await typeText(container, act, text);
            await act(async () => {
              (
                container.querySelector(
                  'button[type="submit"]',
                ) as HTMLButtonElement
              )?.click();
            });
            // In flight: the box is clear, the words are echoed, the
            // indicator is visible.
            expect(
              (container.querySelector("textarea") as HTMLTextAreaElement)
                .value,
            ).toBe("");
            const echoed = transcriptBubbles(container).filter((li) =>
              li.textContent?.includes(text),
            );
            expect(echoed).toHaveLength(1);
            expect(q(container, "typing-indicator")).not.toBeNull();
            // Settled: exactly two bubbles — one user (the redacted
            // transcript, in the echo's place) and one assistant reply.
            await act(async () => release());
            const settled = transcriptBubbles(container);
            expect(settled).toHaveLength(2);
            expect(settled[0]!.textContent).toContain("a household of three");
            expect(settled[1]!.textContent).toContain(
              "Got it. What is your zip code?",
            );
            expect(q(container, "typing-indicator")).toBeNull();
            document.body.replaceChildren();
          },
        ),
        { numRuns: 12 },
      );
    });

    it("the patience line: past ~8 s of waiting the still-working line appears, and it leaves when the reply lands", async () => {
      const { container, act } = await typingMode();
      await typeText(container, act, "Are you still there?");
      const { release } = stubPendingTurn();
      vi.useFakeTimers();
      try {
        await fakeAct(async () => {
          (
            container.querySelector(
              'button[type="submit"]',
            ) as HTMLButtonElement
          )?.click();
        });
        // Inside the wait: the indicator shows, the line does not.
        expect(q(container, "typing-indicator")).not.toBeNull();
        expect(q(container, "slow-reply-note")).toBeNull();
        // Past the threshold the still-working line appears — honestly
        // phrased, no phase claim, no fabricated content.
        await fakeAct(async () => {
          await vi.advanceTimersByTimeAsync(8000);
        });
        expect(q(container, "slow-reply-note")).not.toBeNull();
        expect(container.textContent).toContain(
          "Still working on it. This can take up to half a minute.",
        );
        expect(q(container, "typing-indicator")).not.toBeNull();
        // The reply lands: the line and the bubble leave, the reply
        // renders.
        await fakeAct(async () => {
          release();
        });
        expect(q(container, "slow-reply-note")).toBeNull();
        expect(q(container, "typing-indicator")).toBeNull();
        expect(container.textContent).toContain(
          "Got it. What is your zip code?",
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("a reply that lands inside the wait never shows the still-working line", async () => {
      const { container, act } = await typingMode();
      await typeText(container, act, "Quick one:");
      const { release } = stubPendingTurn();
      vi.useFakeTimers();
      try {
        await fakeAct(async () => {
          (
            container.querySelector(
              'button[type="submit"]',
            ) as HTMLButtonElement
          )?.click();
        });
        await fakeAct(async () => {
          release();
        });
        expect(q(container, "slow-reply-note")).toBeNull();
        expect(q(container, "typing-indicator")).toBeNull();
        expect(container.textContent).toContain(
          "Got it. What is your zip code?",
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("honest failure: an error reply removes the echo, restores the draft, and fabricates nothing", async () => {
      const { container, act } = await typingMode();
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input);
          if (url === "/api/conversation/history") {
            return historyResponse();
          }
          if (url === "/api/conversation/turn") {
            turnCalls.push({
              headers: new Headers(init?.headers),
              body: String(init?.body),
            });
            return new Response(
              JSON.stringify({
                error: {
                  code: "model_unavailable",
                  message: "The assistant is unavailable right now.",
                  wizardFallbackUrl: "/intake",
                },
              }),
              { status: 503, headers: { "content-type": "application/json" } },
            );
          }
          throw new Error(`unexpected request to ${url}`);
        }),
      );
      await typeText(
        container,
        act,
        "My name is Carlos and this is about Medicaid.",
      );
      await act(async () => {
        (
          container.querySelector('button[type="submit"]') as HTMLButtonElement
        )?.click();
      });
      // The send DID happen (the fetch ran)…
      expect(turnCalls).toHaveLength(1);
      // …and the failure is honest: the error surface shows, the echo is
      // gone (asserted on the words THIS test typed — the draft lives
      // back in the textarea, so the check is scoped to the transcript),
      // no reply bubble exists, and the draft is back verbatim so the
      // person can try again.
      expect(q(container, "conversation-error")).not.toBeNull();
      expect(q(container, "typing-indicator")).toBeNull();
      const transcript = container.querySelector(
        "[data-conversation-transcript]",
      );
      expect(transcript?.textContent ?? "").not.toContain("My name is Carlos");
      expect(transcript?.textContent ?? "").not.toContain(
        "a household of three",
      );
      expect(
        (container.querySelector("textarea") as HTMLTextAreaElement).value,
      ).toBe("My name is Carlos and this is about Medicaid.");
    });

    it("honest failure: a network failure restores the draft the same way", async () => {
      const { container, act } = await typingMode();
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) => {
          const url = String(input);
          if (url === "/api/conversation/history") {
            return historyResponse();
          }
          throw new TypeError("network down");
        }),
      );
      await typeText(container, act, "Carlos again.");
      await act(async () => {
        (
          container.querySelector('button[type="submit"]') as HTMLButtonElement
        )?.click();
      });
      expect(q(container, "conversation-error")).not.toBeNull();
      expect(q(container, "typing-indicator")).toBeNull();
      // The draft is restored INTO the textarea (jsdom renders a
      // textarea's value as its content), so scope the
      // nothing-left-behind check to the transcript.
      expect(
        container
          .querySelector("[data-conversation-transcript]")
          ?.textContent ?? "",
      ).not.toContain("Carlos again.");
      expect(
        (container.querySelector("textarea") as HTMLTextAreaElement).value,
      ).toBe("Carlos again.");
    });

    it("voice mode is unaffected: a voice turn in flight shows no typing bubble", async () => {
      const { container, act } = await renderChat();
      await beginMode(container, act, "voice-only");
      const { release } = stubPendingTurn();
      await act(async () => {
        sessionCallbacks.onUtterance(
          new Blob(["first"], { type: "audio/webm" }),
        );
      });
      // The voice turn is in flight (its own state bar covers it); the
      // typed path's typing bubble must not appear.
      expect(q(container, "typing-indicator")).toBeNull();
      await act(async () => release());
      expect(container.textContent).toContain("Got it. What is your zip code?");
    });
  });
});

describe("the mode is asked once (HACK-157, VAL-UX-002)", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  afterEach(() => {
    sessionStorage.clear();
  });

  it("carries the home page's mode: after the sharing choices there is NO second mode card — one start control with a small change-the-mode link", async () => {
    storeEntryMode("voice-only");
    const { container, act } = await renderChat();
    await act(async () => {
      saveConsentReceipt(voiceReceipt(true));
    });
    // The full mode card (the same "How would you like to talk?" question
    // with a second "Let's begin") must NOT re-appear after the sharing
    // choices: the mode was picked on the home page and is carried here.
    expect(q(container, "mode-choice")).toBeNull();
    expect(container.textContent ?? "").not.toContain(
      "How would you like to talk?",
    );
    expect(
      container.querySelectorAll('input[name="conversation-entry-mode"]'),
    ).toHaveLength(0);
    // A single begin control remains (the browser needs a tap before
    // audio can start), with a small link to change the mode.
    expect(q(container, "entry-begin")).not.toBeNull();
    expect(q(container, "entry-begin-start")?.textContent).toBe(
      "Start talking",
    );
    expect(q(container, "entry-begin-change")).not.toBeNull();
  });

  it("the start control begins the journey in the carried mode", async () => {
    storeEntryMode("voice-only");
    const { container, act } = await renderChat();
    await act(async () => {
      saveConsentReceipt(voiceReceipt(true));
    });
    await act(async () => {
      q(container, "entry-begin-start")?.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    expect(q(container, "entry-mode")?.getAttribute("data-entry-mode")).toBe(
      "voice-only",
    );
    // Mode A semantics: no typing switch, no textarea.
    expect(q(container, "switch-to-typing")).toBeNull();
    expect(container.querySelector("textarea")).toBeNull();
  });

  it("the change-the-mode link brings back the full choice, and beginning from it works", async () => {
    storeEntryMode("voice-plus-typing");
    const { container, act } = await renderChat();
    await act(async () => {
      saveConsentReceipt(voiceReceipt(true));
    });
    await act(async () => {
      q(container, "entry-begin-change")?.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    expect(q(container, "mode-choice")).not.toBeNull();
    expect(q(container, "mode-begin")).not.toBeNull();
    // Focus follows the surfaced card (claude-review P3): the change link
    // unmounted the focused button, so the choice card's heading takes
    // focus — keyboard and screen-reader users are not dropped on <body>.
    expect(document.activeElement?.id).toBe("mode-choice-heading");
    // Beginning from the restored card enters the picked mode.
    await act(async () => {
      const radio = q(container, 'mode-option="voice-only"')?.querySelector(
        "input",
      );
      (radio as HTMLInputElement | null)?.click();
      q(container, "mode-begin")?.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    expect(q(container, "entry-mode")?.getAttribute("data-entry-mode")).toBe(
      "voice-only",
    );
  });

  it("without a carried mode the entry choice still asks, exactly once", async () => {
    const { container, act } = await renderChat();
    await act(async () => {
      saveConsentReceipt(voiceReceipt(true));
    });
    expect(q(container, "mode-choice")).not.toBeNull();
    expect(container.textContent ?? "").toContain(
      "How would you like to talk?",
    );
  });
});

// The chat opens with the first question visible (HACK-160, VAL-UX-004):
// with sharing on the empty conversation shows the question engine's next
// unanswered talk-saveable question — read from the live client state,
// so no model call and never a question already answered — as the
// assistant's first bubble; with sharing off the now-meaningless prompt
// line gives way to a short note pointing to the step-by-step questions
// above.
describe("the chat opens with the first question (HACK-160, VAL-UX-004)", () => {
  it("sharing on: the empty chat shows the engine's first question as the assistant's first bubble — without any turn send", async () => {
    const { container, act } = await renderChat();
    await act(async () => {
      saveConsentReceipt(voiceReceipt(false));
    });
    const seed = q(container, "first-question");
    expect(seed).not.toBeNull();
    expect(seed?.textContent ?? "").toContain("Who is this application for?");
    // It renders as the assistant's bubble inside the transcript list.
    expect(
      seed?.closest("ul")?.hasAttribute("data-conversation-transcript"),
    ).toBe(true);
    // Opening the chat made NO model call — the seed is engine content,
    // not a send.
    expect(turnCalls).toHaveLength(0);
  });

  it("the seed reads the LIVE state: after the quick-questions answers, it asks what is actually next — never a question already answered", async () => {
    // The post-quick-questions state: application_role is answered, the
    // engine's next question is main_goal. (The droid-review P1 pin: a
    // fetch-frozen seed would still show the already-answered first
    // question here.)
    historyState = {
      ...EMPTY_STATE,
      questions: [
        {
          id: "application_role",
          prompt: "Who is this application for?",
          help: "",
          type: "text",
          required: true,
          pii: false,
        },
        {
          id: "main_goal",
          prompt: "What kind of help are you looking for right now?",
          help: "",
          type: "text",
          required: true,
          pii: false,
        },
      ],
      answers: { application_role: { status: "known", value: "self" } },
      progress: { answered: 1, remaining: 1, total: 2 },
      currentIndex: 1,
    };
    const { container, act } = await renderChat();
    await act(async () => {
      saveConsentReceipt(voiceReceipt(false));
    });
    const seed = q(container, "first-question");
    expect(seed?.getAttribute("data-first-question")).toBe("main_goal");
    expect(seed?.textContent ?? "").toContain(
      "What kind of help are you looking for right now?",
    );
    expect(seed?.textContent ?? "").not.toContain(
      "Who is this application for?",
    );
  });

  it("the seed skips the structured wizard-only questions the talk path never asks", async () => {
    // Everything answered except the roster (a structured question the
    // engine never extracts in the chat, HACK-134): no chat-askable
    // question remains, so no seed — never a question a typed answer
    // could not save.
    historyState = {
      ...EMPTY_STATE,
      questions: [
        {
          id: "application_role",
          prompt: "Who is this application for?",
          help: "",
          type: "text",
          required: true,
          pii: false,
        },
        {
          id: "household_roster",
          prompt: "Who lives in your household?",
          help: "",
          type: "roster",
          required: true,
          pii: false,
        },
      ],
      answers: { application_role: { status: "known", value: "self" } },
      progress: { answered: 1, remaining: 1, total: 2 },
      currentIndex: 1,
    };
    const { container, act } = await renderChat();
    await act(async () => {
      saveConsentReceipt(voiceReceipt(false));
    });
    expect(q(container, "first-question")).toBeNull();
  });

  it("sharing on: the invite line stays, and the seeded bubble hands over to the real transcript after the first reply", async () => {
    // The ai-only typed path: a textarea, no voice session.
    const { container, act } = await renderChat();
    await act(async () => {
      saveConsentReceipt(voiceReceipt(false));
    });
    // The invite line coexists with the seeded first question.
    expect(container.textContent ?? "").toContain(
      "Say hello, or answer the first question",
    );
    expect(q(container, "first-question")).not.toBeNull();
    // A turn fetch that pends until the test releases it, so the
    // in-flight window is observable.
    let releaseTurn: (response?: Response) => void = () => undefined;
    const pending = new Promise<Response>((resolve) => {
      releaseTurn = (response) => resolve(response ?? turnResponse());
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/conversation/history") {
          return historyResponse();
        }
        if (url === "/api/conversation/turn") {
          turnCalls.push({
            headers: new Headers(init?.headers),
            body: String(init?.body),
          });
          return pending;
        }
        throw new Error(`unexpected request to ${url}`);
      }),
    );
    await act(async () => {
      const ta = container.querySelector("textarea") as HTMLTextAreaElement;
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )!.set!;
      setter.call(ta, "It is for me.");
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      (
        container.querySelector('button[type="submit"]') as HTMLButtonElement
      )?.click();
    });
    // In flight: the seeded question stays visible — it is the question
    // being answered, not a duplicate of the echo.
    expect(q(container, "first-question")).not.toBeNull();
    // The reply lands: the real transcript takes over, the seed leaves.
    await act(async () => releaseTurn());
    expect(q(container, "first-question")).toBeNull();
    expect(container.textContent ?? "").toContain(
      "Got it. What is your zip code?",
    );
  });

  it("sharing off: the empty-chat prompt line is replaced with a short note pointing to the questions above", async () => {
    const { container, act } = await renderChat();
    await act(async () => {
      saveConsentReceipt(declinedReceipt());
    });
    // No seeded bubble in zero-send mode — there is no chat to seed.
    expect(q(container, "first-question")).toBeNull();
    // The stale line is gone…
    expect(container.textContent ?? "").not.toContain(
      "Say hello, or answer the first question",
    );
    // …replaced by a short note pointing to the step-by-step questions
    // above.
    const note = q(container, "zero-send-chat-note");
    expect(note).not.toBeNull();
    expect(note?.textContent ?? "").toContain("step-by-step questions above");
  });

  it("with nothing left to ask, the empty chat keeps the plain invite line and no seed", async () => {
    historyState = {
      ...EMPTY_STATE,
      answers: { application_role: { status: "known", value: "self" } },
      progress: { answered: 1, remaining: 0, total: 1 },
      currentIndex: null,
      complete: true,
      quickQuestions: {
        ...EMPTY_STATE.quickQuestions,
        remainingIds: [],
        remainingCount: 0,
        complete: true,
      },
    };
    const { container, act } = await renderChat();
    await act(async () => {
      saveConsentReceipt(voiceReceipt(false));
    });
    expect(q(container, "first-question")).toBeNull();
    expect(container.textContent ?? "").toContain(
      "Say hello, or answer the first question",
    );
  });
});

// HACK-158 (VAL-UX-005): the server's redaction replaces a private
// answer with a bracket marker in the user transcript; the person's own
// bubble must render that marker as the same small "You told us" chip the
// answers list uses — never as raw bracket text — and the intro + help
// lines must claim only what is true (answers to PRIVATE questions show
// as You told us; typed names and free text stay visible as typed).
describe("the transcript renders You-told-us chips, not raw tags (HACK-158, VAL-UX-005)", () => {
  // The typed talk surface (same harness as the shield tests above,
  // re-declared here — those helpers are describe-local).
  async function typingMode(): Promise<{
    container: HTMLElement;
    act: (fn: () => Promise<void> | void) => Promise<void>;
  }> {
    const rendered = await renderChat();
    await beginMode(rendered.container, rendered.act, "voice-plus-typing");
    await rendered.act(async () => {
      q(rendered.container, "switch-to-typing")?.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    return rendered;
  }

  async function typeText(
    container: HTMLElement,
    act: (fn: () => Promise<void> | void) => Promise<void>,
    text: string,
  ): Promise<void> {
    await act(async () => {
      const ta = container.querySelector("textarea") as HTMLTextAreaElement;
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )!.set!;
      setter.call(ta, text);
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  // A turn response whose redacted transcript carries the server's marker
  // (the county answer from the ticket's repro) beside plain typed words.
  function stubMarkerTurn(): void {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/conversation/history") {
          return historyResponse();
        }
        if (url === "/api/conversation/turn") {
          turnCalls.push({
            headers: new Headers(init?.headers),
            body: String(init?.body),
          });
          return new Response(
            JSON.stringify({
              assistantReply: "Thanks. What is your zip code?",
              assistantTurnId: "turn-9",
              redactedUserTranscript:
                'North Carolina, [redacted answer to "Which county or city area do you live in?"].',
              nextQuestionId: "state",
              state: EMPTY_STATE,
              voiceUrl: null,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
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

  it("the person's bubble renders the redaction marker as a You-told-us chip, never raw bracket text", async () => {
    const { container, act } = await typingMode();
    stubMarkerTurn();
    await typeText(container, act, "North Carolina, Mecklenburg County.");
    await act(async () => {
      (
        container.querySelector('button[type="submit"]') as HTMLButtonElement
      )?.click();
    });
    // The raw tag is gone from the screen…
    const text = container.textContent ?? "";
    expect(text).not.toContain("[redacted answer to");
    expect(text).not.toContain("[redacted");
    // …the typed words around it are exactly as typed…
    expect(text).toContain("North Carolina,");
    // …and the chip the answers list uses renders inside the person's own
    // bubble, announcing "You told us" (the known status label).
    const bubble = Array.from(
      container.querySelectorAll("[data-conversation-transcript] > li"),
    ).find((li) => li.textContent?.includes("You said:"));
    expect(bubble).toBeDefined();
    const chip = bubble?.querySelector('[data-status="known"]');
    expect(chip).not.toBeNull();
    expect(chip?.getAttribute("aria-label")).toBe("You told us");
    expect(chip?.textContent).toContain("You told us");
  });

  it("the intro and the input help claim only what is true", async () => {
    const { container } = await typingMode();
    const text = container.textContent ?? "";
    // The old over-claims are gone…
    expect(text).not.toContain("never show up on this screen");
    expect(text).not.toContain("never the values themselves");
    expect(text).not.toContain("Private details stay private");
    // …replaced with what actually happens: only PRIVATE answers are
    // withheld (as the chip), typed words stay visible.
    expect(text).toContain("Answers to private questions show as");
  });
});
