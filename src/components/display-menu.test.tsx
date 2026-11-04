// @vitest-environment jsdom
import fc from "fast-check";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DISPLAY_STORAGE_KEY } from "../lib/display";
import { DISPLAY_MENU_PANEL_ID, DisplayMenu } from "./display-menu";

// The header's display menu (HACK-166). The text size and contrast
// controls open from one button instead of filling the header. These
// tests hold it to a disclosure: one button names it and says whether it's
// open, Escape and a press outside close it, a press inside never does,
// and the controls stay mounted the whole time, so stored settings still
// apply on every page while the menu is closed.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let elsewhere: HTMLButtonElement;
let root: ReturnType<typeof createRoot>;

function resetRoot(): void {
  const html = document.documentElement;
  html.removeAttribute("data-text-zoom");
  html.removeAttribute("data-contrast");
  html.style.removeProperty("font-size");
}

beforeEach(() => {
  localStorage.clear();
  resetRoot();
  elsewhere = document.createElement("button");
  elsewhere.textContent = "Something else on the page";
  container = document.createElement("div");
  document.body.append(elsewhere, container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  elsewhere.remove();
  resetRoot();
});

function mount(): void {
  act(() => root.render(<DisplayMenu />));
}

function menuButton(): HTMLButtonElement {
  return container.querySelector<HTMLButtonElement>("[data-display-menu-button]")!;
}

function panel(): HTMLElement {
  return document.getElementById(DISPLAY_MENU_PANEL_ID)!;
}

type Action = "toggle" | "escape" | "other key" | "press outside" | "press inside";

function perform(action: Action): void {
  act(() => {
    switch (action) {
      case "toggle":
        menuButton().click();
        break;
      case "escape":
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        break;
      case "other key":
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
        break;
      case "press outside":
        elsewhere.dispatchEvent(new Event("pointerdown", { bubbles: true }));
        break;
      case "press inside":
        panel().querySelector("[data-zoom-in]")!.dispatchEvent(new Event("pointerdown", { bubbles: true }));
        break;
    }
  });
}

describe("the header's display menu", () => {
  it("names one button for the controls, closed at first, pointing at its panel", () => {
    const html = renderToStaticMarkup(<DisplayMenu />);
    expect(html).toContain('aria-label="Text size and contrast"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain(`aria-controls="${DISPLAY_MENU_PANEL_ID}"`);
    expect(html).toMatch(new RegExp(`id="${DISPLAY_MENU_PANEL_ID}"[^>]*hidden`));
    // The controls render inside the panel even while it's closed.
    expect(html).toContain('data-display-controls="true"');
    // Every visible label is part of the button's name, so asking for
    // "Text size" by voice still finds it.
    for (const visible of ["Text size", "Text size and contrast"]) {
      expect("Text size and contrast").toContain(visible);
    }
  });

  it("opens and closes like a disclosure for any sequence of presses and keys (property)", () => {
    const actions = fc.constantFrom<Action>("toggle", "escape", "other key", "press outside", "press inside");
    fc.assert(
      fc.property(fc.array(actions, { maxLength: 12 }), (sequence) => {
        act(() => root.unmount());
        root = createRoot(container);
        mount();
        let open = false;
        expect(panel().hidden).toBe(true);
        for (const action of sequence) {
          const wasOpen = open;
          perform(action);
          if (action === "toggle") {
            open = !open;
          } else if (action === "escape" || action === "press outside") {
            open = false;
          }
          expect(panel().hidden).toBe(!open);
          expect(menuButton().getAttribute("aria-expanded")).toBe(String(open));
          if (action === "escape" && wasOpen) {
            expect(document.activeElement).toBe(menuButton());
          }
          // Open or closed, the controls never unmount.
          expect(container.querySelector("[data-display-controls]")).not.toBeNull();
        }
      }),
      { numRuns: 60 },
    );
  });

  it("applies the stored text size and contrast on load while the menu stays closed", async () => {
    localStorage.setItem(DISPLAY_STORAGE_KEY, JSON.stringify({ zoomIndex: 2, highContrast: true }));
    mount();
    await act(async () => {
      await Promise.resolve();
    });
    expect(panel().hidden).toBe(true);
    expect(document.documentElement.getAttribute("data-text-zoom")).toBe("150%");
    expect(document.documentElement.getAttribute("data-contrast")).toBe("high");
  });

  it("changes the text size from inside the open menu and keeps it open", () => {
    mount();
    perform("toggle");
    act(() => panel().querySelector<HTMLButtonElement>("[data-zoom-in]")!.click());
    expect(document.documentElement.getAttribute("data-text-zoom")).toBe("125%");
    expect(panel().hidden).toBe(false);
  });
});
