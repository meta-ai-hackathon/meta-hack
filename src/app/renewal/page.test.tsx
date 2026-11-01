import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { findBannedClaims } from "../../lib/honesty";
import { LOADING_NOTE, NOSCRIPT_NOTE, PRIVACY_NOTE } from "../../lib/renewal/copy";
import RenewalPage, { metadata } from "./page";
import { HIDE_LOADING_WITHOUT_SCRIPT_CSS } from "./renewal-tracker";

// The renewal page shell (HACK-50) and the tracker's server render: the
// facts are on the page without JavaScript, the person's date section is
// a mounted shell until the browser takes over (no form, so nothing can be
// submitted before hydration), and the a11y baseline holds.

function headingLevels(html: string): number[] {
  return [...html.matchAll(/<h([1-6])[\s>]/g)].map((match) => Number(match[1]));
}

function decode(html: string): string {
  return html.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}

describe("Renewal page", () => {
  const html = decode(renderToStaticMarkup(<RenewalPage />));

  it("renders one h1 and a hierarchical outline", () => {
    expect((html.match(/<h1[\s>]/g) ?? []).length).toBe(1);
    const levels = headingLevels(html);
    expect(levels[0]).toBe(1);
    for (let index = 1; index < levels.length; index += 1) {
      expect(levels[index]!, `heading ${index + 1} skips a level`).toBeLessThanOrEqual(levels[index - 1]! + 1);
    }
  });

  it("shows the official facts with their labels before any script runs", () => {
    expect(html).toContain("data-renewal-facts");
    expect(html).toContain("From NC Medicaid");
    expect(html).toContain("What NC Medicaid says about renewal");
  });

  it("server-renders the date section as a shell: no form, no inputs, a mounted status region", () => {
    expect(html).toContain("data-renewal-tracker");
    expect(html).toContain(LOADING_NOTE);
    expect(html).toContain(PRIVACY_NOTE);
    expect(html).not.toContain("<form");
    expect(html).not.toContain("<input");
    expect(html).toContain('role="status"');
  });

  it("explains itself when JavaScript is off, instead of only 'checking' forever (review fix)", () => {
    expect(html).toMatch(new RegExp(`<noscript><p[^>]*>${NOSCRIPT_NOTE}</p></noscript>`));
  });

  it("hides the loading line when JavaScript is off, so it does not claim to be checking (second review fix)", () => {
    // The loading line carries the attribute the noscript style hides; with
    // scripting on, a browser reads noscript content as text and the style
    // does nothing.
    expect(html).toMatch(new RegExp(`<p data-renewal-loading="true"[^>]*>${LOADING_NOTE}</p>`));
    expect(html).toContain(`<noscript><style>${HIDE_LOADING_WITHOUT_SCRIPT_CSS}</style></noscript>`);
    expect(HIDE_LOADING_WITHOUT_SCRIPT_CSS).toBe("[data-renewal-loading]{display:none}");
  });

  it("shows what to do if coverage ends among the official facts", () => {
    expect(html).toContain("If your coverage ends");
    // The appeal link says what the hearings office page covers (second review).
    expect(html).toContain("NC Office of Administrative Hearings: how to appeal a decision about a Medicaid service");
    expect(html).toContain("ask for a hearing");
  });

  it("carries no banned claims", () => {
    expect(findBannedClaims(html)).toEqual([]);
  });

  it("describes where the date is kept without saying it goes nowhere (second review fix)", () => {
    expect(metadata.description).toMatch(/This site keeps your date only on this device\.$/);
    expect(metadata.description).not.toMatch(/Your date stays on this device/);
  });
});
