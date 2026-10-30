import { describe, expect, it } from "vitest";
import { parseKbEntry, type KbEntry } from "../kb";
import pilotEntryJson from "../../../kb/pilot/nc-medicaid-renewal.json";
import { parseIsoDate } from "./calendar-date";
import {
  PILOT_RENEWAL_ENTRY,
  PILOT_RENEWAL_FACTS,
  bannerFacts,
  buildRenewalFactsView,
  type RenewalSourceView,
} from "./renewal-facts";

// The knowledge-base side of the tracker (HACK-50): the decided pilot's
// renewal entry parses through the KB validator, and every fact in the
// view the UI renders carries its official source, retrieval date, and
// entry version. Stale facts keep their status; withdrawn facts vanish.

const OFFICIAL_HOST = /^https:\/\/([a-z0-9-]+\.)*(ncdhhs\.gov|nc\.gov)\//;

function allSources(view: typeof PILOT_RENEWAL_FACTS): RenewalSourceView[] {
  return [
    ...view.schedules.map((item) => item.source),
    ...view.keyDates.map((item) => item.source),
    ...view.deadlineNotes.map((item) => item.source),
    ...view.rules.map((item) => item.source),
    ...view.documents.map((item) => item.source),
    ...view.steps.map((item) => item.source),
    ...view.ifCoverageEnds.map((item) => item.source),
    ...view.links.map((item) => item.source),
  ];
}

function withStatus(status: KbEntry["status"]): KbEntry {
  const raw = structuredClone(pilotEntryJson) as Record<string, unknown>;
  raw.status = status;
  raw.status_reason = "The source page changed after it was read.";
  return parseKbEntry(raw);
}

describe("the pilot renewal entry", () => {
  it("parses through the KB validator as an active, versioned entry", () => {
    expect(PILOT_RENEWAL_ENTRY.id).toBe("nc_medicaid_renewal");
    expect(PILOT_RENEWAL_ENTRY.title).toBe("NC Medicaid");
    expect(PILOT_RENEWAL_ENTRY.status).toBe("active");
    expect(PILOT_RENEWAL_ENTRY.version).toBeGreaterThanOrEqual(1);
  });

  it("states the 2027 change as a dated fact, with who it does not affect", () => {
    expect(PILOT_RENEWAL_FACTS.keyDates.map((item) => item.date)).toEqual(["2027-01-01", "2027-01-01", "2027-01-01"]);
    expect(PILOT_RENEWAL_FACTS.keyDates[0]!.label).toContain("6 months");
    expect(PILOT_RENEWAL_FACTS.keyDates[1]!.label).toContain("$580");
    expect(PILOT_RENEWAL_FACTS.keyDates[1]!.label).toContain("80 hours");
    // Review fix: the 2027 changes do not apply outside ages 19 through 64,
    // and the source's condition stays with that line (second review: it
    // read as continued coverage without it).
    expect(PILOT_RENEWAL_FACTS.keyDates[2]!.label).toMatch(/younger than 19 or older than 64/);
    expect(PILOT_RENEWAL_FACTS.keyDates[2]!.label).toMatch(
      /does not change, as long as they still meet Medicaid eligibility requirements$/,
    );
  });

  it("says how long a person has to answer a renewal letter (review fix)", () => {
    const rule = PILOT_RENEWAL_FACTS.rules.find((item) => item.text.includes("30 days"));
    expect(rule?.text).toMatch(/30 days to answer the first letter/);
    expect(rule?.text).toMatch(/within 12 days/);
    expect(rule?.source.sourceTitle).toMatch(/fact sheet/);
  });

  it("says what happens if coverage ends: the letter, the appeal window, and free help (review fix)", () => {
    const texts = PILOT_RENEWAL_FACTS.ifCoverageEnds.map((item) => item.text);
    expect(texts.some((text) => /60 days from the date on the letter/.test(text))).toBe(true);
    expect(texts.some((text) => /Ombudsman at 1-877-201-3750/.test(text))).toBe(true);
    for (const item of PILOT_RENEWAL_FACTS.ifCoverageEnds) {
      expect(item.source.sourceUrl).toBe("https://medicaid.ncdhhs.gov/beneficiaries/medicaid-is-changing");
    }
    const labels = PILOT_RENEWAL_FACTS.links.map((link) => link.label);
    expect(labels).toContain("How to appeal a Medicaid decision");
    expect(labels.some((label) => label.startsWith("NC Medicaid Ombudsman"))).toBe(true);
  });

  it("only says email works where the local DSS accepts it (review fix)", () => {
    const ways = PILOT_RENEWAL_FACTS.documents.find((item) => item.text.startsWith("Ways to return it"));
    expect(ways?.text).toMatch(/by email if the local DSS accepts it\.$/);
  });

  it("scopes the 6-month schedule to ages 19 through 64 and lists no press release (review fix)", () => {
    const sixMonths = PILOT_RENEWAL_FACTS.schedules.find((item) => item.id === "every_6_months");
    expect(sixMonths?.ages).toEqual({ min: 19, max: 64 });
    expect(PILOT_RENEWAL_ENTRY.sources.some((source) => /press-release/.test(source.url))).toBe(false);
    for (const source of PILOT_RENEWAL_ENTRY.sources) {
      // Download links to documents say they are PDFs (review a11y fix).
      if (/\/download\?attachment/.test(source.url)) {
        expect(source.title, source.url).toContain("(PDF)");
      }
    }
  });

  it("cites each schedule with the page that states it (second review)", () => {
    const sixMonths = PILOT_RENEWAL_FACTS.schedules.find((item) => item.id === "every_6_months")!;
    const yearly = PILOT_RENEWAL_FACTS.schedules.find((item) => item.id === "once_a_year")!;
    // The Medicaid is Changing page states the 19 through 64 scope; the work
    // requirement page tells exempt people of every age they renew every 6
    // months, so it must not be the source shown for that scope.
    expect(sixMonths.source.sourceUrl).toBe("https://medicaid.ncdhhs.gov/beneficiaries/medicaid-is-changing");
    expect(sixMonths.source.sourceTitle).toMatch(/Medicaid is Changing/);
    // The work requirement page is the one that states the IHS once-a-year line.
    expect(yearly.source.sourceUrl).toMatch(/work-and-community-engagement-requirement$/);
    expect(yearly.appliesTo).toMatch(/Indian Health Services/);
  });

  it("gives every fact an official https source, a real retrieval date, and the entry version", () => {
    const sources = allSources(PILOT_RENEWAL_FACTS);
    expect(sources.length).toBe(
      PILOT_RENEWAL_FACTS.schedules.length +
        PILOT_RENEWAL_FACTS.keyDates.length +
        PILOT_RENEWAL_FACTS.deadlineNotes.length +
        PILOT_RENEWAL_FACTS.rules.length +
        PILOT_RENEWAL_FACTS.documents.length +
        PILOT_RENEWAL_FACTS.steps.length +
        PILOT_RENEWAL_FACTS.ifCoverageEnds.length +
        PILOT_RENEWAL_FACTS.links.length,
    );
    expect(sources.length).toBeGreaterThan(10);
    for (const source of sources) {
      expect(source.sourceUrl).toMatch(OFFICIAL_HOST);
      expect(source.sourceTitle.length).toBeGreaterThan(0);
      expect(parseIsoDate(source.retrievedAt)).not.toBeNull();
      expect(source.entryVersion).toBe(PILOT_RENEWAL_ENTRY.version);
    }
    for (const link of PILOT_RENEWAL_FACTS.links) {
      expect(link.url).toMatch(OFFICIAL_HOST);
    }
  });

  it("is plain data that survives the trip from server to client", () => {
    expect(JSON.parse(JSON.stringify(PILOT_RENEWAL_FACTS))).toEqual(PILOT_RENEWAL_FACTS);
    expect(bannerFacts(PILOT_RENEWAL_FACTS)).toEqual({
      entryId: "nc_medicaid_renewal",
      programName: "NC Medicaid",
      entryStatus: "active",
      schedules: PILOT_RENEWAL_FACTS.schedules,
    });
  });
});

describe("non-active entries are never shown silently (BN-29)", () => {
  it("keeps a stale entry's facts with the stale status and reason", () => {
    const view = buildRenewalFactsView(withStatus("stale"));
    expect(view.entryStatus).toBe("stale");
    expect(view.statusReason).toBe("The source page changed after it was read.");
    expect(view.schedules.length).toBe(PILOT_RENEWAL_FACTS.schedules.length);
  });

  it("drops every fact from a withdrawn entry but keeps the reason", () => {
    const view = buildRenewalFactsView(withStatus("withdrawn"));
    expect(view.entryStatus).toBe("withdrawn");
    expect(view.statusReason).toBe("The source page changed after it was read.");
    expect(allSources(view)).toEqual([]);
    expect(view.schedules).toEqual([]);
  });
});
