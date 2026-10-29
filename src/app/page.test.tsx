import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ANSWER_STATUSES } from "../lib/honesty";
import Home from "./page";

// BN-07 heading-outline check: heading tag levels in document order, so the
// outline must start at h1 and never skip a level downward.
function headingLevels(html: string): number[] {
  return [...html.matchAll(/<h([1-6])[\s>]/g)].map((m) => Number(m[1]));
}

describe("Home page", () => {
  it("renders the app title as a single h1", () => {
    const html = renderToStaticMarkup(<Home />);
    const h1Count = (html.match(/<h1[\s>]/g) ?? []).length;
    expect(h1Count).toBe(1);
    expect(html).toContain("Benefits Navigator");
  });

  it("demonstrates every honest answer status with its badge", () => {
    const html = renderToStaticMarkup(<Home />);
    for (const status of ANSWER_STATUSES) {
      expect(html, status).toContain(`data-status="${status}"`);
    }
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

  it("includes a polite live region for announced status changes", () => {
    const html = renderToStaticMarkup(<Home />);
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
  });

  it("associates the example field label with its control", () => {
    const html = renderToStaticMarkup(<Home />);
    expect(html).toContain('<label for="a11y-demo-field"');
    expect(html).toContain('id="a11y-demo-field"');
    expect(html).toContain('aria-describedby="a11y-demo-field-help"');
  });
});
