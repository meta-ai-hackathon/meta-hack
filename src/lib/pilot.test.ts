import { describe, expect, it } from "vitest";
import { PILOT_CONFIG } from "./pilot";
import { getFormRegistryEntry, formRegistryEntries } from "./forms/registry";
import { KB_ENTRIES } from "./kb";
import { assertNoBannedClaimsEverySentence } from "./conversation";

// Pilot-config seam after the HACK-16 lock (Mission v2.1 M6, VAL-PILOTREAL-001):
// the seam now carries the REAL pilot — NC Medicaid, Mecklenburg County — with
// the official DHB-5200 application URL and the retrieval date it was verified.
// The synthetic sample form and the sample KB entries stay available for tests.
// This file is the seam's own sanctioned surface: program names here are the
// lock speaking, and every program fact must still trace to an official source.

const DHB_5200_URL =
  "https://policies.ncdhhs.gov/wp-content/uploads/dhb-5200-ia-9-2020.pdf";
const APPLY_PAGE_URL = "https://medicaid.ncdhhs.gov/apply";
const RETRIEVAL_DATE = "2026-10-30";

describe("pilot seam: the locked real program (VAL-PILOTREAL-001)", () => {
  it("carries the real program, county, and state", () => {
    expect(PILOT_CONFIG.programName).toBe("NC Medicaid");
    expect(PILOT_CONFIG.countyName).toBe("Mecklenburg County");
    expect(PILOT_CONFIG.stateCode).toBe("NC");
  });

  it("carries no placeholder sentinels any more", () => {
    const text = JSON.stringify(PILOT_CONFIG);
    expect(text).not.toContain("{{");
  });

  it("points the form registry at the real DHB-5200 entry", () => {
    expect(PILOT_CONFIG.formRegistryId).toBe("dhb-5200");
    const entry = getFormRegistryEntry(PILOT_CONFIG.formRegistryId);
    expect(entry.source.url).toBe(DHB_5200_URL);
    expect(entry.source.retrievedAt).toBe(RETRIEVAL_DATE);
    expect(entry.source.origin).toBe("official_source");
  });

  it("keeps the synthetic sample form available for tests", () => {
    expect(PILOT_CONFIG.sampleFormRegistryId).toBe("sample-application-form");
    const sample = getFormRegistryEntry(PILOT_CONFIG.sampleFormRegistryId);
    expect(sample.source.origin).toBe("generated_fixture");
    // Both sample variants remain registered (the M4 test fixtures).
    expect(formRegistryEntries().map((entry) => entry.id)).toContain(
      "sample-application-form-flat",
    );
  });

  it("records the official application URL with the page that links it", () => {
    const urls = PILOT_CONFIG.portalLinks.map((link) => link.url);
    expect(urls).toContain(DHB_5200_URL);
    expect(urls).toContain(APPLY_PAGE_URL);
    for (const link of PILOT_CONFIG.portalLinks) {
      expect(link.url.startsWith("https://")).toBe(true);
      expect(link.retrievedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("points the KB at exactly the seam's entries — the dataset is seam-driven", () => {
    expect(PILOT_CONFIG.kbEntryIds).toEqual(["nc_medicaid"]);
    // VAL-PILOTREAL-004: the production export is EXACTLY the seam's set —
    // a synthetic sample entry cannot ship beside (or rank instead of) the
    // real pilot entry in production.
    expect(KB_ENTRIES.map((entry) => entry.id)).toEqual([
      ...PILOT_CONFIG.kbEntryIds,
    ]);
  });

  it("keeps every seam copy string banned-claim clean", () => {
    const strings = [
      PILOT_CONFIG.programName,
      PILOT_CONFIG.countyName,
      ...PILOT_CONFIG.portalLinks.map((link) => link.label),
    ];
    for (const text of strings) {
      expect(() => assertNoBannedClaimsEverySentence(text)).not.toThrow();
    }
  });
});
