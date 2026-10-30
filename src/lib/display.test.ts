import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_DISPLAY_SETTINGS,
  HIGH_CONTRAST_ROLES,
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

  const cssPath = join(
    fileURLToPath(new URL("../app", import.meta.url)),
    "globals.css",
  );

  it("globals.css carries exactly the THEME_PAIRS values", () => {
    const css = readFileSync(cssPath, "utf8");
    for (const pair of Object.values(THEME_PAIRS)) {
      expect(css).toContain(`--background: ${pair.background};`);
      expect(css).toContain(`--foreground: ${pair.foreground};`);
    }
    expect(css).toContain(':root[data-contrast="high"] :disabled');
  });

  it("globals.css role rules implement HIGH_CONTRAST_ROLES exactly", () => {
    // PR #51 re-review P3: parse the actual role rules out of the CSS
    // instead of comparing a hand-written copy against constants, so CSS
    // drift fails this test.
    const css = readFileSync(cssPath, "utf8");
    const roleRule = (property: string, value: string) =>
      new RegExp(`${property}: var\\(--${value}\\) !important;`);
    expect(css).toMatch(roleRule("color", HIGH_CONTRAST_ROLES.text));
    expect(css).toMatch(
      roleRule("background-color", HIGH_CONTRAST_ROLES.background),
    );
    expect(css).toMatch(roleRule("border-color", HIGH_CONTRAST_ROLES.border));
    // Every text/bg/border role resolves to the theme pair, so any
    // combination of zinc utilities is foreground-on-background: 21:1.
    for (const scheme of ["highLight", "highDark"] as const) {
      const theme = THEME_PAIRS[scheme];
      expect(
        contrastRatio(theme.foreground, theme.background),
      ).toBeCloseTo(21, 0);
    }
  });

  it("every zinc utility used in components has a high-contrast role rule", () => {
    // Closes the loop the re-review asked for: a new zinc text/bg/border
    // class anywhere in the UI without a matching role override fails here
    // instead of silently rendering same-on-same in high contrast.
    const css = readFileSync(cssPath, "utf8");
    const srcRoot = fileURLToPath(new URL("..", import.meta.url));
    const componentFiles: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (/\.(tsx|ts)$/.test(entry.name) && !/\.test\./.test(entry.name)) {
          componentFiles.push(full);
        }
      }
    };
    walk(srcRoot);
    const used = new Set<string>();
    const pattern = /\b(text|bg|border)-zinc-\d+\b/g;
    for (const file of componentFiles) {
      for (const match of readFileSync(file, "utf8").matchAll(pattern)) {
        used.add(match[0]);
      }
    }
    expect(used.size).toBeGreaterThan(0);
    for (const className of used) {
      expect(css, `missing role rule for .${className}`).toContain(`.${className}`);
    }
    // Hover inversion and the non-color disabled cue ride along.
    expect(css).toContain(':root[data-contrast="high"] :is(button');
    expect(css).toContain("border-style: dashed;");
    expect(css).toContain("cursor: not-allowed;");
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
