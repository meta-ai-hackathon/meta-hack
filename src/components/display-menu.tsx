"use client";

import { useEffect, useRef, useState } from "react";
import { DisplayControls } from "./display-controls";

// The header's display menu (HACK-166). The text size and contrast
// controls (HACK-84) used to sit in the header itself, where on a phone
// they wrapped under the logo and took about a quarter of the first
// screen. They now open from one button, a disclosure that keeps them one
// tab stop from the top of every page.
//
// The controls stay mounted while the menu is closed, so the stored
// settings still load and apply on every page, and the polite status
// region they own is never torn down. Escape closes the menu and, if focus
// was in it, returns focus to its button. A press anywhere outside the menu
// closes it, and so does keyboard focus leaving it. The "Aa" glyph and the
// arrow are decorative; each visible label is part of the button's name.

export const DISPLAY_MENU_PANEL_ID = "display-menu-panel";

export function DisplayMenu() {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement | null>(null);
  const button = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    function closeOnOutsidePress(event: Event): void {
      if (event.target instanceof Node && root.current?.contains(event.target)) {
        return;
      }
      setOpen(false);
    }
    function closeOnEscape(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        // Focus goes back to the button only if it was in the menu, so
        // Escape never pulls focus away from somewhere else on the page.
        const focused = document.activeElement;
        const focusWasInside = focused instanceof Node && root.current?.contains(focused) === true;
        setOpen(false);
        if (focusWasInside) {
          button.current?.focus();
        }
      }
    }
    document.addEventListener("pointerdown", closeOnOutsidePress);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePress);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <div
      ref={root}
      data-display-menu
      className="relative"
      onBlur={(event) => {
        // Keyboard focus leaving the menu closes it, so the open panel never
        // sits over the field someone just tabbed to.
        const next = event.relatedTarget;
        if (open && next instanceof Node && !event.currentTarget.contains(next)) {
          setOpen(false);
        }
      }}
    >
      <button
        ref={button}
        type="button"
        data-display-menu-button
        aria-label="Text size and contrast"
        aria-expanded={open}
        aria-controls={DISPLAY_MENU_PANEL_ID}
        onClick={() => setOpen((current) => !current)}
        className="flex items-center gap-2 rounded-full border border-surface-border bg-surface px-4 py-2 text-base font-semibold hover:bg-teal-soft"
      >
        <span aria-hidden="true" className="font-display text-lg leading-none">
          Aa
        </span>
        <span aria-hidden="true" data-button-label className="min-[761px]:hidden">
          Text size
        </span>
        <span aria-hidden="true" data-button-label className="hidden min-[761px]:inline">
          Text size and contrast
        </span>
        <span aria-hidden="true" className={`text-sm transition-transform ${open ? "rotate-180" : ""}`}>
          ▾
        </span>
      </button>
      <div
        id={DISPLAY_MENU_PANEL_ID}
        data-display-menu-panel
        hidden={!open}
        className="absolute right-0 top-full z-40 mt-2 w-max max-w-[calc(100vw-2.5rem)] rounded-2xl border border-surface-border bg-surface p-4 shadow-lg"
      >
        <DisplayControls />
      </div>
    </div>
  );
}
