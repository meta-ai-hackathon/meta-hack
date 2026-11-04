// @vitest-environment jsdom
import fc from "fast-check";
import { StrictMode, act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findBannedClaims } from "../../lib/honesty";
import RenewalPreviewPage from "./page";
import { PREVIEW_CHECKS, PREVIEW_HOUSEHOLD, RENEWAL_PREVIEW_COPY, RenewalPreview } from "./renewal-preview";

// The one-click renewal concept preview (HACK-152). It is for the launch
// video, so these tests hold it to what keeps it honest: it says up front
// that it's a preview with made-up details, it walks through the three
// questions with no typing, it shows exactly what would be sent and won't
// confirm until the person ticks that they checked it, and its last screen
// says nothing was sent. It makes no requests and stores nothing.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  fetchSpy = vi.fn();
  vi.stubGlobal("fetch", fetchSpy);
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function mount(): void {
  act(() => root.render(<RenewalPreview />));
}

function press(action: string): void {
  const button = container.querySelector<HTMLButtonElement>(`[data-action="${action}"]`);
  if (button === null) {
    throw new Error(`no ${action} button on this step`);
  }
  act(() => button.click());
}

function text(): string {
  return container.textContent ?? "";
}

/** Words for things the app never does on the person's behalf: prepared is never submitted. */
const NOT_AN_APP_ACTION = /submit|send|\bfil(e|ing)\b|\bsign|renew/i;

/** One answer a question: true when the person says it changed. */
const answerMixes = fc.array(fc.boolean(), { minLength: PREVIEW_CHECKS.length, maxLength: PREVIEW_CHECKS.length });

/** There are only 2^3 mixes, so every property runs each one as an example before its random runs. */
const everyAnswerMix: [boolean[]][] = Array.from({ length: 2 ** PREVIEW_CHECKS.length }, (_, bits) => [
  PREVIEW_CHECKS.map((_, index) => (bits & (1 << index)) !== 0),
]);

/** Walk the three questions, answering each as `changes` says, and land on the review. */
function walk(changes: readonly boolean[]): void {
  press("start");
  changes.forEach((didChange, index) => {
    const step = container.querySelector(`[data-check="${PREVIEW_CHECKS[index].id}"]`);
    expect(step).not.toBeNull();
    expect(step?.querySelector("[data-last-time]")?.textContent).toBe(PREVIEW_CHECKS[index].lastTime);
    expect(container.querySelector("[data-step-label]")?.textContent).toBe(`Step ${index + 1} of 4`);
    press(didChange ? "changed" : "no-change");
  });
}

describe("the one-click renewal concept preview", () => {
  it("says up front that it's a preview with made-up details that sends and saves nothing", () => {
    const html = renderToStaticMarkup(<RenewalPreviewPage />);
    expect(html).toContain("data-concept-banner");
    expect(html).toContain("Concept preview");
    expect(html).toContain("made-up details");
    expect(html).toContain("nothing here is sent or saved");
    expect(html).toContain(PREVIEW_HOUSEHOLD.name);
    expect(html.match(/<h1/g) ?? []).toHaveLength(1);
  });

  it("walks through the questions with no typing, shows what would be sent, and confirms only once checked", () => {
    mount();
    walk([false, false, false]);
    expect(container.querySelectorAll("input:not([type=checkbox]), textarea, select")).toHaveLength(0);
    const review = container.querySelector("[data-review]");
    expect(review).not.toBeNull();
    expect(container.querySelector("[data-step-label]")?.textContent).toBe("Step 4 of 4");
    for (const check of PREVIEW_CHECKS) {
      expect(review?.querySelector(`[data-review-item="${check.id}"]`)?.textContent).toContain(check.lastTime);
    }
    expect(review?.querySelectorAll("[data-marked-changed]")).toHaveLength(0);

    const confirm = container.querySelector<HTMLButtonElement>('[data-action="confirm"]')!;
    expect(confirm.disabled).toBe(true);
    act(() => confirm.click());
    expect(container.querySelector("[data-done]")).toBeNull();

    act(() => container.querySelector<HTMLInputElement>("[data-confirm-check]")!.click());
    expect(confirm.disabled).toBe(false);
    press("confirm");
    expect(container.querySelector("[data-done]")?.textContent).toContain(RENEWAL_PREVIEW_COPY.doneHeading);
    expect(text()).toContain("Nothing was sent.");
    expect(text()).toContain("Only the agency decides");

    press("again");
    expect(container.querySelector('[data-action="start"]')).not.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it("marks exactly the answers the person said changed, never shows a stale value as what would be sent, and never confirms unchecked", () => {
    fc.assert(
      fc.property(answerMixes, (changes) => {
        act(() => root.unmount());
        root = createRoot(container);
        mount();
        walk(changes);
        const marked = [...container.querySelectorAll("[data-review-item]")]
          .filter((item) => item.querySelector("[data-marked-changed]") !== null)
          .map((item) => item.getAttribute("data-review-item"));
        expect(marked).toEqual(PREVIEW_CHECKS.filter((_, index) => changes[index]).map((check) => check.id));
        // Each item's shown value is last time's answer only when the person said
        // nothing changed. Otherwise it says the item needs updating, and last
        // time's answer appears only labeled as last time's.
        PREVIEW_CHECKS.forEach((check, index) => {
          const item = container.querySelector(`[data-review-item="${check.id}"]`);
          const shown = item?.querySelector("dd")?.textContent;
          if (changes[index]) {
            expect(shown).toBe(RENEWAL_PREVIEW_COPY.needsUpdate);
            expect(item?.textContent).toContain(`${RENEWAL_PREVIEW_COPY.lastTime}: ${check.lastTime}`);
          } else {
            expect(shown).toBe(check.lastTime);
            expect(item?.textContent).not.toContain(RENEWAL_PREVIEW_COPY.needsUpdate);
          }
        });
        expect(container.querySelector("[data-confirm-label]")?.textContent).toBe(
          changes.some(Boolean) ? RENEWAL_PREVIEW_COPY.confirmCheckChanged : RENEWAL_PREVIEW_COPY.confirmCheck,
        );
        const confirm = container.querySelector<HTMLButtonElement>('[data-action="confirm"]')!;
        expect(confirm.disabled).toBe(true);
        // The button that finishes the preview names what the person does,
        // confirming details. On camera it must never read as the app filing
        // the renewal, so it never says submit, send, file, sign or renew.
        expect(confirm.textContent).not.toMatch(NOT_AN_APP_ACTION);
      }),
      { examples: everyAnswerMix, numRuns: 16 },
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("leaves the first screen's focus alone, even when React runs effects twice, then moves focus to each new step's heading", () => {
    fc.assert(
      fc.property(answerMixes, (changes) => {
        act(() => root.unmount());
        root = createRoot(container);
        // StrictMode runs mount effects twice in development, which is how
        // the dev server renders the page.
        act(() =>
          root.render(
            <StrictMode>
              <RenewalPreview />
            </StrictMode>,
          ),
        );
        expect(container.contains(document.activeElement)).toBe(false);
        press("start");
        changes.forEach((didChange, index) => {
          expect(document.activeElement?.textContent).toBe(PREVIEW_CHECKS[index].question);
          press(didChange ? "changed" : "no-change");
        });
        expect(document.activeElement?.textContent).toBe(RENEWAL_PREVIEW_COPY.reviewHeading);
        act(() => container.querySelector<HTMLInputElement>("[data-confirm-check]")!.click());
        press("confirm");
        expect(document.activeElement?.textContent).toBe(RENEWAL_PREVIEW_COPY.doneHeading);
        press("again");
        expect(document.activeElement?.textContent).toBe(RENEWAL_PREVIEW_COPY.forWhom);
      }),
      { examples: everyAnswerMix, numRuns: 8 },
    );
  });

  it("never promises an outcome, in its copy or on any screen", () => {
    for (const line of Object.values(RENEWAL_PREVIEW_COPY)) {
      expect(findBannedClaims(line)).toEqual([]);
    }
    for (const check of PREVIEW_CHECKS) {
      expect(findBannedClaims(check.question)).toEqual([]);
    }
    mount();
    const screens = [text()];
    press("start");
    for (let index = 0; index < PREVIEW_CHECKS.length; index += 1) {
      screens.push(text());
      press(index === 1 ? "changed" : "no-change");
    }
    screens.push(text());
    act(() => container.querySelector<HTMLInputElement>("[data-confirm-check]")!.click());
    press("confirm");
    screens.push(text());
    for (const screen of screens) {
      expect(findBannedClaims(screen)).toEqual([]);
    }
  });
});
