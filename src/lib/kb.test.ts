import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { describe, expect, expectTypeOf, it } from "vitest";
import sampleEntryJson from "../../kb/entries/pilot-program-sample.json";
import {
  KB_ENTRIES,
  KB_ENTRY_STATUSES,
  KB_FACT_GROUPS,
  KbValidationError,
  SilentCitationError,
  citeFactGroup,
  parseKbEntry,
  validateKbEntry,
  type KbCitation,
  type KbEntry,
  type KbEntryStatus,
} from "./kb";

// The shipped sample entry, in its raw (snake_case JSON) form, for mutation
// tests. structuredClone keeps every test's copy independent.
const RAW_SAMPLE = structuredClone(sampleEntryJson) as unknown;

function rawClone(): Record<string, unknown> {
  return structuredClone(sampleEntryJson) as Record<string, unknown>;
}

function rawWithStatus(status: string): Record<string, unknown> {
  const raw = rawClone();
  raw.status = status;
  if (status !== "active") {
    raw.status_reason = "Test fixture: entry marked " + status;
  }
  return raw;
}

function parsedWithStatus(status: KbEntryStatus): KbEntry {
  return parseKbEntry(rawWithStatus(status));
}

// Every required field path in the raw entry shape (top level, source items,
// and each fact group). No required field may be omittable — exercised
// exhaustively in a property below.
const REQUIRED_PATHS: (string | number)[][] = [
  ["id"],
  ["title"],
  ["version"],
  ["status"],
  ["sources"],
  ["facts"],
  ["sources", 0, "id"],
  ["sources", 0, "title"],
  ["sources", 0, "url"],
  ["sources", 0, "retrieved_at"],
  ["sources", 0, "supports"],
];

for (const group of KB_FACT_GROUPS) {
  REQUIRED_PATHS.push(["facts", group, "items"]);
  REQUIRED_PATHS.push(["facts", group, "source_id"]);
  REQUIRED_PATHS.push(["facts", group, "retrieved_at"]);
}

function deleteAtPath(raw: Record<string, unknown>, path: (string | number)[]): void {
  let node: unknown = raw;
  for (const key of path.slice(0, -1)) {
    node = (node as Record<string, unknown>)[key as string];
  }
  const last = path[path.length - 1] as string | number;
  if (Array.isArray(node) && typeof last === "number") {
    node.splice(last, 1);
  } else {
    delete (node as Record<string, unknown>)[last as string];
  }
}

// Parsed from the repo's schema at test time — the vocabularies are compared
// against this module's constants so the two cannot drift apart.
const SCHEMA_PATH = fileURLToPath(new URL("../../kb/schema.json", import.meta.url));

describe("schema mirror", () => {
  it("status enum in kb/schema.json equals KB_ENTRY_STATUSES", () => {
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8")) as {
      properties: { status: { enum: string[] } };
    };
    expect([...schema.properties.status.enum].sort()).toEqual(
      [...KB_ENTRY_STATUSES].sort(),
    );
  });

  it("fact groups in kb/schema.json equal KB_FACT_GROUPS", () => {
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8")) as {
      definitions: { facts: { required: string[] } };
    };
    expect([...schema.definitions.facts.required].sort()).toEqual(
      [...KB_FACT_GROUPS].sort(),
    );
  });
});

describe("shipped sample entry", () => {
  it("validates cleanly against the schema rules", () => {
    expect(validateKbEntry(RAW_SAMPLE)).toEqual([]);
  });

  it("parses with version, sources, and per-group provenance", () => {
    const entry = parseKbEntry(RAW_SAMPLE);
    expect(entry.id).toBe("pilot_program_sample");
    // Bumped to 2 when the optional steps/match_signals groups landed
    // (mission v2 M3) — the versioning rule bumps on any fact change.
    expect(entry.version).toBe(2);
    expect(entry.status).toBe("active");
    expect(entry.sources.length).toBeGreaterThanOrEqual(1);
    for (const source of entry.sources) {
      expect(source.url.startsWith("https://")).toBe(true);
      expect(source.retrievedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(source.supports.length).toBeGreaterThan(0);
    }
    for (const group of KB_FACT_GROUPS) {
      const facts = entry.facts[group];
      expect(facts.items.length).toBeGreaterThanOrEqual(1);
      expect(facts.sourceId.length).toBeGreaterThan(0);
      expect(facts.retrievedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("uses pilot-agnostic placeholders, not program data", () => {
    const text = JSON.stringify(sampleEntryJson);
    expect(text).toContain("{{PILOT_PROGRAM}}");
    expect(text).not.toContain("{{PILOT_PROGRAM}}{{");
  });

  it("ships the three samples plus the real pilot entry, in load order", () => {
    // Mission v2 M3 added matching fixtures B and C; mission v2.1 M6 added
    // the real pilot entry (HACK-16 Done) at the end of the load order —
    // the samples stay first so sample-keyed tests are stable.
    expect(KB_ENTRIES.map((entry) => entry.id)).toEqual([
      "pilot_program_sample",
      "pilot_program_sample_b",
      "pilot_program_sample_c",
      "nc_medicaid",
    ]);
    expect(KB_ENTRIES[0]).toEqual(parseKbEntry(RAW_SAMPLE));
  });
});

describe("status states", () => {
  it("validates entries in every status state", () => {
    for (const status of KB_ENTRY_STATUSES) {
      const raw = rawWithStatus(status);
      expect(validateKbEntry(raw), status).toEqual([]);
      expect(parseKbEntry(raw).status, status).toBe(status);
    }
  });

  it("requires status_reason for stale and withdrawn entries", () => {
    for (const status of ["stale", "withdrawn"] as const) {
      const raw = rawClone();
      raw.status = status;
      const problems = validateKbEntry(raw);
      expect(problems.some((p) => p.includes("status_reason")), status).toBe(true);
      expect(() => parseKbEntry(raw), status).toThrow(KbValidationError);
    }
  });
});

describe("validation failures", () => {
  it("rejects an entry missing any required field (exhaustive)", () => {
    for (const path of REQUIRED_PATHS) {
      const raw = rawClone();
      deleteAtPath(raw, path);
      const problems = validateKbEntry(raw);
      expect(problems.length, `deleting ${path.join(".")} must fail`).toBeGreaterThanOrEqual(1);
      expect(() => parseKbEntry(raw), `deleting ${path.join(".")}`).toThrow(KbValidationError);
    }
  });

  it("rejects a missing version with a named problem", () => {
    const raw = rawClone();
    delete raw.version;
    expect(() => parseKbEntry(raw)).toThrow(/version/);
  });

  it("rejects a missing or empty source list", () => {
    const noSources = rawClone();
    delete noSources.sources;
    expect(() => parseKbEntry(noSources)).toThrow(KbValidationError);
    const emptySources = rawClone();
    emptySources.sources = [];
    expect(() => parseKbEntry(emptySources)).toThrow(KbValidationError);
  });

  it("rejects sources missing the official url or retrieval date", () => {
    const noUrl = rawClone();
    delete (noUrl.sources as Record<string, unknown>[])[0].url;
    expect(() => parseKbEntry(noUrl)).toThrow(/url/);
    const noDate = rawClone();
    delete (noDate.sources as Record<string, unknown>[])[0].retrieved_at;
    expect(() => parseKbEntry(noDate)).toThrow(/retrieved_at/);
  });

  it("rejects fact groups missing their retrieval date or source link", () => {
    for (const group of KB_FACT_GROUPS) {
      const noDate = rawClone();
      const factsNoDate = noDate.facts as Record<string, Record<string, unknown>>;
      delete factsNoDate[group].retrieved_at;
      expect(
        () => parseKbEntry(noDate),
        `${group} without retrieved_at`,
      ).toThrow(/retrieved_at/);

      const noSource = rawClone();
      const factsNoSource = noSource.facts as Record<string, Record<string, unknown>>;
      delete factsNoSource[group].source_id;
      expect(
        () => parseKbEntry(noSource),
        `${group} without source_id`,
      ).toThrow(/source_id/);
    }
  });

  it("rejects fact groups whose source_id points nowhere", () => {
    const raw = rawClone();
    (raw.facts as Record<string, unknown>).rules = {
      items: ["a rule"],
      source_id: "not_a_listed_source",
      retrieved_at: "2026-10-29",
    };
    expect(() => parseKbEntry(raw)).toThrow(KbValidationError);
  });

  it("rejects non-https source urls", () => {
    const raw = rawClone();
    (raw.sources as Record<string, unknown>[])[0].url = "http://example.org/insecure";
    expect(() => parseKbEntry(raw)).toThrow(KbValidationError);
  });

  it("rejects keys the schema does not allow", () => {
    const entryLevel = rawClone();
    entryLevel.bonus_field = "not in the schema";
    expect(() => parseKbEntry(entryLevel)).toThrow(/bonus_field/);
    const groupLevel = rawClone();
    (groupLevel.facts as Record<string, unknown>).extra_group = {
      items: ["x"],
      source_id: "official_rules_source",
      retrieved_at: "2026-10-29",
    };
    expect(() => parseKbEntry(groupLevel)).toThrow(/extra_group/);
  });

  it("rejects a malformed superseded_by", () => {
    const raw = rawClone();
    raw.status = "withdrawn";
    raw.status_reason = "program ended";
    raw.superseded_by = "Not A Snake_Id!";
    expect(() => parseKbEntry(raw)).toThrow(/superseded_by/);
  });
});

describe("citation API: stale and withdrawn entries are never cited silently", () => {
  it("surfaces status on every active citation", () => {
    const entry = parseKbEntry(RAW_SAMPLE);
    for (const group of KB_FACT_GROUPS) {
      const citation = citeFactGroup(entry, group);
      expect(citation.status).toBe("active");
      expect(citation.entryId).toBe(entry.id);
      expect(citation.entryVersion).toBe(entry.version);
      expect(citation.retrievedAt).toBe(entry.facts[group].retrievedAt);
      expect(citation.sourceUrl.startsWith("https://")).toBe(true);
    }
  });

  it("throws SilentCitationError for a stale entry without acknowledgment", () => {
    const entry = parsedWithStatus("stale");
    expect(() => citeFactGroup(entry, "rules")).toThrow(SilentCitationError);
  });

  it("throws SilentCitationError for a withdrawn entry without acknowledgment", () => {
    const entry = parsedWithStatus("withdrawn");
    expect(() => citeFactGroup(entry, "deadlines")).toThrow(SilentCitationError);
  });

  it("carries status and reason even when a stale citation is acknowledged", () => {
    const entry = parsedWithStatus("stale");
    const citation = citeFactGroup(entry, "rules", { acknowledgeNonActive: true });
    expect(citation.status).toBe("stale");
    expect(citation.statusReason).toBe(entry.statusReason);
  });

  it("carries status and reason for acknowledged withdrawn citations", () => {
    const entry = parsedWithStatus("withdrawn");
    const citation = citeFactGroup(entry, "official_links", {
      acknowledgeNonActive: true,
    });
    expect(citation.status).toBe("withdrawn");
    expect(citation.statusReason).toBe(entry.statusReason);
  });

  it("exposes status as a required, typed citation field", () => {
    expectTypeOf<KbCitation["status"]>().toEqualTypeOf<KbEntryStatus>();
    expectTypeOf<KbCitation["retrievedAt"]>().toEqualTypeOf<string>();
  });
});

describe("optional fact groups: steps and match_signals (mission v2 M3)", () => {
  // A raw entry clone carrying both optional groups, shaped exactly as the
  // shipped sample entries do. Signals point at generic spec question ids
  // and carry the program-side reason every card reason is built from.
  function rawWithOptionalGroups(): Record<string, unknown> {
    const raw = rawClone();
    const facts = raw.facts as Record<string, Record<string, unknown>>;
    facts.steps = {
      items: ["Gather the required documents.", "Start the application."],
      source_id: "official_rules_source",
      retrieved_at: "2026-10-29",
    };
    facts.match_signals = {
      items: [
        {
          question_id: "housing_status",
          values: ["shelter", "car"],
          weight: 3,
          reason: "The program's rules give priority to people without stable housing.",
        },
        { question_id: "household_size", reason: "The program considers household size." },
      ],
      source_id: "official_rules_source",
      retrieved_at: "2026-10-29",
    };
    return raw;
  }

  it("validates an entry carrying both optional groups", () => {
    expect(validateKbEntry(rawWithOptionalGroups())).toEqual([]);
  });

  it("omits the optional groups from the parsed entry when absent", () => {
    const bare = rawClone();
    const bareFacts = bare.facts as Record<string, unknown>;
    delete bareFacts.steps;
    delete bareFacts.match_signals;
    const entry = parseKbEntry(bare);
    expect(entry.facts.steps).toBeUndefined();
    expect(entry.facts.match_signals).toBeUndefined();
  });

  it("parses the optional groups with per-group provenance", () => {
    const entry = parseKbEntry(rawWithOptionalGroups());
    expect(entry.facts.steps?.items).toEqual([
      "Gather the required documents.",
      "Start the application.",
    ]);
    expect(entry.facts.steps?.sourceId).toBe("official_rules_source");
    expect(entry.facts.match_signals?.items[0]?.questionId).toBe("housing_status");
    expect(entry.facts.match_signals?.items[0]?.weight).toBe(3);
    expect(entry.facts.match_signals?.items[0]?.values).toEqual(["shelter", "car"]);
    expect(entry.facts.match_signals?.items[1]?.values).toBeUndefined();
    expect(entry.facts.match_signals?.retrievedAt).toBe("2026-10-29");
  });

  it("cites the optional groups through the same citation API", () => {
    const entry = parseKbEntry(rawWithOptionalGroups());
    for (const group of ["steps", "match_signals"] as const) {
      const citation = citeFactGroup(entry, group);
      expect(citation.status).toBe("active");
      expect(citation.sourceUrl.startsWith("https://")).toBe(true);
      expect(citation.retrievedAt).toBe("2026-10-29");
    }
  });

  it("rejects a signal without a reason", () => {
    const raw = rawWithOptionalGroups();
    const signals = (raw.facts as Record<string, Record<string, unknown>>)
      .match_signals as Record<string, unknown>;
    delete (signals.items as Record<string, unknown>[])[0].reason;
    expect(() => parseKbEntry(raw)).toThrow(/reason/);
  });

  it("rejects a signal with a malformed question id", () => {
    const raw = rawWithOptionalGroups();
    const signals = (raw.facts as Record<string, Record<string, unknown>>)
      .match_signals as Record<string, unknown>;
    (signals.items as Record<string, unknown>[])[0].question_id = "Not A Question!";
    expect(() => parseKbEntry(raw)).toThrow(/question_id/);
  });

  it("rejects a signal with an unknown key", () => {
    const raw = rawWithOptionalGroups();
    const signals = (raw.facts as Record<string, Record<string, unknown>>)
      .match_signals as Record<string, unknown>;
    (signals.items as Record<string, unknown>[])[0].bonus = "nope";
    expect(() => parseKbEntry(raw)).toThrow(/bonus/);
  });

  it("rejects a non-integer or out-of-range weight", () => {
    for (const weight of [0, -1, 1.5, "high", 10]) {
      const raw = rawWithOptionalGroups();
      const signals = (raw.facts as Record<string, Record<string, unknown>>)
        .match_signals as Record<string, unknown>;
      (signals.items as Record<string, unknown>[])[0].weight = weight;
      expect(() => parseKbEntry(raw), `weight ${JSON.stringify(weight)}`).toThrow(
        KbValidationError,
      );
    }
  });

  it("rejects an empty values list and an empty items array", () => {
    const emptyValues = rawWithOptionalGroups();
    const signals = (emptyValues.facts as Record<string, Record<string, unknown>>)
      .match_signals as Record<string, unknown>;
    (signals.items as Record<string, unknown>[])[0].values = [];
    expect(() => parseKbEntry(emptyValues)).toThrow(KbValidationError);

    const emptyItems = rawWithOptionalGroups();
    const otherSignals = (emptyItems.facts as Record<string, Record<string, unknown>>)
      .match_signals as Record<string, unknown>;
    otherSignals.items = [];
    expect(() => parseKbEntry(emptyItems)).toThrow(/non-empty/);
  });

  it("rejects the optional groups when their provenance is broken", () => {
    const raw = rawWithOptionalGroups();
    const facts = raw.facts as Record<string, Record<string, unknown>>;
    (facts.steps as Record<string, unknown>).source_id = "not_a_listed_source";
    expect(() => parseKbEntry(raw)).toThrow(/source/);
  });
});

describe("properties (fast-check)", () => {
  it("never throws anything but KbValidationError on arbitrary input", () => {
    // Totality: parsing either yields an entry or fails with the typed error
    // (fc could in principle hit a valid shape — that is fine). A leak of any
    // other error type is the bug this property forbids.
    const attempts = fc.property(fc.anything(), (value) => {
      try {
        parseKbEntry(value);
        return true;
      } catch (error) {
        return error instanceof KbValidationError;
      }
    });
    fc.assert(attempts, { numRuns: 300 });
  });

  it("propagates any non-active status reason into acknowledged citations", () => {
    const reasonArbitrary = fc
      .string({ minLength: 1, maxLength: 120 })
      .filter((reason) => reason.trim().length > 0);
    const attempts = fc.property(
      fc.constantFrom("stale", "withdrawn"),
      reasonArbitrary,
      fc.constantFrom(...KB_FACT_GROUPS),
      (status, reason, group) => {
        const raw = rawClone();
        raw.status = status;
        raw.status_reason = reason;
        const citation = citeFactGroup(parseKbEntry(raw), group, {
          acknowledgeNonActive: true,
        });
        return citation.status === status && citation.statusReason === reason;
      },
    );
    fc.assert(attempts, { numRuns: 100 });
  });

  it("accepts exactly the real calendar dates as retrieval dates", () => {
    const dateArbitrary = fc
      .record({
        year: fc.integer({ min: 1900, max: 2100 }),
        month: fc.integer({ min: 0, max: 13 }),
        day: fc.integer({ min: 0, max: 32 }),
      })
      .map(({ year, month, day }) => {
        const mm = String(month).padStart(2, "0");
        const dd = String(day).padStart(2, "0");
        return `${year}-${mm}-${dd}`;
      });
    // Independent oracle: a month-length table, not the Date arithmetic the
    // production check uses.
    const isLeap = (year: number) =>
      (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    const daysInMonth = (month: number, year: number): number => {
      const lengths = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
      if (month < 1 || month > 12) {
        return 0;
      }
      if (month === 2 && isLeap(year)) {
        return 29;
      }
      return lengths[month - 1];
    };
    const attempts = fc.property(dateArbitrary, (date) => {
      const raw = rawClone();
      (raw.facts as Record<string, unknown>).rules = {
        items: ["a rule"],
        source_id: "official_rules_source",
        retrieved_at: date,
      };
      const [year, month, day] = date.split("-").map(Number);
      const realDate =
        day >= 1 && day <= daysInMonth(month, year) && month >= 1 && month <= 12;
      return realDate
        ? validateKbEntry(raw).length === 0
        : validateKbEntry(raw).length > 0;
    });
    fc.assert(attempts, { numRuns: 300 });
  });
});
