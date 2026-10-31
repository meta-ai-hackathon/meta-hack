// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PresenceOrb } from "./presence-orb";
import type { VoiceDeckPhase } from "./voice-deck";

// The presence orb (VAL-VJS-005): an ambient, decorative animation layer
// bound to the voice-session state machine. It must stay aria-hidden (the
// state bar / StatusRegion text carries the state — never animation-only),
// hold a fixed frame (no layout shift), contain nothing focusable (no
// keyboard traps), pause while the document is hidden, and add no new
// dependencies. All motion lives in CSS only — and ONLY inside the
// prefers-reduced-motion: no-preference block of globals.css, so
// reduced-motion users get the static glow variant by construction.

// jsdom vitest rewrites import.meta.url to the page URL, so source-file
// paths resolve from the repo root (tests run from there).
const cssPath = join(process.cwd(), "src", "app", "globals.css");

function setHidden(hidden: boolean): void {
  Object.defineProperty(document, "hidden", {
    configurable: true,
    get: () => hidden,
  });
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => (hidden ? "hidden" : "visible"),
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

async function renderOrb(phase: VoiceDeckPhase | null): Promise<HTMLElement> {
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await React.act(async () => {
    root.render(React.createElement(PresenceOrb, { phase }));
  });
  return container;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  document.body.replaceChildren();
  // Drop the test's document.hidden override so later suites see jsdom's
  // real (visible) default.
  for (const key of ["hidden", "visibilityState"] as const) {
    delete (document as unknown as Record<string, unknown>)[key];
  }
});

describe("the presence orb (VAL-VJS-005)", () => {
  it("renders as a decorative aria-hidden element carrying the phase", async () => {
    const container = await renderOrb("listening");
    const orb = container.querySelector("[data-presence-orb]");
    expect(orb).not.toBeNull();
    expect(orb?.getAttribute("aria-hidden")).toBe("true");
    expect(orb?.getAttribute("data-orb-phase")).toBe("listening");
  });

  it("reflects every voice state, with an ambient idle when no phase runs", async () => {
    for (const phase of [
      "listening",
      "transcribing",
      "thinking",
      "speaking",
    ] as const) {
      const container = await renderOrb(phase);
      expect(
        container.querySelector("[data-presence-orb]")?.getAttribute("data-orb-phase"),
      ).toBe(phase);
    }
    const idle = await renderOrb(null);
    expect(
      idle.querySelector("[data-presence-orb]")?.getAttribute("data-orb-phase"),
    ).toBe("idle");
  });

  it("pauses while the document is hidden and resumes when it returns", async () => {
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await React.act(async () => {
      root.render(React.createElement(PresenceOrb, { phase: "listening" }));
    });
    const orb = () =>
      container.querySelector("[data-presence-orb]") as HTMLElement;
    expect(orb().getAttribute("data-document-hidden")).toBe("false");

    await React.act(async () => {
      setHidden(true);
    });
    expect(orb().getAttribute("data-document-hidden")).toBe("true");

    await React.act(async () => {
      setHidden(false);
    });
    expect(orb().getAttribute("data-document-hidden")).toBe("false");
  });

  it("contains nothing focusable — no keyboard traps", async () => {
    const container = await renderOrb("thinking");
    const focusables = container
      .querySelector("[data-presence-orb]")
      ?.querySelectorAll("button, a, input, select, textarea, [tabindex]");
    expect(focusables?.length ?? 0).toBe(0);
  });

  it("reserves a fixed frame in CSS — motion cannot shift layout", () => {
    const css = readFileSync(cssPath, "utf8");
    const frame = css.slice(
      css.indexOf(".presence-orb-frame {"),
      css.indexOf("}", css.indexOf(".presence-orb-frame {")),
    );
    expect(frame).toContain("width:");
    expect(frame).toContain("height:");
  });

  it("defines orb motion ONLY inside the no-preference block (reduced-motion static variant)", () => {
    const css = readFileSync(cssPath, "utf8");
    const marker = "@media (prefers-reduced-motion: no-preference)";
    const start = css.indexOf(marker);
    expect(start).toBeGreaterThan(-1);
    // Excise the no-preference block by brace matching, so "outside" is
    // genuinely everything a reduced-motion user's engine applies.
    const blockStart = css.indexOf("{", start);
    let depth = 0;
    let end = css.length;
    for (let i = blockStart; i < css.length; i += 1) {
      if (css[i] === "{") {
        depth += 1;
      } else if (css[i] === "}") {
        depth -= 1;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    const outside = css.slice(0, start) + css.slice(end);
    // Static orb styles may live outside (they ARE the reduced-motion
    // variant); MOTION may not.
    for (const line of outside.split("\n")) {
      if (line.includes("presence-orb")) {
        expect(
          line,
          `motion outside the reduced-motion guard: ${line.trim()}`,
        ).not.toMatch(/animation|transition/);
      }
    }
    const block = css.slice(start, end);
    for (const phase of ["idle", "listening", "transcribing", "thinking", "speaking"]) {
      expect(
        block,
        `missing ${phase} motion in the no-preference block`,
      ).toContain(`data-orb-phase="${phase}"`);
    }
    // The document-hidden pause rule lives in the same block.
    expect(block).toContain('data-document-hidden="true"');
    expect(block).toContain("animation-play-state: paused");
  });
});
