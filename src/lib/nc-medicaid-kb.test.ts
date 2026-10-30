import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import realEntryJson from "../../kb/entries/nc-medicaid.json";
import {
  KB_ENTRIES,
  KB_FACT_GROUPS,
  citeFactGroup,
  parseKbEntry,
  validateKbEntry,
} from "./kb";
import {
  buildRequirements,
  rankEntries,
  type MatchRequirement,
} from "./match";
import { assertNoBannedClaimsEverySentence } from "./conversation";
import type { StoredAnswer } from "./intake/flow";

// The REAL pilot KB entry (Mission v2.1 M6, VAL-PILOTREAL-003, HACK-17
// discipline): built ONLY from official government sources, every fact
// group carrying the official URL + retrieval date + version, with
// claim-verification notes recorded on each source. It ships in the KB
// dataset, validates against the schema rules, and renders through the
// match pipeline end to end with the unchanged "may be worth pursuing"
// framing and banned-claim gates.

const OFFICIAL_HOSTS = [
  "ncdhhs.gov",
  "medicaid.ncdhhs.gov",
  "policies.ncdhhs.gov",
  "epass.nc.gov",
  "dcr.mecknc.gov",
];

const RETRIEVAL_DATE = "2026-10-30";

function known(questionId: string, value: unknown): Record<string, StoredAnswer> {
  return { [questionId]: { status: "known", value } } as Record<
    string,
    StoredAnswer
  >;
}

function requireMeetingText(requirement: MatchRequirement): string {
  return requirement.text;
}

describe("the real NC Medicaid KB entry (VAL-PILOTREAL-003)", () => {
  it("validates cleanly against the schema rules and ships in the dataset", () => {
    expect(validateKbEntry(realEntryJson as unknown)).toEqual([]);
    const entry = parseKbEntry(realEntryJson as unknown);
    expect(entry.status).toBe("active");
    expect(entry.version).toBeGreaterThanOrEqual(1);
    expect(KB_ENTRIES.map((candidate) => candidate.id)).toContain("nc_medicaid");
  });

  it("sources every fact group from OFFICIAL government hosts only", () => {
    const entry = parseKbEntry(realEntryJson as unknown);
    for (const source of entry.sources) {
      const host = new URL(source.url).hostname;
      expect(
        OFFICIAL_HOSTS.some(
          (official) => host === official || host.endsWith(`.${official}`),
        ),
        `source ${source.id} is not an official government host: ${source.url}`,
      ).toBe(true);
    }
    for (const group of KB_FACT_GROUPS) {
      const facts = entry.facts[group];
      expect(
        entry.sources.some((source) => source.id === facts.sourceId),
        `facts.${group} cites an unknown source`,
      ).toBe(true);
    }
  });

  it("carries a retrieval date on every source and fact group", () => {
    const entry = parseKbEntry(realEntryJson as unknown);
    for (const source of entry.sources) {
      expect(source.retrievedAt).toBe(RETRIEVAL_DATE);
    }
    for (const group of KB_FACT_GROUPS) {
      expect(entry.facts[group].retrievedAt).toBe(RETRIEVAL_DATE);
    }
  });

  it("records HACK-17 claim-verification notes on every source", () => {
    const entry = parseKbEntry(realEntryJson as unknown);
    for (const source of entry.sources) {
      // Each supports string says what was verified and on which page; the
      // retrieval date (verified_at) is the source's retrievedAt.
      expect(source.supports.length).toBeGreaterThan(40);
      expect(source.supports).toContain("retrieved 2026-10-30");
    }
  });

  it("records the DHB-5200 vs DHB-5201 reconciliation for the initial MAGI journey", () => {
    const text = JSON.stringify(realEntryJson);
    expect(text).toContain("DHB-5200");
    expect(text).toContain("DHB-5201");
    expect(text).toContain("initial");
  });

  it("never encodes eligibility thresholds or legacy form illustrations", () => {
    const text = JSON.stringify(realEntryJson);
    expect(text).not.toContain("94,000");
    expect(text).not.toContain("$94");
    expect(text).not.toContain("NCHC eligibility");
  });

  it("ranks through the match pipeline on a North Carolina answer", () => {
    const ranked = rankEntries(known("state", "NC"));
    const entry = ranked.find((candidate) => candidate.entry.id === "nc_medicaid");
    expect(entry).toBeTruthy();
    expect(entry?.score ?? 0).toBeGreaterThan(0);
  });

  it("never ranks outside the pilot state — even on a healthcare goal", () => {
    // A state-specific program must not surface for someone the signals
    // cannot place: the goal signal alone scores nothing (claude-review
    // P2 on PR #60 — a person in any state picking healthcare never sees
    // this entry as a match).
    for (const answers of [
      known("state", "CA"),
      known("main_goal", "healthcare"),
      { ...known("state", "CA"), ...known("main_goal", "healthcare") },
    ]) {
      const ranked = rankEntries(answers);
      const entry = ranked.find((candidate) => candidate.entry.id === "nc_medicaid");
      expect(entry?.score ?? 0).toBe(0);
    }
  });

  it("renders the match card end to end with unchanged honest framing", () => {
    const ranked = rankEntries(known("state", "NC"));
    const rankedEntry = ranked.find(
      (candidate) => candidate.entry.id === "nc_medicaid",
    );
    expect(rankedEntry).toBeTruthy();
    const cardEntry = rankedEntry!.entry;
    const requirements = buildRequirements(cardEntry);
    const links = cardEntry.facts.official_links.items.map((link) => ({
      label: link.label,
      url: link.url,
      source: citeFactGroup(cardEntry, "official_links"),
    }));
    // The framing and every rendered claim: banned-claim gate unchanged.
    const renderedCopy = [
      "This may be worth pursuing.",
      ...rankedEntry!.reasons.map((reason) => reason.text),
      ...requirements.map((requirement) => requireMeetingText(requirement)),
    ].join(" ");
    expect(() => assertNoBannedClaimsEverySentence(renderedCopy)).not.toThrow();
    // Every reason, requirement, and link carries the official source URL,
    // retrieval date, and the entry's active status (BN-27).
    for (const reason of rankedEntry!.reasons) {
      expect(reason.source.sourceUrl.startsWith("https://")).toBe(true);
      expect(reason.source.retrievedAt).toBe(RETRIEVAL_DATE);
      expect(reason.source.entryStatus).toBe("active");
    }
    for (const requirement of requirements) {
      expect(requirement.source.sourceUrl.startsWith("https://")).toBe(true);
      expect(requirement.source.retrievedAt).toBe(RETRIEVAL_DATE);
    }
    expect(links.map((link) => link.url)).toContain("https://epass.nc.gov/");
  });

  it("cites every fact group through the citation API (never silently)", () => {
    const entry = parseKbEntry(realEntryJson as unknown);
    for (const group of KB_FACT_GROUPS) {
      const citation = citeFactGroup(entry, group);
      expect(citation.status).toBe("active");
      expect(citation.sourceUrl.startsWith("https://")).toBe(true);
      expect(citation.retrievedAt).toBe(RETRIEVAL_DATE);
    }
  });

  it("keeps processing time an agency timeline, never an approval promise", () => {
    const text = JSON.stringify(realEntryJson).toLowerCase();
    expect(text).toContain("45 days");
    expect(text).not.toContain("you will be approved");
    expect(text).not.toContain("guaranteed");
  });
});

// The committed file must mention its own verification basis in sources the
// reviewer can open — a smoke check that the fixture is the real data file.
describe("the committed KB fixture file", () => {
  it("is the nc-medicaid entry JSON from disk", () => {
    const raw = readFileSync("kb/entries/nc-medicaid.json", "utf8");
    expect(JSON.parse(raw)).toEqual(realEntryJson);
  });
});
