// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONSENT_PROVIDER_ID,
  saveConsentReceipt,
  type ConsentReceipt,
} from "../../../lib/consent";
import type { IntakeClientState } from "../../../lib/intake/serialize";
import { ConversationChat } from "./conversation-chat";

// VAL-FIX-006 (owner directive, "literally copy the Lovable layout"): the
// talk stage and entry surfaces reproduce the prototype's product-frame
// geometry from mission research/lovable-layout/ (VoiceReview.tsx +
// styles-voice.css): grid minmax(0,1fr) 195px (padding 35px 32px 20px,
// gap 30px), the Coming Together sidebar as a fixed 195px right rail
// (border-left, padding-left 23px, padding-top 6px), the transcript pane
// at the .voice-scroll 620px max-height scroll, the full-width bottom
// session deck (padding 15px 32px 0) with the honesty strip bleeding to
// the frame edges (margin 0 -32px), the entry content centered at 490px
// (width calc(100% - 48px), margin 42px auto 26px), and the prototype's
// breakpoint rules at 1100px/760px. jsdom cannot compute Tailwind CSS,
// so these are class-level pins of the prototype's exact values; the
// geometry itself is measured in a real browser (1280x800, 1440x900,
// 375px) per the validation contract. The gate-gated copy is prod's own
// — nothing here is word-derived from the prototype.

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
};

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
): Promise<void> {
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
}

describe("the talk-stage frame geometry (VAL-FIX-006)", () => {
  it("lays the stage out on the prototype grid: fluid column + fixed 195px rail, 35px 32px 20px paddings, 30px gap", async () => {
    const { container, act } = await renderChat();
    await beginTalkStage(container, act);
    const aside = q(container, "coming-together");
    expect(aside).not.toBeNull();
    // The stage grid: two tracks — the fluid conversation column and the
    // fixed 195px right rail — with the prototype's paddings and gap.
    // 1100px rule: the grid collapses to one column (the rail hides);
    // 760px rule: single-column paddings.
    const grid = aside?.parentElement?.className ?? "";
    expect(grid).toContain(
      "min-[1101px]:grid-cols-[minmax(0,1fr)_195px]",
    );
    expect(grid).toContain("min-[761px]:grid-cols-[minmax(0,1fr)]");
    expect(grid).toContain("min-[761px]:gap-[30px]");
    expect(grid).toContain("min-[761px]:pt-[35px]");
    expect(grid).toContain("min-[761px]:px-8");
    expect(grid).toContain("min-[761px]:pb-5");
    expect(grid).toContain("px-5");
    expect(grid).toContain("pt-7");
  });

  it("renders the Coming Together sidebar as a right rail: border-left, 23px left padding, hidden below 1101px", async () => {
    const { container, act } = await renderChat();
    await beginTalkStage(container, act);
    const aside = q(container, "coming-together");
    expect(aside).not.toBeNull();
    const rail = aside?.className ?? "";
    expect(rail).toContain("border-l");
    expect(rail).toContain("pl-[23px]");
    expect(rail).toContain("pt-1.5");
    // The 1100px breakpoint rule: the rail collapses (hidden) until the
    // wide grid returns.
    expect(rail).toContain("hidden");
    expect(rail).toContain("min-[1101px]:flex");
  });

  it("caps the transcript pane at the prototype's 620px scroll height", async () => {
    const { container, act } = await renderChat();
    await beginTalkStage(container, act);
    const pane = q(container, "transcript-pane");
    expect(pane).not.toBeNull();
    // The .voice-scroll equivalence: max-height 620px, overflow-y auto —
    // with the VAL-FIX-002 positioning context and clip intact.
    expect(pane?.className).toContain("max-h-[620px]");
    expect(pane?.className).toContain("overflow-y-auto");
    expect(pane?.className).toContain("relative");
  });

  it("spans the bottom session deck across the full frame width with the prototype's 15px 32px 0 padding", async () => {
    const { container, act } = await renderChat();
    await beginTalkStage(container, act);
    await act(async () => {
      sessionCallbacks.onPhase("listening");
    });
    const bottom = q(container, "voice-bottom");
    expect(bottom).not.toBeNull();
    const pad = bottom?.className ?? "";
    expect(pad).toContain("min-[761px]:px-8");
    expect(pad).toContain("min-[761px]:pt-[15px]");
    expect(pad).toContain("px-4");
    expect(pad).toContain("pt-[10px]");
  });

  it("carries the session bar anatomy: 44px status icon, title/caption, waveform pushed right, 44px pause circle", async () => {
    const { container, act } = await renderChat();
    await beginTalkStage(container, act);
    await act(async () => {
      sessionCallbacks.onPhase("listening");
    });
    const deck = q(container, "voice-deck");
    expect(deck).not.toBeNull();
    expect(deck?.getAttribute("data-voice-session")).toBe("active");
    const icon = q(container, "voice-session-icon");
    expect(icon?.className).toContain("h-11");
    expect(icon?.className).toContain("w-11");
    expect(icon?.className).toContain("rounded-full");
    // The waveform is pushed to the bar's right edge (margin-left auto).
    expect(q(container, "voice-wave-slot")?.className).toContain("ml-auto");
    // The pause control is the prototype's 44px circle.
    const pause = q(container, "voice-pause");
    expect(pause).not.toBeNull();
    expect(pause?.className).toContain("h-11");
    expect(pause?.className).toContain("w-11");
    expect(pause?.className).toContain("rounded-full");
    // The four state captions keep their validated copy, in the bar.
    expect(deck?.textContent).toContain(
      "Listening — go ahead, we're right here.",
    );
  });

  it("bleeds the honesty strip to the frame edges (margin 0 -32px) with prod's own honesty sentence", async () => {
    const { container, act } = await renderChat();
    await beginTalkStage(container, act);
    await act(async () => {
      sessionCallbacks.onPhase("listening");
    });
    const strip = q(container, "honesty-strip");
    expect(strip).not.toBeNull();
    const bleed = strip?.className ?? "";
    expect(bleed).toContain("min-[761px]:-mx-8");
    expect(bleed).toContain("-mx-4");
    expect(bleed).toContain("border-t");
    // The words are prod's honesty sentence, word-identical — the
    // prototype's placeholder copy is NOT rendered anywhere.
    expect(strip?.textContent).toContain(
      "Nothing is submitted — you decide what happens next.",
    );
  });
});

describe("the entry-stage frame geometry (VAL-FIX-006)", () => {
  it("centers the entry content at the prototype's 490px inside the full-width frame", async () => {
    const { container, act } = await renderChat();
    await act(async () => {
      saveConsentReceipt(voiceReceipt());
    });
    const entry = q(container, "mode-choice");
    expect(entry).not.toBeNull();
    const geometry = entry?.className ?? "";
    expect(geometry).toContain("mx-auto");
    expect(geometry).toContain("max-w-[490px]");
    expect(geometry).toContain("min-[761px]:w-[calc(100%_-_48px)]");
    expect(geometry).toContain("w-[calc(100%_-_36px)]");
    expect(geometry).toContain("min-[761px]:mt-[42px]");
    expect(geometry).toContain("mb-[26px]");
  });
});
