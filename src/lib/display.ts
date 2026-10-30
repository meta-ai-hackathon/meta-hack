// Display settings (HACK-84): high contrast + huge-text zoom, per device.
// For this user population these are features, not niceties: the filmed
// demo includes both, and they must work on every intake surface.
//
// Design rules this module owns:
// - Settings live on the device (localStorage), never attached to answer
//   data, and corrupted or unknown stored values fail SAFE: zoom back to
//   the default step, contrast off (the BN-07 baseline is already ~17:1).
// - Zoom is a bounded ladder of discrete steps (not free text), so no
//   stored value can request an unbounded scale. The control clamps at
//   both ends; `stepZoom` never wraps.
// - The settings apply as attributes on <html> (`data-text-zoom`,
//   `data-contrast`) that CSS keys off — see globals.css. Tailwind's rem
//   utilities follow the root font-size, so every rem-sized surface
//   (intake, review, consent, purge) scales together.

/** localStorage key for display settings. Carries no answer data. */
export const DISPLAY_STORAGE_KEY = "bn_display_v1";

/**
 * The zoom ladder, root font-size multipliers. Index 0 is the unmodified
 * default. The top step is 2.5x — "super huge" — while containers use
 * fluid (max-width + wrap) layouts so text grows without horizontal
 * scrolling at phone widths (verified in docs/a11y-baseline.md terms by
 * the component tests: steps are data, the CSS only multiplies).
 */
export const TEXT_ZOOM_STEPS = [1, 1.25, 1.5, 2, 2.5] as const;

export const DEFAULT_ZOOM_INDEX = 0;

export interface DisplaySettings {
  /** Index into TEXT_ZOOM_STEPS. */
  readonly zoomIndex: number;
  readonly highContrast: boolean;
}

export const DEFAULT_DISPLAY_SETTINGS: DisplaySettings = {
  zoomIndex: DEFAULT_ZOOM_INDEX,
  highContrast: false,
};

/** The root font-size multiplier for a settings object. */
export function zoomScale(settings: DisplaySettings): number {
  return TEXT_ZOOM_STEPS[clampZoomIndex(settings.zoomIndex)];
}

/** The multiplier as the CSS percentage the root font-size is set to. */
export function zoomFontSizePercent(settings: DisplaySettings): string {
  return `${Math.round(zoomScale(settings) * 100)}%`;
}

/** Clamp any index onto the ladder (0 = the unmodified default). */
export function clampZoomIndex(index: number): number {
  if (!Number.isFinite(index)) {
    return DEFAULT_ZOOM_INDEX;
  }
  return Math.min(
    Math.max(Math.trunc(index), 0),
    TEXT_ZOOM_STEPS.length - 1,
  );
}

/**
 * Move the zoom one step, clamped at both ends (never wraps). Any
 * direction other than +1/-1 is treated as "no move", so a caller bug
 * cannot teleport the scale.
 */
export function stepZoom(
  settings: DisplaySettings,
  direction: 1 | -1,
): DisplaySettings {
  if (direction !== 1 && direction !== -1) {
    return { ...settings, zoomIndex: clampZoomIndex(settings.zoomIndex) };
  }
  return {
    ...settings,
    zoomIndex: clampZoomIndex(settings.zoomIndex + direction),
  };
}

/** Whether a further step in the direction exists. Drives disabled buttons. */
export function canStepZoom(
  settings: DisplaySettings,
  direction: 1 | -1,
): boolean {
  return stepZoom(settings, direction).zoomIndex !== clampZoomIndex(settings.zoomIndex);
}

/** Toggle (or set) high contrast, returning a NEW settings object. */
export function setHighContrast(
  settings: DisplaySettings,
  on: boolean,
): DisplaySettings {
  return { ...settings, highContrast: on === true };
}

/**
 * The attributes the root element carries for these settings. `data-*`
 * values are strings; the default zoom omits the attribute entirely so the
 * unmodified experience is untouched.
 */
export function displayAttributes(settings: DisplaySettings): {
  "data-text-zoom"?: string;
  "data-contrast"?: "high";
} {
  return {
    ...(settings.zoomIndex !== DEFAULT_ZOOM_INDEX
      ? { "data-text-zoom": zoomFontSizePercent(settings) }
      : {}),
    ...(settings.highContrast ? { "data-contrast": "high" as const } : {}),
  };
}

/**
 * Parse stored settings defensively. Malformed input degrades per-field:
 * an out-of-range or non-numeric zoom returns to the default step, a
 * non-boolean contrast to off. Nothing here can produce an index outside
 * the ladder.
 */
export function parseDisplaySettings(raw: string | null): DisplaySettings {
  if (raw === null || raw.trim() === "") {
    return DEFAULT_DISPLAY_SETTINGS;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_DISPLAY_SETTINGS;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return DEFAULT_DISPLAY_SETTINGS;
  }
  const candidate = parsed as { zoomIndex?: unknown; highContrast?: unknown };
  return {
    zoomIndex:
      typeof candidate.zoomIndex === "number"
        ? clampZoomIndex(candidate.zoomIndex)
        : DEFAULT_ZOOM_INDEX,
    highContrast: candidate.highContrast === true,
  };
}

/** Serialize for storage. Symmetric with `parseDisplaySettings`. */
export function serializeDisplaySettings(settings: DisplaySettings): string {
  return JSON.stringify({
    zoomIndex: clampZoomIndex(settings.zoomIndex),
    highContrast: settings.highContrast === true,
  });
}

interface DisplayStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The browser storage, when one exists (absent in server rendering/tests). */
export function browserDisplayStorage(): DisplayStorage | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

/** Load the stored settings; no storage means the safe defaults. */
export function loadDisplaySettings(
  storage: DisplayStorage | null = browserDisplayStorage(),
): DisplaySettings {
  if (!storage) {
    return DEFAULT_DISPLAY_SETTINGS;
  }
  try {
    return parseDisplaySettings(storage.getItem(DISPLAY_STORAGE_KEY));
  } catch {
    return DEFAULT_DISPLAY_SETTINGS;
  }
}

/** Persist the settings (no-op without storage). */
export function saveDisplaySettings(
  settings: DisplaySettings,
  storage: DisplayStorage | null = browserDisplayStorage(),
): void {
  if (!storage) {
    return;
  }
  try {
    storage.setItem(DISPLAY_STORAGE_KEY, serializeDisplaySettings(settings));
  } catch {
    // Storage can refuse (private mode, quota). Settings then last only
    // for this page view — never the reverse: a failed save must not stick
    // a zoom the user cannot undo.
  }
}

// ---------------------------------------------------------------------------
// Contrast math (WCAG 2.1 relative luminance) — used by the tests to prove
// the high-contrast theme actually beats the baseline numerically rather
// than by assertion. Kept dependency-free: the themes are two hex pairs.
// ---------------------------------------------------------------------------

function channelLuminance(channel: number): number {
  const srgb = channel / 255;
  return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(hex: string): number {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) {
    throw new Error(`not a 6-digit hex color: ${hex}`);
  }
  const value = match[1];
  const r = channelLuminance(parseInt(value.slice(0, 2), 16));
  const g = channelLuminance(parseInt(value.slice(2, 4), 16));
  const b = channelLuminance(parseInt(value.slice(4, 6), 16));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two hex colors (1..21). */
export function contrastRatio(foreground: string, background: string): number {
  const lighter = Math.max(
    relativeLuminance(foreground),
    relativeLuminance(background),
  );
  const darker = Math.min(
    relativeLuminance(foreground),
    relativeLuminance(background),
  );
  return (lighter + 0.05) / (darker + 0.05);
}

/** The themes as (foreground, background) hex pairs, mirrored in globals.css. */
export const THEME_PAIRS = {
  light: { foreground: "#171717", background: "#ffffff" },
  dark: { foreground: "#ededed", background: "#0a0a0a" },
  highLight: { foreground: "#000000", background: "#ffffff" },
  highDark: { foreground: "#ffffff", background: "#000000" },
} as const;

/**
 * The high-contrast ROLE mapping (PR #51 re-review): pair-safety is by
 * utility role, not palette shade — one `--color-zinc-*` variable serves
 * text, background and border utilities at once, so no shade remap can
 * keep every pair legible in both schemes. In high contrast every zinc
 * text utility resolves to the theme foreground, every zinc background
 * utility to the theme background, and every zinc border utility to the
 * theme foreground (see the role rules in globals.css). This constant is
 * the test-facing statement of that mapping; the CSS test parses the
 * actual role rules out of globals.css and compares against it.
 */
export const HIGH_CONTRAST_ROLES = {
  text: "foreground",
  background: "background",
  border: "foreground",
} as const;
