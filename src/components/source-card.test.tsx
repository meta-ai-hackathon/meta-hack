// @vitest-environment jsdom
import fc from "fast-check";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { findBannedClaims } from "../lib/honesty";
import type { KbSourceCardView } from "../lib/kb";
import { SourceCard } from "./source-card";

// The source card (BN-27): every card shows the source's title and
// official URL, the retrieval date, and the entry version, and a card from
// an entry that is not active says so with the reason (BN-29).

function renderCard(source: KbSourceCardView): HTMLElement {
  const doc = new DOMParser().parseFromString(
    renderToStaticMarkup(<SourceCard source={source} />),
    "text/html",
  );
  const card = doc.querySelector<HTMLElement>("[data-source-card]");
  if (!card) {
    throw new Error("no source card rendered");
  }
  return card;
}

const sourceArb: fc.Arbitrary<KbSourceCardView> = fc.record(
  {
    title: fc.string({ minLength: 1, maxLength: 60 }),
    url: fc.webUrl({ validSchemes: ["https"] }),
    retrievedAt: fc
      .date({
        min: new Date("2000-01-01T00:00:00Z"),
        max: new Date("2099-12-31T00:00:00Z"),
        noInvalidDate: true,
      })
      .map((date) => date.toISOString().slice(0, 10)),
    entryVersion: fc.integer({ min: 1, max: 999 }),
    entryStatus: fc.constantFrom("active", "stale", "withdrawn"),
    statusReason: fc.string({ minLength: 1, maxLength: 80 }),
  },
  { requiredKeys: ["title", "url", "retrievedAt", "entryVersion", "entryStatus"] },
);

describe("SourceCard", () => {
  it("shows the title, the official URL as a link, the retrieval date, and the version", () => {
    fc.assert(
      fc.property(sourceArb, (source) => {
        const card = renderCard(source);
        const link = card.querySelector("a");
        expect(link?.getAttribute("href")).toBe(source.url);
        expect(link?.textContent).toBe(source.url);
        expect(card.textContent).toContain(source.title);
        expect(card.querySelector("[data-source-retrieved]")?.textContent).toBe(
          source.retrievedAt,
        );
        expect(card.querySelector("[data-source-version]")?.textContent).toBe(
          String(source.entryVersion),
        );
      }),
      { numRuns: 150 },
    );
  });

  it("flags exactly the cards whose entry is not active", () => {
    fc.assert(
      fc.property(sourceArb, (source) => {
        const flag = renderCard(source).querySelector("[data-source-status]");
        if (source.entryStatus === "active") {
          expect(flag).toBeNull();
          return;
        }
        expect(flag?.getAttribute("data-source-status")).toBe(source.entryStatus);
        expect(flag?.textContent).toContain("Check the source before you rely on it.");
        // The reason's own closing punctuation never doubles the flag's.
        expect(flag?.textContent).not.toMatch(/[.!?]\s*\. Check the source/);
      }),
      { numRuns: 150 },
    );
  });

  it("shows the reason and ends the flag's sentence once, however the reason ends", () => {
    // Reasons built to end in a letter, then given each kind of ending a KB
    // author might write, so the expected text is known without a filter.
    const reasonArb = fc.stringMatching(/^[A-Za-z][A-Za-z ,'-]{0,40}[A-Za-z]$/);
    fc.assert(
      fc.property(
        fc.constantFrom("stale", "withdrawn" as const),
        reasonArb,
        fc.constantFrom("", ".", "!", "...", ".  "),
        (entryStatus, reason, ending) => {
          const flag = renderCard({
            title: "Official page",
            url: "https://example.org/rules",
            retrievedAt: "2026-10-30",
            entryVersion: 3,
            entryStatus,
            statusReason: reason + ending,
          }).querySelector("[data-source-status]");
          expect(flag?.textContent).toContain(
            `: ${reason}. Check the source before you rely on it.`,
          );
        },
      ),
      { numRuns: 150 },
    );
  });

  it("keeps its own copy free of promise language", () => {
    for (const entryStatus of ["active", "stale", "withdrawn"] as const) {
      const card = renderCard({
        title: "Official page",
        url: "https://example.org/rules",
        retrievedAt: "2026-10-30",
        entryVersion: 3,
        entryStatus,
      });
      expect(findBannedClaims(card.textContent ?? "")).toEqual([]);
    }
  });
});
