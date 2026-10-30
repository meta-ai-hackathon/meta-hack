import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { findBannedClaims } from "../../lib/honesty";
import { LOADING_NOTE, NOSCRIPT_NOTE, PRIVACY_NOTE } from "../../lib/renewal/copy";
import { checkDateForm } from "../../lib/renewal/date-form";
import RenewalPage from "./page";

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

  it("shows what to do if coverage ends among the official facts", () => {
    expect(html).toContain("If your coverage ends");
    expect(html).toContain("How to appeal a Medicaid decision");
  });

  it("carries no banned claims", () => {
    expect(findBannedClaims(html)).toEqual([]);
  });
});

describe("checkDateForm", () => {
  const today = { year: 2026, month: 10, day: 29 };

  it("asks which date the person has before anything else", () => {
    expect(checkDateForm("", "2027-04-30", today)).toMatchObject({ ok: false, field: "kind" });
    expect(checkDateForm("unknown", "", today)).toMatchObject({ ok: false, field: "kind" });
  });

  it("accepts a real date within 2000-2100 and normalizes it", () => {
    expect(checkDateForm("renewal_due", "2027-04-30", today)).toEqual({
      ok: true,
      kind: "renewal_due",
      reportedDate: "2027-04-30",
    });
    expect(checkDateForm("renewal_due", " 2027-04-30 ", today)).toMatchObject({ ok: true, reportedDate: "2027-04-30" });
    for (const bad of ["", "2027-02-30", "04/30/2027", "1999-12-31", "2101-01-01"]) {
      expect(checkDateForm("renewal_due", bad, today), bad).toMatchObject({ ok: false, field: "date" });
    }
  });

  it("allows a past due date (it shows as passed) but not a future approval date", () => {
    expect(checkDateForm("renewal_due", "2026-01-15", today)).toMatchObject({ ok: true });
    expect(checkDateForm("approval", "2026-10-29", today)).toMatchObject({ ok: true });
    expect(checkDateForm("approval", "2026-10-30", today)).toMatchObject({ ok: false, field: "date" });
  });
});
