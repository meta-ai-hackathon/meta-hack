import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DisplayControls } from "./display-controls";

// DisplayControls rendering contract (HACK-84, BN-07 static-SSR style).
// The first render is the safe default — 100%, contrast off — so server
// and client markup agree; stored settings load after mount. The control
// set itself must be operable when text is hardest to read: real buttons,
// a real labelled checkbox, and a live region for announcements.

function markup(node: React.ReactNode): string {
  return renderToStaticMarkup(node)
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&");
}

describe("DisplayControls", () => {
  it("renders the zoom stepper at the default 100%, smaller disabled, bigger enabled", () => {
    const html = markup(<DisplayControls />);
    expect(html).toContain("data-display-controls");
    expect(html).toContain('data-zoom-level="true" aria-hidden="true"');
    expect(html).toContain("100%");
    const smaller = html.slice(html.indexOf("data-zoom-out"));
    expect(smaller.slice(0, smaller.indexOf(">"))).toContain('disabled=""');
    const bigger = html.slice(html.indexOf("data-zoom-in"));
    expect(bigger.slice(0, bigger.indexOf(">"))).not.toContain('disabled=""');
  });

  it("renders the high-contrast checkbox labelled and off by default", () => {
    const html = markup(<DisplayControls />);
    expect(html).toContain('id="display-high-contrast"');
    expect(html).toContain('for="display-high-contrast"');
    expect(html).toContain("High contrast");
    const toggle = html.slice(html.indexOf('id="display-high-contrast"'));
    expect(toggle.slice(0, toggle.indexOf(">"))).not.toContain("checked");
  });

  it("keeps the announced-status region mounted for display changes", () => {
    const html = markup(<DisplayControls />);
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
  });
});
