import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import type { AnswerMap } from "./flow";
import { QUESTION_BY_ID } from "./spec";
import {
  INCOME_580_MONTHLY_THRESHOLD,
  INCOME_580_QUESTION_ID,
  matchIncome580,
} from "./work-requirements";

// The $580/month income screen's deterministic match (work-requirements
// milestone, VAL-WR-008). When the session already captured income
// answers, the screen is PRE-ANSWERED by a documented deterministic
// comparison — shown as "Matched for you" and person-correctable on the
// stage; when income was not captured (or the capture cannot be converted
// to a monthly figure with certainty), the question is asked directly.
// HACK-86 discipline: the engine computes from stored answers; no LLM can
// be reached from this path (the import-boundary describe below proves
// it), and the proposal is a form answer only — never a compliance
// statement.

function amount(id: string, value: number): AnswerMap {
  return { [id]: { status: "known", value } };
}

function frequency(id: string, value: string): AnswerMap {
  return { [id]: { status: "known", value } };
}

function merge(...maps: readonly AnswerMap[]): AnswerMap {
  return Object.assign({}, ...maps);
}

/** A known income_sources answer naming the given option values. */
function sources(...values: string[]): AnswerMap {
  return { income_sources: { status: "known", value: values } };
}

describe("matchIncome580 (VAL-WR-008, the documented rule)", () => {
  it("proposes for the spec question it names — a yes/no screen, asked directly otherwise", () => {
    const question = QUESTION_BY_ID[INCOME_580_QUESTION_ID];
    expect(question).toBeDefined();
    const values = question.options?.map((option) => option.value);
    expect(values).toContain("yes");
    expect(values).toContain("no");
  });

  it("asks directly when no income was captured", () => {
    expect(matchIncome580({})).toEqual({
      proposal: null,
      monthlyTotal: null,
      countedSourceIds: [],
      uncountedSourceIds: [],
    });
  });

  it("asks directly when the only stored income answers are not known", () => {
    const answers: AnswerMap = {
      job_income_amount: { status: "unknown", value: null },
      other_income_amount: { status: "unverified", value: null },
    };
    expect(matchIncome580(answers).proposal).toBeNull();
  });

  it("converts each frequency by its documented monthly factor", () => {
    // weekly ×4 → 400, and even the average-month conversion (×52/12 ≈
    // 433) stays under: no, with every source accounted for.
    expect(
      matchIncome580(
        merge(
          amount("job_income_amount", 100),
          frequency("job_income_frequency", "weekly"),
          sources("job"),
        ),
      ).proposal,
    ).toBe("no");
    // biweekly ×2 → 600 ≥ 580: yes.
    expect(matchIncome580(merge(amount("job_income_amount", 300), frequency("job_income_frequency", "biweekly"))).proposal).toBe("yes");
    // twice monthly ×2 → 600 ≥ 580: yes.
    expect(matchIncome580(merge(amount("job_income_amount", 300), frequency("job_income_frequency", "twice_monthly"))).proposal).toBe("yes");
    // monthly ×1, exactly at the threshold: the screen asks "at least $580" — yes.
    expect(matchIncome580(merge(amount("job_income_amount", INCOME_580_MONTHLY_THRESHOLD), frequency("job_income_frequency", "monthly"))).proposal).toBe("yes");
    // Just under: no.
    expect(matchIncome580(merge(amount("job_income_amount", INCOME_580_MONTHLY_THRESHOLD - 0.01), frequency("job_income_frequency", "monthly"), sources("job"))).proposal).toBe("no");
  });

  it("never fakes a 'no' from understated weeks: $140/week averages over the threshold, so the session is asked (claude-review P2)", () => {
    // Floor 4 × 140 = 560 (< 580) but the average month is 140 × 52/12
    // ≈ 606.67 — a certain 'no' must survive the UPPER factors too.
    const answers = merge(
      amount("job_income_amount", 140),
      frequency("job_income_frequency", "weekly"),
      sources("job"),
    );
    expect(matchIncome580(answers)).toMatchObject({
      proposal: null,
      countedSourceIds: ["job_income_amount"],
      uncountedSourceIds: [],
    });
  });

  it("withholds a 'no' when income_sources names money the match never reads (claude-review P2)", () => {
    // Self-employment only: the match sees no amount question for it and
    // cannot rule the money out — asked directly, never a blind 'no'.
    expect(
      matchIncome580(sources("self_employed")).proposal,
    ).toBeNull();
    // Family money named but not captured: the small captured amount
    // stays a proposal-less total.
    const withFamily = merge(
      amount("other_income_amount", 100),
      sources("other", "family_friends"),
    );
    expect(matchIncome580(withFamily).proposal).toBeNull();
    // Same amounts with the sources list accounting for everything: the
    // 'no' becomes certain.
    const accounted = merge(
      amount("other_income_amount", 100),
      sources("other"),
    );
    expect(matchIncome580(accounted).proposal).toBe("no");
  });

  it("treats other_income_amount as monthly by definition (the question asks per month)", () => {
    expect(matchIncome580(amount("other_income_amount", 600)).proposal).toBe("yes");
    expect(matchIncome580(merge(amount("other_income_amount", 100), sources("other"))).proposal).toBe("no");
  });

  it("sums every countable source into the monthly total", () => {
    const answers = merge(
      amount("job_income_amount", 100),
      frequency("job_income_frequency", "weekly"), // 400
      amount("benefits_income_amount", 200),
      frequency("benefits_income_frequency", "monthly"), // 200
      amount("other_income_amount", 100), // 100
    );
    const match = matchIncome580(answers);
    expect(match.monthlyTotal).toBe(700);
    expect(match.proposal).toBe("yes");
    expect(match.countedSourceIds).toEqual([
      "job_income_amount",
      "benefits_income_amount",
      "other_income_amount",
    ]);
    expect(match.uncountedSourceIds).toEqual([]);
  });

  it("never estimates: a captured amount with a 'varies' frequency is not convertible, so the proposal only survives when the counted sources alone cross the threshold", () => {
    // Job income varies and benefits alone stay under the threshold:
    // the total is uncertain, so the question is asked directly.
    const uncertain = merge(
      amount("job_income_amount", 900),
      frequency("job_income_frequency", "varies"),
      amount("benefits_income_amount", 100),
      frequency("benefits_income_frequency", "monthly"),
    );
    expect(matchIncome580(uncertain)).toMatchObject({
      proposal: null,
      monthlyTotal: 100,
      countedSourceIds: ["benefits_income_amount"],
      uncountedSourceIds: ["job_income_amount"],
    });

    // The counted sources ALONE cross the threshold: a "yes" proposal is
    // certain (a non-negative extra source cannot lower the total).
    const certain = merge(
      amount("job_income_amount", 900),
      frequency("job_income_frequency", "varies"),
      amount("benefits_income_amount", 700),
      frequency("benefits_income_frequency", "monthly"),
    );
    expect(matchIncome580(certain)).toMatchObject({
      proposal: "yes",
      monthlyTotal: 700,
      uncountedSourceIds: ["job_income_amount"],
    });
  });

  it("skips a missing frequency the same as a 'varies' one (uncountable, ask directly)", () => {
    const answers = merge(amount("job_income_amount", 900));
    expect(matchIncome580(answers)).toMatchObject({
      proposal: null,
      monthlyTotal: null,
      countedSourceIds: [],
      uncountedSourceIds: ["job_income_amount"],
    });
  });

  it("counts a zero amount (0 monthly is a certain 'no')", () => {
    const answers = merge(
      amount("job_income_amount", 0),
      frequency("job_income_frequency", "monthly"),
      sources("job"),
    );
    expect(matchIncome580(answers)).toMatchObject({
      proposal: "no",
      monthlyTotal: 0,
      countedSourceIds: ["job_income_amount"],
    });
  });

  it("treats a negative amount as not an income answer (uncountable, ask directly)", () => {
    const answers = merge(
      amount("job_income_amount", -5),
      frequency("job_income_frequency", "monthly"),
    );
    expect(matchIncome580(answers).proposal).toBeNull();
  });

  it("is pure: the same input map produces the same match (property)", () => {
    fc.assert(
      fc.property(incomeAnswersArb, (answers) => {
        expect(matchIncome580(answers)).toEqual(matchIncome580(answers));
      }),
    );
  });

  it("only proposes what is certain from the captured numbers (property)", () => {
    fc.assert(
      fc.property(incomeAnswersArb, (answers) => {
        const match = matchIncome580(answers);
        if (match.proposal === "yes") {
          // Certain lower bound: the counted sources alone cross it.
          expect(match.monthlyTotal).toBeGreaterThanOrEqual(
            INCOME_580_MONTHLY_THRESHOLD,
          );
        } else if (match.proposal === "no") {
          // Certain upper bound: nothing was captured that could raise
          // it, and no unread source is named (the stored answer
          // accounts for every source of money).
          expect(match.monthlyTotal).toBeLessThan(INCOME_580_MONTHLY_THRESHOLD);
          expect(match.uncountedSourceIds).toEqual([]);
          const named = answers.income_sources;
          expect(named?.status).toBe("known");
          const values = Array.isArray(named?.value) ? named.value : [named?.value];
          for (const item of values) {
            expect(["job", "benefits", "other", "none"]).toContain(item);
          }
        } else {
          // Asked directly: no captured income, or an unconvertible one
          // keeps the total under the threshold with uncertainty left.
          expect(match.monthlyTotal === null || match.monthlyTotal < INCOME_580_MONTHLY_THRESHOLD).toBe(true);
        }
        // The counted/uncounted lists never overlap or fabricate ids.
        const all = [...match.countedSourceIds, ...match.uncountedSourceIds];
        expect(new Set(all).size).toBe(all.length);
        for (const id of all) {
          expect(SOURCE_IDS).toContain(id);
        }
      }),
    );
  });
});

/** The three income-source amount questions the match reads. */
const SOURCE_IDS = [
  "job_income_amount",
  "benefits_income_amount",
  "other_income_amount",
];

const FREQUENCY_VALUES = [
  "weekly",
  "biweekly",
  "twice_monthly",
  "monthly",
  "varies",
] as const;

const INCOME_SOURCE_VALUES = [
  "job",
  "self_employed",
  "benefits",
  "family_friends",
  "child_support",
  "other",
  "none",
] as const;

/** One income-source field: known with a value, unknown, or absent. */
const fieldArb = (value: fc.Arbitrary<unknown>): fc.Arbitrary<
  AnswerMap[string]
> =>
  fc.oneof(
    fc.record({ status: fc.constant("known" as const), value }),
    fc.constant({ status: "unknown" as const, value: null }),
    fc.constant({ status: "unverified" as const, value: null }),
    fc.constant(undefined),
  );

/** An arbitrary answer map over the income fields the match reads. */
const incomeAnswersArb: fc.Arbitrary<AnswerMap> = fc
  .record({
    job_income_amount: fieldArb(fc.integer({ min: -10, max: 5000 })),
    job_income_frequency: fieldArb(fc.constantFrom(...FREQUENCY_VALUES)),
    benefits_income_amount: fieldArb(fc.integer({ min: 0, max: 5000 })),
    benefits_income_frequency: fieldArb(fc.constantFrom(...FREQUENCY_VALUES)),
    other_income_amount: fieldArb(fc.float({ min: 0, max: 5000, noNaN: true })),
    income_sources: fieldArb(
      fc.subarray([...INCOME_SOURCE_VALUES], {
        minLength: 1,
        maxLength: INCOME_SOURCE_VALUES.length,
      }),
    ),
  })
  .filter((map) => Object.values(map).some((entry) => entry !== undefined));

// ---------------------------------------------------------------------------
// The match's import boundary (VAL-WR-008, per the VAL-INC-005 pattern):
// the deterministic rule can never reach a model/LLM client — its static
// import closure stays inside the pure intake engine modules, and a
// simulated violation is reported.
// ---------------------------------------------------------------------------

const INTAKE_ROOT = path.resolve(__dirname);
const WR_MODULE = path.join(INTAKE_ROOT, "work-requirements.ts");
const FIXTURE_DIR = path.join(INTAKE_ROOT, "__wr_boundary_fixture__");

/** Static + dynamic import shapes, mirroring the income boundary scan. */
const IMPORT_PATTERN =
  /(?:\bfrom\s+|\bimport\s*\(\s*|\brequire\s*\(\s*)["']([^"']+)["']/g;

/** Specifiers that must NEVER appear in the deterministic-match path. */
function isForbiddenSpecifier(specifier: string): boolean {
  if (
    /^(?:\.{1,2}\/)+(?:lib\/)?(?:model|conversation)(?:\.js)?(?:\/|$)/.test(
      specifier,
    ) ||
    /^(?:@|#\/)lib\/(?:model|conversation)(?:\.js)?(?:\/|$)/.test(specifier)
  ) {
    return true;
  }
  if (/(^|[/.])prompt/.test(specifier)) {
    return true;
  }
  if (
    /^(openai|anthropic|@anthropic-ai|@ai-sdk|ai|langchain|cohere|mistral|mistralai)(\/|$)/.test(
      specifier,
    )
  ) {
    return true;
  }
  return false;
}

/** The module's transitive relative-import closure inside src/lib/intake. */
function importClosure(entryFile: string): string[] {
  const seen = new Set<string>([entryFile]);
  const queue = [entryFile];
  const files: string[] = [];
  while (queue.length > 0) {
    const file = queue.shift() as string;
    files.push(file);
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(IMPORT_PATTERN)) {
      const specifier = match[1];
      if (!specifier.startsWith(".")) {
        continue;
      }
      const base = path.resolve(path.dirname(file), specifier);
      for (const candidate of [base, `${base}.ts`, path.join(base, "index.ts")]) {
        try {
          if (readFileSync(candidate) && !seen.has(candidate)) {
            seen.add(candidate);
            queue.push(candidate);
          }
          break;
        } catch {
          // try the next candidate
        }
      }
    }
  }
  return files;
}

afterEach(() => {
  rmSync(FIXTURE_DIR, { recursive: true, force: true });
});

describe("the income-screen match's import boundary (VAL-WR-008)", () => {
  it("the match module's import closure carries zero forbidden (model/LLM/prompt) imports", () => {
    const files = importClosure(WR_MODULE);
    expect(files).toContain(WR_MODULE);
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(IMPORT_PATTERN)) {
        expect(
          isForbiddenSpecifier(match[1]),
          `${path.relative(INTAKE_ROOT, file)}: forbidden import ${match[1]}`,
        ).toBe(false);
      }
    }
  });

  it("the match module stays inside the pure intake engine (no network, logging, env, time, or randomness tokens)", () => {
    const source = readFileSync(WR_MODULE, "utf8");
    for (const banned of [
      "console.",
      "fetch(",
      "XMLHttpRequest",
      "process.env",
      "Date.now",
      "new Date(",
      "Math.random",
    ]) {
      expect(source.includes(banned), banned).toBe(false);
    }
  });

  it("bites: a simulated model-client import is reported", () => {
    mkdirSync(FIXTURE_DIR, { recursive: true });
    const violator = path.join(FIXTURE_DIR, "violator.ts");
    writeFileSync(
      violator,
      [
        "// Simulated boundary violation: a module reaching for the model client.",
        'import { chatCompletion } from "../model";',
        "export const violate = chatCompletion;",
        "",
      ].join("\n"),
    );
    const source = readFileSync(violator, "utf8");
    const found = [...source.matchAll(IMPORT_PATTERN)].map((match) => match[1]);
    expect(found).toContain("../model");
    expect(found.find((specifier) => isForbiddenSpecifier(specifier))).toBe(
      "../model",
    );
  });
});
