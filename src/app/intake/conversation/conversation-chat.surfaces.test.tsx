// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONSENT_PROVIDER_ID,
  saveConsentReceipt,
  type ConsentReceipt,
} from "../../../lib/consent";
import type { IntakeClientState } from "../../../lib/intake/serialize";
import { ConversationChat, MAX_PENDING_VOICE_TURNS } from "./conversation-chat";

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
};

let turnCalls: { headers: Headers; body: string }[] = [];

function historyResponse(): Response {
  return new Response(
    JSON.stringify({ turns: [], state: EMPTY_STATE }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

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
