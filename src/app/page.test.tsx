import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { findBannedClaims } from "../lib/honesty";
import Home from "./page";

// The entry choice island is a client component that navigates with the
// app router; the static shell render mocks that seam.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => undefined }),
}));

// The entry/home surface (VAL-FIX-003): the approved Lovable round-2
// shell — the three-stage journey sidebar beside the framed paper-card
// content (the approved mode-choice card), brand mark in the header, a
// mobile-sane single column. The old hero page (status-badge showcase +
// a11y demo blocks) is superseded: the a11y demo's own docstring said it
// was to be replaced once the real flows landed, and they have.
//
// The old home page asserted the a11y attribute wiring THROUGH its demo
// blocks (a polite live region, a label associated with its control).
// That gate did not go away with the demo: the components own those
// attributes and their unit suites pin them —
// `src/components/status-region.test.tsx` (role="status" +
// aria-live="polite" + stays mounted) and `src/components/field.test.tsx`
// (for/id association, aria-describedby help/error wiring) — and the
// surfaces that render the real flows keep the browser-level a11y
// evidence (skip link, outline, focus, axe audits). This file keeps the
// page-level outline + navigation gates.

function headingLevels(html: string): number[] {
  return [...html.matchAll(/<h([1-6])[\s>]/g)].map((m) => Number(m[1]));
}

describe("Home page (the round-2 entry shell, VAL-FIX-003)", () => {
  it("renders the app title as a single h1", () => {
    const html = renderToStaticMarkup(<Home />);
    const h1Count = (html.match(/<h1[\s>]/g) ?? []).length;
    expect(h1Count).toBe(1);
    expect(html).toContain("Benefits Navigator");
  });

  it("carries the approved mode-choice card as the framed content", () => {
    const html = renderToStaticMarkup(<Home />);
    expect(html).toContain("data-mode-choice");
    expect(html).toContain("How would you like to talk?");
    expect(html).toContain("Live subtitles are always here.");
  });

  it("lists the three journey stages — fresh visitors see talk and results locked", () => {
    const html = renderToStaticMarkup(<Home />);
    expect(html).toContain('aria-label="Your journey"');
    // Reached stages navigate; the fresh paint has only the mode choice
    // reached (real progress arrives with the history fetch).
    expect(html).toContain('data-journey-stage-link="mode-choice"');
    expect(html).toContain('data-journey-stage-locked="talk"');
    expect(html).toContain('data-journey-stage-locked="results"');
    expect(html).not.toContain('data-journey-stage-link="talk"');
    expect(html).not.toContain('data-journey-stage-link="results"');
  });

  it("keeps the intake wizard reachable by navigation (VAL-CROSS-004)", () => {
    const html = renderToStaticMarkup(<Home />);
    expect(html).toContain('href="/intake"');
  });

  it("keeps a hierarchical heading outline with no skipped levels", () => {
    const levels = headingLevels(renderToStaticMarkup(<Home />));
    expect(levels.length).toBeGreaterThan(1);
    expect(levels[0]).toBe(1);
    for (let i = 1; i < levels.length; i += 1) {
      expect(levels[i], `heading ${i + 1} skips a level`).toBeLessThanOrEqual(
        levels[i - 1] + 1,
      );
    }
  });

  it("stays banned-claim clean", () => {
    const html = renderToStaticMarkup(<Home />);
    expect(findBannedClaims(html)).toEqual([]);
  });
});
