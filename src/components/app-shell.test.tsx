import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AppShell } from "./app-shell";

describe("AppShell (BN-07)", () => {
  it("renders the skip link as the first element, targeting main content", () => {
    const html = renderToStaticMarkup(<AppShell><p>Page content</p></AppShell>);
    // First element in the shell is the skip link, so it is the first tab stop.
    expect(html.startsWith('<a href="#main-content"')).toBe(true);
    expect(html).toContain("Skip to main content");
  });

  it("renders the display controls inside the header, after the skip link", () => {
    const html = renderToStaticMarkup(<AppShell><p>Page content</p></AppShell>);
    expect(html).toContain("<header");
    expect(html).toContain("data-display-controls=\"true\"");
    expect(html).toContain("High contrast");
    // Skip link still precedes the header: it stays the first tab stop.
    expect(html.indexOf('href="#main-content"')).toBeLessThan(
      html.indexOf("data-display-controls"),
    );
  });

  it("provides the main landmark as the skip target", () => {
    const html = renderToStaticMarkup(<AppShell><p>Page content</p></AppShell>);
    expect((html.match(/<main[\s>]/g) ?? []).length).toBe(1);
    expect(html).toContain('id="main-content"');
    // tabindex=-1 lets the fragment link move real focus, not just scroll.
    expect(html).toContain('tabindex="-1"');
    expect(html.indexOf('id="main-content"')).toBeLessThan(
      html.indexOf("Page content"),
    );
  });
});
