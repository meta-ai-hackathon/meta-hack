import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// HACK-155 (VAL-UX-007) reflow rules in globals.css. At 375 px with the
// huge-text zoom (root font 40 px) a single heading word can be wider than
// the ~275 px content column, so the page scrolled sideways (627-727 px).
// The reflow block caps zoomed display headings with vw on phones (words
// fit whole), lets text break anywhere as the last-resort reflow, and lets
// links break at every size (long source URLs wrap). jsdom cannot compute
// CSS, so these are source-level pins; the real measurements live in the
// browser evidence (375x812 at 250% on home, /intake,
// /intake/conversation, results).

const cssPath = join(process.cwd(), "src", "app", "globals.css");
const css = readFileSync(cssPath, "utf8");
const media = "@media (max-width: 760px)";
const block = css.slice(css.indexOf(media), css.indexOf(media) + 4000);

describe("the HACK-155 reflow block in globals.css", () => {
  it("is scoped to phones and the huge-text zoom only", () => {
    expect(css).toContain(media);
    expect(block).toContain("html[data-text-zoom]");
    // Normal-size rendering carries no reflow override for headings.
    expect(block).not.toMatch(/html(?!\[data-text-zoom\]) h1/);
  });

  it("caps zoomed display headings with vw so single words fit the column", () => {
    // One cap per shipped heading size class (h1 text-4xl; h2 text-3xl /
    // text-2xl / text-xl; h3 text-2xl / text-xl) — the min() keeps the
    // original size at every zoom step on wide-enough phones and only
    // bounds the huge-text corner.
    for (const [selector, cap] of [
      ["h1.text-4xl", "min(2.25rem, 13vw)"],
      ["h2.text-3xl", "min(1.875rem, 12vw)"],
      [":is(h2.text-2xl, h3.text-2xl)", "min(1.5rem, 11vw)"],
    ] as const) {
      expect(block).toContain(`html[data-text-zoom] ${selector}`);
      expect(block).toContain(cap);
    }
    expect(block).toContain("html[data-text-zoom] :is(h2.text-xl, h3.text-xl)");
    expect(block).toContain("min(1.25rem, 10vw)");
  });

  it("lets zoomed text break anywhere as the last-resort reflow", () => {
    // Inherited by every element inside main: a word that still cannot
    // fit its line breaks instead of widening the page.
    expect(block).toMatch(
      /html\[data-text-zoom\] main \{[^}]*overflow-wrap:\s*anywhere/,
    );
  });

  it("lets links break anywhere at every size (long source URLs wrap)", () => {
    expect(css).toMatch(/main a \{[^}]*overflow-wrap:\s*anywhere/);
  });
});
