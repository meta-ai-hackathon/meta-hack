import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_DISPLAY_SETTINGS,
  TEXT_ZOOM_STEPS,
  THEME_PAIRS,
  canStepZoom,
  clampZoomIndex,
  contrastRatio,
  displayAttributes,
  parseDisplaySettings,
  serializeDisplaySettings,
  setHighContrast,
  stepZoom,
  zoomFontSizePercent,
  zoomScale,
} from "./display";

// Display-settings invariants (HACK-84). The properties that matter are
// the ones a bug could silently break: a stored value escaping the zoom
// ladder, a step that wraps from huge back to tiny, a parse that invents
// contrast, or a "high contrast" theme that is not numerically higher.

const settingsArb = fc.record({
  zoomIndex: fc.integer({ min: -5, max: 12 }),
  highContrast: fc.boolean(),
});

/** A settings object the UI can actually hold: index clamped onto the ladder. */
function reachable(settings: { zoomIndex: number; highContrast: boolean }) {
  return {
    zoomIndex: clampZoomIndex(settings.zoomIndex),
    highContrast: settings.highContrast,
  };
}

describe("zoom ladder", () => {
  it("is increasing, starts at the unmodified default, and tops out super huge", () => {
    expect(TEXT_ZOOM_STEPS[0]).toBe(1);
    expect(TEXT_ZOOM_STEPS[TEXT_ZOOM_STEPS.length - 1]).toBeGreaterThanOrEqual(2.5);
    for (let index = 1; index < TEXT_ZOOM_STEPS.length; index += 1) {
      expect(TEXT_ZOOM_STEPS[index]).toBeGreaterThan(TEXT_ZOOM_STEPS[index - 1]);
    }
  });

  it("keeps every reachable scale inside the ladder, however the index is reached", () => {
    fc.assert(
      fc.property(settingsArb, (settings) => {
        const scale = zoomScale(settings);
        expect(scale).toBeGreaterThanOrEqual(TEXT_ZOOM_STEPS[0]);
        expect(scale).toBeLessThanOrEqual(
          TEXT_ZOOM_STEPS[TEXT_ZOOM_STEPS.length - 1],
        );
        expect(TEXT_ZOOM_STEPS).toContain(scale);
      }),
    );
  });

  it("steps monotonically and clamps at both ends — never wraps", () => {
    fc.assert(
      fc.property(settingsArb, (raw) => {
        // Stepping up saturates at the top step and then stays there.
        let up = reachable(raw);
        while (canStepZoom(up, 1)) {
          const next = stepZoom(up, 1);
          expect(next.zoomIndex).toBeGreaterThan(up.zoomIndex);
          up = next;
        }
        expect(up.zoomIndex).toBe(TEXT_ZOOM_STEPS.length - 1);
        expect(stepZoom(up, 1).zoomIndex).toBe(up.zoomIndex);
        // Stepping down saturates at the default and then stays there.
        let down = up;
        while (canStepZoom(down, -1)) {
          const next = stepZoom(down, -1);
          expect(next.zoomIndex).toBeLessThan(down.zoomIndex);
          down = next;
        }
        expect(down.zoomIndex).toBe(0);
        expect(stepZoom(down, -1).zoomIndex).toBe(0);
        expect(zoomScale(down)).toBe(1);
      }),
    );
  });

  it("renders the scale as a round CSS percentage of the ladder value", () => {
    fc.assert(
      fc.property(settingsArb, (settings) => {
        expect(zoomFontSizePercent(settings)).toBe(
          `${Math.round(zoomScale(settings) * 100)}%`,
        );
      }),
    );
  });
});

describe("stored settings", () => {
  it("round-trips any reachable settings object", () => {
    fc.assert(
      fc.property(settingsArb, (settings) => {
        const parsed = parseDisplaySettings(serializeDisplaySettings(settings));
        expect(parsed.zoomIndex).toBe(clampZoomIndex(settings.zoomIndex));
        expect(parsed.highContrast).toBe(settings.highContrast === true);
      }),
    );
  });

  it("never parses an arbitrary blob into an out-of-ladder zoom", () => {
    fc.assert(
      fc.property(fc.string(), (raw) => {
        const parsed = parseDisplaySettings(raw);
        expect(parsed.zoomIndex).toBeGreaterThanOrEqual(0);
        expect(parsed.zoomIndex).toBeLessThan(TEXT_ZOOM_STEPS.length);
        expect(typeof parsed.highContrast).toBe("boolean");
      }),
    );
  });

  it("fails safe on the classic corrupts", () => {
    expect(parseDisplaySettings(null)).toEqual(DEFAULT_DISPLAY_SETTINGS);
    expect(parseDisplaySettings("not json")).toEqual(DEFAULT_DISPLAY_SETTINGS);
    expect(parseDisplaySettings('{"zoomIndex": 99}').zoomIndex).toBe(
      TEXT_ZOOM_STEPS.length - 1,
    );
    expect(parseDisplaySettings('{"zoomIndex": -3}').zoomIndex).toBe(0);
    expect(parseDisplaySettings('{"highContrast": "yes"}').highContrast).toBe(false);
  });
});

describe("root attributes", () => {
  it("omits both attributes at the defaults, so the baseline render is untouched", () => {
    expect(displayAttributes(DEFAULT_DISPLAY_SETTINGS)).toEqual({});
  });

  it("carries exactly the percentage and the high-contrast flag", () => {
    const zoomed = displayAttributes({ zoomIndex: 3, highContrast: true });
    expect(zoomed["data-text-zoom"]).toBe("200%");
    expect(zoomed["data-contrast"]).toBe("high");
  });
});

describe("contrast themes", () => {
  it("computes the WCAG ratio for known pairs", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 0);
    expect(contrastRatio("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
  });

  it("high contrast beats the already-strong baseline in both schemes", () => {
    const baselineLight = contrastRatio(
      THEME_PAIRS.light.foreground,
      THEME_PAIRS.light.background,
    );
    const baselineDark = contrastRatio(
      THEME_PAIRS.dark.foreground,
      THEME_PAIRS.dark.background,
    );
    expect(baselineLight).toBeGreaterThan(15); // documented ~17:1 baseline
    const highLight = contrastRatio(
      THEME_PAIRS.highLight.foreground,
      THEME_PAIRS.highLight.background,
    );
    const highDark = contrastRatio(
      THEME_PAIRS.highDark.foreground,
      THEME_PAIRS.highDark.background,
    );
    expect(highLight).toBeGreaterThan(baselineLight);
    expect(highDark).toBeGreaterThan(baselineDark);
    expect(highLight).toBeCloseTo(21, 0);
    expect(highDark).toBeCloseTo(21, 0);
  });

  it("globals.css carries exactly the THEME_PAIRS values", () => {
    const css = readFileSync(
      join(fileURLToPath(new URL("../app", import.meta.url)), "globals.css"),
      "utf8",
    );
    for (const pair of Object.values(THEME_PAIRS)) {
      expect(css).toContain(`--background: ${pair.background};`);
      expect(css).toContain(`--foreground: ${pair.foreground};`);
    }
    expect(css).toContain("--color-zinc-500:");
    expect(css).toContain(':root[data-contrast="high"] :disabled');
  });
});

describe("high contrast toggle", () => {
  it("flips only the flag and never mutates its input", () => {
    fc.assert(
      fc.property(settingsArb, fc.boolean(), (settings, on) => {
        const snapshot = { ...settings };
        const next = setHighContrast(settings, on);
        expect(next.highContrast).toBe(on);
        expect(next.zoomIndex).toBe(settings.zoomIndex);
        expect(settings).toEqual(snapshot);
      }),
    );
  });
});
