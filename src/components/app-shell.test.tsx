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

  it("carries the prototype frame-header geometry (VAL-FIX-006)", () => {
    const html = renderToStaticMarkup(<AppShell><p>Page content</p></AppShell>);
    // The product frame is edge-to-edge (no centered max-width, no dead
    // gutters) and the header takes the prototype's exact geometry:
    // 84px MINIMUM height with 24px 36px padding on wide viewports (the
    // 760px rule drops it to 75px with 18px 20px padding). HACK-155: the
    // 84px is a floor, not a fixed height — at
    // 250% text the header grows with its content instead of clipping the
    // "Text size and contrast" label and the High contrast checkbox.
    expect(html).not.toContain("max-w-[85rem]");
    expect(html).toContain("min-[1101px]:min-h-[5.25rem]");
    expect(html).not.toContain(":h-[5.25rem]");
    expect(html).toContain("min-[761px]:px-9");
    expect(html).toContain("min-[761px]:py-6");
    expect(html).toContain("min-h-[75px]");
    expect(html).toContain("px-5");
  });

  it("keeps the logo and the display menu button on one row, with the controls closed (HACK-166)", () => {
    const html = renderToStaticMarkup(<AppShell><p>Page content</p></AppShell>);
    // The header row: one row at every width, wrapping only at huge text.
    const row = html.match(/<header[^>]*>\s*<div class="([^"]*)"/)?.[1] ?? "";
    expect(row.split(/\s+/)).toEqual(expect.arrayContaining(["flex-row", "flex-wrap", "justify-between"]));
    expect(row.split(/\s+/)).not.toContain("flex-col");
    // The controls open from one closed button, after the logo.
    expect(html).toContain("data-display-menu-button");
    expect(html).toContain('aria-expanded="false"');
    expect(html.indexOf("data-brand-link")).toBeLessThan(html.indexOf("data-display-menu-button"));
  });

  it("keeps the brand logo round at huge text: the disc cannot shrink (HACK-155)", () => {
    const html = renderToStaticMarkup(<AppShell><p>Page content</p></AppShell>);
    // At 250% the flex row squeezes items; a squeezed round disc renders
    // as an oval (the ticket's stretched-logo report). The logo disc
    // itself carries shrink-0 (the class attribute pairs it with
    // rounded-full — the checkbox's shrink-0 does not count).
    expect(html).toMatch(/class="(?=[^"]*shrink-0)(?=[^"]*rounded-full)[^"]*"/);
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
