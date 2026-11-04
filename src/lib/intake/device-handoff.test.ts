import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { KB_ENTRIES, SAMPLE_KB_ENTRIES, type KbEntry, type KbEntryStatus } from "../kb";
import { deviceHandoffLinks } from "./device-form";

// Where the step-by-step page tells people to take their filled form
// (HACK-115): the official links of the pilot's knowledge base entries,
// each with its source. A stale or withdrawn entry is never presented, the
// same rule the match follows (BN-29). Citing one would also throw, since
// the knowledge base refuses to cite a non-active entry silently, so a
// stale entry must not break the page either.

const BASE_ENTRIES: readonly KbEntry[] = [...KB_ENTRIES, ...SAMPLE_KB_ENTRIES];

const entryArb: fc.Arbitrary<KbEntry> = fc
  .tuple(
    fc.constantFrom(...BASE_ENTRIES),
    fc.constantFrom<KbEntryStatus>("active", "stale", "withdrawn"),
  )
  .map(([entry, status]) =>
    status === "active"
      ? { ...entry, status }
      : { ...entry, status, statusReason: `Test fixture: entry marked ${status}` },
  );

describe("deviceHandoffLinks", () => {
  it("lists exactly the active entries' official links, each citing its active entry", () => {
    fc.assert(
      fc.property(fc.array(entryArb, { maxLength: 6 }), (entries) => {
        const links = deviceHandoffLinks(entries);
        const active = entries.filter((entry) => entry.status === "active");
        expect(links.map((link) => [link.source.entryId, link.label, link.url])).toEqual(
          active.flatMap((entry) =>
            entry.facts.official_links.items.map((item) => [entry.id, item.label, item.url]),
          ),
        );
        for (const link of links) {
          expect(link.source.entryStatus).toBe("active");
          expect(link.source.sourceUrl).toMatch(/^https:\/\//);
        }
      }),
    );
  });

  it("uses the pilot's own entries by default", () => {
    expect(deviceHandoffLinks()).toEqual(deviceHandoffLinks(KB_ENTRIES));
    expect(deviceHandoffLinks().length).toBeGreaterThan(0);
  });
});
