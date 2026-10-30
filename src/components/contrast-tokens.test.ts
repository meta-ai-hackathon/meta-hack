import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Contrast gate for the visual-polish design tokens (VAL-DEMOEXP-008): the
// Lovable design port must keep every text/background pairing at or above
// the PRE-POLISH baseline the a11y work shipped (docs/a11y-baseline.md):
// default text ~17:1 (#171717 on #ffffff measures 17.93), muted text 7.81
// (zinc-600 on white), and every component pair at WCAG AAA or better than
// its pre-polish counterpart. The minimums below ARE those baselines; the
// achieved ratios are recorded in the polish PR body.

const GLOBALS_PATH = join(
  fileURLToPath(new URL("..", import.meta.url)),
  "app/globals.css",
);

function parseTokenBlock(css: string, blockPattern: RegExp): Map<string, string> {
  const match = css.match(blockPattern);
  if (!match) {
    return new Map();
  }
  const tokens = new Map<string, string>();
  for (const m of match[1].matchAll(/(--[a-z-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) {
    tokens.set(m[1], m[2].toLowerCase());
  }
  return tokens;
}

function relativeLuminance(hex: string): number {
  const channels = [0, 2, 4].map((offset) => {
    const value = parseInt(hex.slice(1 + offset, 3 + offset), 16) / 255;
    return value <= 0.04045
      ? value / 12.92
      : Math.pow((value + 0.055) / 1.055, 2.4);
  });
  return (
    0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
  );
}

function contrastRatio(foreground: string, background: string): number {
  const l1 = relativeLuminance(foreground);
  const l2 = relativeLuminance(background);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

const css = readFileSync(GLOBALS_PATH, "utf8");
const light = parseTokenBlock(css, /:root\s*\{([^}]*)\}/);
const dark = parseTokenBlock(
  css,
  /prefers-color-scheme:\s*dark\s*\)\s*\{\s*:root\s*\{([^}]*)\}/,
);

/** Each pair: [foreground token, background token, required minimum, note]. */
const LIGHT_PAIRS: ReadonlyArray<[string, string, number, string]> = [
  ["--foreground", "--background", 17.93, "default text >= pre-polish default (#171717/#ffffff)"],
  ["--foreground", "--surface", 17.93, "default text on cards"],
  ["--foreground", "--amber-soft", 17.93, "default text on the warning/notice tint"],
  ["--foreground", "--danger-soft", 17.93, "default text on the destructive tint"],
  ["--muted", "--background", 7.81, "muted text >= pre-polish muted (zinc-600/#ffffff)"],
  ["--muted", "--surface", 7.81, "muted text on cards"],
  ["--muted", "--teal-soft", 7.81, "muted text on the info tint"],
  ["--muted", "--amber-soft", 7.81, "muted text on the warning tint"],
  ["--muted", "--danger-soft", 7.81, "muted text on the destructive tint"],
  ["--teal", "--background", 10.5, "teal accent text on the page"],
  ["--teal", "--surface", 10.5, "teal accent text on cards"],
  ["--teal", "--teal-soft", 10, "teal accent text on the info tint"],
  ["--amber-ink", "--amber-soft", 7.81, "warning label text (pre-polish amber-700/white was 5.02)"],
  ["--amber-ink", "--surface", 7.81, "warning label text on cards"],
  ["--teal-contrast", "--teal-deep", 12, "primary button label"],
  ["--teal-contrast", "--danger", 9, "destructive button label"],
  ["--danger-contrast", "--danger", 9, "destructive button label (purge surface, HACK-80)"],
  ["--danger", "--surface", 9, "danger erase marks on the erased card (purge surface, HACK-80)"],
];

const DARK_PAIRS: ReadonlyArray<[string, string, number, string]> = [
  ["--foreground", "--background", 16.91, "default text >= pre-polish dark default (#ededed/#0a0a0a)"],
  ["--foreground", "--surface", 15, "default text on dark cards"],
  ["--foreground", "--danger-soft", 15, "default text on the destructive tint, dark (purge surface, HACK-80)"],
  ["--muted", "--background", 7.72, "muted text >= pre-polish dark muted (zinc-400/#0a0a0a)"],
  ["--muted", "--surface", 7.3, "muted text on dark cards"],
  ["--teal", "--background", 11, "teal accent text on the dark page"],
  ["--teal", "--teal-soft", 10, "teal accent text on the dark info tint"],
  ["--amber-ink", "--amber-soft", 10, "warning label text, dark"],
  ["--danger", "--danger-soft", 9, "destructive label text, dark"],
  ["--teal-contrast", "--teal-deep", 15, "primary button label, dark"],
  ["--teal-contrast", "--danger", 9, "destructive button label, dark"],
  ["--danger-contrast", "--danger", 9, "destructive button label (purge surface, HACK-80)"],
  ["--danger", "--surface", 9, "danger erase marks on the erased card (purge surface, HACK-80)"],
];

/** Status-badge chips are mode-invariant (light chips in both schemes). */
const BADGE_PAIRS: ReadonlyArray<[string, string, number, string]> = [
  ["#0F3D3E", "#DFEBE6", 9.23, "known chip (pre-polish emerald pair measured 9.23)"],
  ["#4A3700", "#FCF6E3", 8.75, "unknown chip (pre-polish amber pair measured 8.75)"],
  ["#1C3560", "#E3E8F4", 8.87, "unverified chip (pre-polish sky pair measured 8.87)"],
];

describe("design-token contrast (VAL-DEMOEXP-008)", () => {
  it("parses the token blocks from globals.css", () => {
    for (const token of [
      "--background",
      "--foreground",
      "--surface",
      "--surface-border",
      "--muted",
      "--teal",
      "--teal-soft",
      "--teal-deep",
      "--teal-contrast",
      "--amber-soft",
      "--amber-ink",
      "--danger",
      "--danger-soft",
      "--danger-contrast",
    ]) {
      expect(light.get(token), `light ${token}`).toBeDefined();
      expect(dark.get(token), `dark ${token}`).toBeDefined();
    }
  });

  for (const [mode, tokens, pairs] of [
    ["light", light, LIGHT_PAIRS],
    ["dark", dark, DARK_PAIRS],
  ] as const) {
    describe(`${mode} scheme`, () => {
      for (const [fg, bg, minimum, note] of pairs) {
        it(`${fg} on ${bg} >= ${minimum} (${note})`, () => {
          const fgValue = tokens.get(fg);
          const bgValue = tokens.get(bg);
          expect(fgValue && bgValue, `${fg}/${bg} defined`).toBeTruthy();
          const achieved = contrastRatio(fgValue!, bgValue!);
          expect(
            achieved,
            `${fg} on ${bg}: achieved ${achieved.toFixed(2)}, minimum ${minimum}`,
          ).toBeGreaterThanOrEqual(minimum);
        });
      }
    });
  }

  for (const [fg, bg, minimum, note] of BADGE_PAIRS) {
    it(`badge ${fg} on ${bg} >= ${minimum} (${note})`, () => {
      expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(minimum);
    });
  }
});
