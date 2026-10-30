"use client";

import { useEffect, useState } from "react";
import {
  DEFAULT_DISPLAY_SETTINGS,
  TEXT_ZOOM_STEPS,
  canStepZoom,
  loadDisplaySettings,
  saveDisplaySettings,
  setHighContrast,
  stepZoom,
  zoomFontSizePercent,
  type DisplaySettings,
} from "../lib/display";
import { StatusRegion } from "./status-region";

// Display controls (HACK-84): huge-text zoom + high contrast, reachable on
// every page through the app shell. The settings apply as `data-*`
// attributes on <html> that globals.css keys off (root font-size percent
// for zoom, pure black/white tokens for contrast), persist per device,
// and announce every change through the polite live region. All surfaces
// sized in rem (intake, review, consent, purge) scale together; the
// controls are ordinary keyboard-operable buttons, so the controls to fix
// unreadable text never themselves require readable text first.

/** Apply one settings object to the document root. */
function applyToRoot(settings: DisplaySettings): void {
  const root = document.documentElement;
  if (settings.zoomIndex === 0) {
    root.removeAttribute("data-text-zoom");
    root.style.removeProperty("font-size");
  } else {
    root.setAttribute("data-text-zoom", zoomFontSizePercent(settings));
    root.style.fontSize = zoomFontSizePercent(settings);
  }
  if (settings.highContrast) {
    root.setAttribute("data-contrast", "high");
  } else {
    root.removeAttribute("data-contrast");
  }
}

export function DisplayControls() {
  // First render (server + client) uses the safe defaults; the stored
  // settings load after mount, matching the ConsentGate hydration rule.
  const [settings, setSettings] =
    useState<DisplaySettings>(DEFAULT_DISPLAY_SETTINGS);
  const [notice, setNotice] = useState("");

  // Deferred a microtask past hydration; cleaned up on unmount.
  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (!cancelled) {
        const loaded = loadDisplaySettings();
        setSettings(loaded);
        applyToRoot(loaded);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  function apply(next: DisplaySettings, message: string): void {
    setSettings(next);
    saveDisplaySettings(next);
    applyToRoot(next);
    setNotice(message);
  }

  const percent = zoomFontSizePercent(settings);
  const atMax = !canStepZoom(settings, 1);
  const atMin = !canStepZoom(settings, -1);

  return (
    <section
      aria-label="Text size and contrast"
      data-display-controls
      className="flex flex-wrap items-center gap-x-6 gap-y-3"
    >
      <p className="text-base font-semibold">Text size and contrast</p>
      <div className="flex items-center gap-2">
        <button
          type="button"
          data-zoom-out
          disabled={atMin}
          onClick={() =>
            apply(stepZoom(settings, -1), `Text size ${zoomFontSizePercent(stepZoom(settings, -1))}.`)
          }
          className="rounded-md border border-zinc-300 px-3 py-2 text-base font-semibold hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-600 dark:hover:bg-zinc-800"
        >
          Smaller
        </button>
        <span data-zoom-level aria-hidden="true" className="min-w-14 text-center text-base font-medium">
          {percent}
        </span>
        <button
          type="button"
          data-zoom-in
          disabled={atMax}
          onClick={() =>
            apply(stepZoom(settings, 1), `Text size ${zoomFontSizePercent(stepZoom(settings, 1))}.`)
          }
          className="rounded-md border border-zinc-300 px-3 py-2 text-base font-semibold hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-600 dark:hover:bg-zinc-800"
        >
          Bigger
        </button>
      </div>
      <div className="flex items-center gap-2">
        <input
          id="display-high-contrast"
          type="checkbox"
          checked={settings.highContrast}
          onChange={(event) =>
            apply(
              setHighContrast(settings, event.target.checked),
              event.target.checked
                ? "High contrast on."
                : "High contrast off.",
            )
          }
          className="h-5 w-5 shrink-0"
        />
        <label htmlFor="display-high-contrast" className="text-base font-medium">
          High contrast
        </label>
      </div>
      <StatusRegion message={notice} className="sr-only" />
    </section>
  );
}

// Re-exported for tests that assert the ladder the UI is bounded by.
export { TEXT_ZOOM_STEPS };
