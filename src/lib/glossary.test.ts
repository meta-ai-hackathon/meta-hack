import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  GLOSSARY_TERMS,
  glossaryTermById,
  glossaryTermsForText,
} from "./glossary";

// Plain-language glossary (BN-30): benefits terms explained from official
// sources, used by the assistant and the match card. Every definition must
// trace to an official https source with a retrieval date, the data must
// stay pilot-agnostic, and the term lookup that grounds card copy must be
// deterministic.

const GLOSSARY_PATH = fileURLToPath(new URL("../../kb/glossary.json", import.meta.url));

describe("glossary data (BN-30)", () => {
  it("ships terms and loads them through the validated dataset", () => {
    expect(GLOSSARY_TERMS.length).toBeGreaterThanOrEqual(3);
  });

  it("keeps every definition traceable to an official source with a retrieval date", () => {
    for (const term of GLOSSARY_TERMS) {
      expect(term.source.url.startsWith("https://"), term.id).toBe(true);
      expect(term.source.retrievedAt, term.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(term.source.title.length, term.id).toBeGreaterThan(0);
      expect(term.definition.length, term.id).toBeGreaterThan(0);
      expect(term.term.length, term.id).toBeGreaterThan(0);
    }
  });

  it("matches the committed kb/glossary.json document", () => {
    const raw = JSON.parse(readFileSync(GLOSSARY_PATH, "utf8")) as {
      terms: { id: string }[];
    };
    expect(GLOSSARY_TERMS.map((term) => term.id)).toEqual(
      raw.terms.map((term) => term.id),
    );
  });

  it("carries unique snake_case ids resolvable by lookup", () => {
    const ids = GLOSSARY_TERMS.map((term) => term.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(glossaryTermById(id)?.id).toBe(id);
    }
    expect(glossaryTermById("no_such_term")).toBeUndefined();
  });

  it("uses pilot-agnostic placeholders only", () => {
    const text = readFileSync(GLOSSARY_PATH, "utf8");
    // Word-bounded like the repo's KB blocklist scan: "assistance" must not
    // trip "ssi".
    expect(text).not.toMatch(/\b(medicaid|medicare|snap|tanf|ssi|ssdi|wic)\b/i);
  });
});

describe("glossaryTermsForText — the card-copy grounding lookup", () => {
  it("finds a term when its words appear in the text", () => {
    const terms = glossaryTermsForText(
      "This program may help with food assistance for your household.",
    );
    expect(terms.map((term) => term.id)).toContain("food_assistance");
  });

  it("matches case-insensitively on word boundaries", () => {
    expect(
      glossaryTermsForText("GOVERNMENT BENEFITS may help.").map((t) => t.id),
    ).toContain("government_benefits");
    // A substring inside an unrelated word is not the term.
    expect(glossaryTermsForText("unbendangered")).toEqual([]);
  });

  it("returns terms in dataset order and deduplicates", () => {
    const text = "Food assistance. Food assistance. Government benefits.";
    expect(glossaryTermsForText(text).map((t) => t.id)).toEqual([
      "government_benefits",
      "food_assistance",
    ]);
  });

  it("never returns a term for arbitrary word salad (property)", () => {
    // Words from a disjoint alphabet can never match the shipped terms.
    const salad = fc.string({
      unit: fc.constantFrom("qqq", "wwww", "zzz", "xkcd", "fffe", "mmmn"),
      minLength: 1,
      maxLength: 8,
    });
    const attempts = fc.property(fc.array(salad, { minLength: 0, maxLength: 6 }), (words) => {
      return glossaryTermsForText(words.join(" ")).length === 0;
    });
    fc.assert(attempts, { numRuns: 200 });
  });
});
