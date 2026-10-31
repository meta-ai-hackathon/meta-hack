import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import realEntryJson from "../../kb/entries/nc-medicaid.json";
import {
  KB_ENTRIES,
  KB_FACT_GROUPS,
  SOURCED_STEP_KB_FACT_GROUPS,
  citeFactGroup,
  citeSourcedSteps,
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

// The handoff steps (HACK-46 signing and sending, HACK-47 what comes
// after): every step cites the official page it comes from, says in its own
// words which page that is, and copies no address, phone or fax number and
// no rule the current official pages do not confirm.
describe("the real entry's handoff steps (HACK-46, HACK-47)", () => {
  const entry = parseKbEntry(realEntryJson as unknown);
  const submission = entry.facts.submission_steps?.items ?? [];
  const after = entry.facts.after_you_apply?.items ?? [];
  const allSteps = [...submission, ...after];

  // How each source's steps name it, so a person can tell where a step
  // comes from without opening the card.
  const ATTRIBUTION: Readonly<Record<string, RegExp>> = {
    dhb_5200_form: /\bform\b/i,
    nc_medicaid_apply_page: /\bofficial guidance\b/i,
    epass_portal: /\bofficial guidance\b/i,
    mecklenburg_apply_page: /\bApply for Benefits page\b/,
  };

  it("carries both groups, every step citing one of the entry's official sources", () => {
    expect(submission.length).toBeGreaterThan(0);
    expect(after.length).toBeGreaterThan(0);
    for (const group of SOURCED_STEP_KB_FACT_GROUPS) {
      expect(entry.facts[group]?.retrievedAt).toBe(RETRIEVAL_DATE);
      for (const citation of citeSourcedSteps(entry, group)) {
        expect(citation.status).toBe("active");
        expect(citation.entryVersion).toBe(entry.version);
        const host = new URL(citation.sourceUrl).hostname;
        expect(
          OFFICIAL_HOSTS.some(
            (official) => host === official || host.endsWith(`.${official}`),
          ),
          `${citation.step.id} cites ${citation.sourceUrl}`,
        ).toBe(true);
      }
    }
  });

  it("names its source in every step's own words", () => {
    for (const step of allSteps) {
      const attribution = ATTRIBUTION[step.sourceId];
      expect(attribution, `${step.id} cites an unexpected source`).toBeDefined();
      expect(step.detail, step.id).toMatch(attribution!);
    }
  });

  it("links the county page and the online portal, each cited to the page it links", () => {
    const byId = new Map(submission.map((step) => [step.id, step]));
    const county = byId.get("drop_off_or_fax_in_county");
    expect(county?.sourceId).toBe("mecklenburg_apply_page");
    expect(new URL(county?.link?.url ?? "https://invalid.example").hostname).toBe(
      "dcr.mecknc.gov",
    );
    const online = byId.get("apply_online_instead");
    expect(online?.sourceId).toBe("epass_portal");
    expect(new URL(online?.link?.url ?? "https://invalid.example").hostname).toBe(
      "epass.nc.gov",
    );
    for (const step of allSteps) {
      if (step.link) {
        const source = entry.sources.find((candidate) => candidate.id === step.sourceId);
        expect(step.link.url, step.id).toBe(source?.url);
      }
    }
  });

  it("puts signing and dating before every way of sending it in", () => {
    const ids = submission.map((step) => step.id);
    const sign = ids.indexOf("sign_and_date");
    expect(sign).toBeGreaterThanOrEqual(0);
    expect(submission[sign]?.sourceId).toBe("dhb_5200_form");
    for (const channel of [
      "drop_off_or_fax_in_county",
      "take_or_mail_to_county",
      "apply_online_instead",
    ]) {
      expect(ids.indexOf(channel), channel).toBeGreaterThan(sign);
    }
  });

  it("words every step without an outcome promise or a copied number", () => {
    for (const step of allSteps) {
      const text = `${step.label}. ${step.detail}`;
      expect(() => assertNoBannedClaimsEverySentence(text), step.id).not.toThrow();
      expect(text, step.id).not.toMatch(/\b(?:approved|guaranteed|will receive|qualify)\b/i);
      // Phone and fax numbers stay on the official pages, which can change.
      expect(text, step.id).not.toMatch(/\(?\b\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/);
      // The 2020 form's three-month coverage line stays out.
      expect(text.toLowerCase(), step.id).not.toContain("three months");
    }
  });

  it("records the passages it relies on in the form's verification note", () => {
    const form = entry.sources.find((source) => source.id === "dhb_5200_form");
    for (const fragment of ["HACK-46", "HACK-47", "page 1", "page 20", "page 21", "returned 404"]) {
      expect(form?.supports, fragment).toContain(fragment);
    }
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
