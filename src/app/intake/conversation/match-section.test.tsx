import fc from "fast-check";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { findBannedClaims } from "../../../lib/honesty";
import type { AnswerMap } from "../../../lib/intake/flow";
import { buildMatchResponse, matchCardText } from "../../../lib/match";
import { MatchSectionContent } from "./match-section";

// Match section tests (Mission v2 M3, VAL-MATCH-002/003 client surface):
// the rendered card population — one card set per shipped KB entry plus
// randomized-answer sets — carries zero banned claims in the DOM markup,
// every claim shows its official source with a retrieval date, and the
// to-resolve list renders in plain language.

function headingLevels(html: string): number[] {
  return [...html.matchAll(/<h([1-6])[\s>]/g)].map((m) => Number(m[1]));
}

/** React escapes quotes and apostrophes in markup; decode for text scans. */
function decodeEntities(html: string): string {
  return html
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

const stubExplainer = async () => ({
  text: "Stub explanation drawn from the entry facts.",
  source: "facts" as const,
});

async function matchData(answers: AnswerMap) {
  // The route spreads hasSession over the payload; tests use the
  // session-present shape the client receives.
  return { hasSession: true, ...(await buildMatchResponse(answers, { explainer: stubExplainer })) };
}

describe("MatchSectionContent structure", () => {
  it("renders the honest framing, cards with sources, and the to-resolve list", async () => {
    const answers: AnswerMap = {
      main_goal: { status: "known", value: "food" },
      housing_status: { status: "known", value: "shelter" },
      id_status: { status: "unknown" },
    };
    const data = await matchData(answers);
    const html = renderToStaticMarkup(<MatchSectionContent data={data} />);

    expect(html).toContain("data-match-section");
    expect(html).toContain("Benefits that may be worth pursuing");
    expect(html).toContain('data-match-card="pilot_program_sample"');
    // Every reason and requirement shows an official source line with a
    // retrieval date and the entry version.
    expect(html).toContain("retrieved 2026-10-29");
    expect(html).toContain("entry version 2");
    expect(html).toContain('data-match-requirements="pilot_program_sample"');
    // The to-resolve list names the unknown question in plain language.
    expect(html).toContain("data-to-resolve");
    expect(html).toContain("Do you have a photo ID right now?");
    // Known answers never appear in the to-resolve list.
    expect(decodeEntities(html)).not.toContain("Where does money come from");
  });

  it("keeps a hierarchical heading outline", async () => {
    const data = await matchData({ main_goal: { status: "known", value: "food" } });
    const levels = headingLevels(renderToStaticMarkup(<MatchSectionContent data={data} />));
    expect(levels.length).toBeGreaterThan(0);
    expect(levels[0]).toBe(2);
    for (let index = 1; index < levels.length; index += 1) {
      expect(
        levels[index]!,
        `heading ${index + 1} skips a level`,
      ).toBeLessThanOrEqual(levels[index - 1]! + 1);
    }
  });

  it("renders an empty state before any program facts exist", async () => {
    const html = renderToStaticMarkup(
      <MatchSectionContent data={{ hasSession: false, matches: [], toResolve: [] }} />,
    );
    expect(html).toContain("show up here");
    expect(html).not.toContain("data-match-card");
  });
});

describe("zero banned claims on the rendered card population (VAL-MATCH-003)", () => {
  it("scans clean across one card set per shipped entry plus randomized sets", async () => {
    // Deterministic seed sets first (one per entry-focus), then randomized
    // answer maps below.
    const seedSets: AnswerMap[] = [
      {},
      { main_goal: { status: "known", value: "food" } },
      { main_goal: { status: "known", value: "healthcare" } },
      { housing_status: { status: "known", value: "shelter" } },
      { citizenship_status: { status: "unknown" }, disability_status: { status: "unverified" } },
    ];
    for (const answers of seedSets) {
      const data = await matchData(answers);
      const html = decodeEntities(
        renderToStaticMarkup(<MatchSectionContent data={data} />),
      );
      expect(findBannedClaims(html), JSON.stringify(answers)).toEqual([]);
    }

    const optionValues: Record<string, string[]> = {
      main_goal: ["food", "housing", "healthcare", "cash_assistance", "other"],
      income_sources: ["job", "none", "child_support"],
      id_status: ["have_id", "need_id", "not_sure"],
    };
    const randomized = fc.option(
      fc.record({
        main_goal: fc.option(
          fc.record({
            status: fc.constant("known" as const),
            value: fc.constantFrom(...optionValues.main_goal!),
          }),
          { nil: undefined },
        ),
        income_sources: fc.option(
          fc.record({
            status: fc.constantFrom("known", "unknown", "unverified") as fc.Arbitrary<
              "known" | "unknown" | "unverified"
            >,
            value: fc.array(fc.constantFrom(...optionValues.income_sources!), {
              maxLength: 2,
            }),
          }),
          { nil: undefined },
        ),
        id_status: fc.option(
          fc.record({
            status: fc.constantFrom("known", "unknown", "unverified") as fc.Arbitrary<
              "known" | "unknown" | "unverified"
            >,
            value: fc.constantFrom(...optionValues.id_status!),
          }),
          { nil: undefined },
        ),
      }),
      { nil: undefined },
    );
    await fc.assert(
      fc.asyncProperty(randomized, async (answers) => {
        const data = await matchData((answers ?? {}) as AnswerMap);
        for (const card of data.matches) {
          expect(findBannedClaims(matchCardText(card)), card.entryId).toEqual([]);
        }
        const html = decodeEntities(
          renderToStaticMarkup(<MatchSectionContent data={data} />),
        );
        expect(findBannedClaims(html)).toEqual([]);
      }),
      { numRuns: 40 },
    );
  });

  it("bites: the scan flags a poisoned card fixture", async () => {
    const data = await matchData({ main_goal: { status: "known", value: "food" } });
    const poisoned = {
      ...data,
      matches: [
        {
          ...data.matches[0]!,
          framing: "You qualify for this program right now.",
        },
        ...data.matches.slice(1),
      ],
    };
    const html = decodeEntities(
      renderToStaticMarkup(<MatchSectionContent data={poisoned} />),
    );
    expect(findBannedClaims(html).length).toBeGreaterThan(0);
  });
});
