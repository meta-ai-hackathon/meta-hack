// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findBannedClaims } from "../lib/honesty";
import { deriveJourneyStages, JourneyNav } from "./journey-nav";

// VAL-FIX-003 (the entry/home shell): the sidebar lists the three journey
// stages (mode choice -> talk -> results); REACHED stages navigate and
// not-yet-reached stages are visibly locked. Reachability derives from
// the REAL engine state the app already serves (GET
// /api/conversation/history) — the nav never fabricates progress and
// never bypasses the engine's gating: navigating opens the conversation
// surface, whose stages the engine still governs.

describe("deriveJourneyStages (pure derivation)", () => {
  it("a fresh visitor has only the mode choice reached and current", () => {
    const stages = deriveJourneyStages({ begun: false, complete: false });
    expect(stages.map((stage) => stage.id)).toEqual([
      "mode-choice",
      "talk",
      "results",
    ]);
    expect(stages[0]).toMatchObject({ reached: true, current: true });
    expect(stages[1]).toMatchObject({ reached: false, current: false });
    expect(stages[2]).toMatchObject({ reached: false, current: false });
  });

  it("a begun conversation reaches the talk stage", () => {
    const stages = deriveJourneyStages({ begun: true, complete: false });
    expect(stages[1]).toMatchObject({ reached: true, current: false });
    expect(stages[2]).toMatchObject({ reached: false, current: false });
  });

  it("the engine's complete state reaches the results stage", () => {
    const stages = deriveJourneyStages({ begun: true, complete: true });
    expect(stages[2]).toMatchObject({ reached: true, current: false });
  });

  it("marks the requested stage current", () => {
    const stages = deriveJourneyStages(
      { begun: true, complete: false },
      "talk",
    );
    expect(stages[1]).toMatchObject({ current: true, reached: true });
    expect(stages[0]).toMatchObject({ current: false, reached: true });
  });
});

type Render = {
  container: HTMLElement;
  act: (fn: () => Promise<void> | void) => Promise<void>;
};

async function renderNav(history: {
  turns: number;
  complete: boolean;
} | null): Promise<Render> {
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      if (history === null) {
        throw new Error("history unavailable");
      }
      return new Response(
        JSON.stringify({
          turns: Array.from({ length: history.turns }, (_, index) => ({
            id: `turn-${index}`,
            role: "user",
            transcript: "redacted",
          })),
          state: {
            questions: [],
            answers: {},
            progress: { answered: 0, remaining: 1, total: 1 },
            currentIndex: 0,
            complete: history.complete,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }),
  );
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
    root.render(React.createElement(JourneyNav));
  });
  await act(async () => undefined);
  return { container, act };
}

const q = (container: HTMLElement, attr: string): Element | null =>
  container.querySelector(`[data-${attr}]`);

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("the rendered journey nav", () => {
  it("renders a labelled nav where reached stages are links and unreached are locked", async () => {
    const { container } = await renderNav({ turns: 0, complete: false });
    const nav = container.querySelector('nav[aria-label="Your journey"]');
    expect(nav).not.toBeNull();
    // The stage the person is on is a link marked current.
    const current = q(container, 'journey-stage-link="mode-choice"');
    expect(current?.getAttribute("aria-current")).toBe("step");
    // The not-yet-reached stages are visibly locked — never links.
    expect(q(container, 'journey-stage-locked="talk"')).not.toBeNull();
    expect(q(container, 'journey-stage-locked="results"')).not.toBeNull();
    expect(container.innerHTML).toContain("(locked");
    expect(q(container, 'journey-stage-link="talk"')).toBeNull();
    expect(q(container, 'journey-stage-link="results"')).toBeNull();
  });

  it("reflects real journey progress: a begun conversation unlocks the talk stage", async () => {
    const { container } = await renderNav({ turns: 2, complete: false });
    const talk = q(container, 'journey-stage-link="talk"');
    expect(talk).not.toBeNull();
    expect(talk?.getAttribute("href")).toBe("/intake/conversation");
    expect(q(container, 'journey-stage-locked="talk"')).toBeNull();
    // The results stage stays locked until the engine reports complete.
    expect(q(container, 'journey-stage-locked="results"')).not.toBeNull();
  });

  it("a completed journey unlocks the results stage", async () => {
    const { container } = await renderNav({ turns: 4, complete: true });
    const results = q(container, 'journey-stage-link="results"');
    expect(results).not.toBeNull();
    expect(results?.getAttribute("href")).toBe("/intake/conversation");
  });

  it("a history failure keeps the honest fresh-visitor defaults — nothing unlocked by guesswork", async () => {
    const { container } = await renderNav(null);
    expect(q(container, 'journey-stage-link="mode-choice"')).not.toBeNull();
    expect(q(container, 'journey-stage-locked="talk"')).not.toBeNull();
    expect(q(container, 'journey-stage-locked="results"')).not.toBeNull();
  });

  it("stays banned-claim clean", async () => {
    const { container } = await renderNav({ turns: 0, complete: false });
    expect(findBannedClaims(container.innerHTML)).toEqual([]);
  });
});
