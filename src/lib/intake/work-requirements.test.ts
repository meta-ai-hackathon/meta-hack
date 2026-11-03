import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import type { AnswerMap } from "./flow";
import { QUESTION_BY_ID } from "./spec";
import {
  INCOME_580_MONTHLY_THRESHOLD,
  INCOME_580_QUESTION_ID,
  NO_PROOF_NEEDED_NOTE,
  NO_PROOF_NEEDED_NOTE_SENSITIVE,
  NO_PROOF_NEEDED_NOTE_SINGLE,
  SEASONAL_TOTAL_QUESTION_ID,
  isWorkRequirementsQuestionId,
  matchIncome580,
} from "./work-requirements";

// The $580/month income screen's deterministic match (work-requirements
// milestone, VAL-WR-008). When the session already captured income
// answers, the screen can be PRE-ANSWERED by a documented deterministic
// comparison — engine-only in this milestone; part 2 wires the
// "Matched for you" confirm-or-correct surface, and when income was not
// captured (or the capture cannot be converted to a monthly figure with
// certainty), the question is asked directly.
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

describe("the no-proof-needed reassurance (HACK-129)", () => {
  it("classifies exactly the pinned work-requirements question set", () => {
    // The expected set is pinned here, independently of the predicate's
    // implementation: adding a work-requirements question to the spec (or
    // renaming one) fails this test until the set is updated deliberately,
    // so a new WR screen can never silently miss the reassurance. The ids
    // are the Civilla-derived set in specs/question-spec/generic-questions.json
    // (the exemption screens, the other-situations screens, and the
    // work-activity reporting section).
    const EXPECTED_WR_IDS = [
      "wr_applied_last_month",
      "wr_applied_last_month_which",
      "wr_disability_hard_work",
      "wr_drug_alcohol_disorder",
      "wr_drug_alcohol_treatment",
      "wr_exempt_situations",
      "wr_foster_care_under_26",
      "wr_hospital_care_24hr",
      "wr_income_580",
      "wr_jail_prison_past_4_months",
      "wr_medical_travel_1hr",
      "wr_mental_health_hard_work",
      "wr_pregnant",
      "wr_serious_health_condition",
      "wr_student_enrolled",
      "wr_veteran_100_disabled",
      "wr_work_activity_hours",
      "wr_work_activity_types",
      "wr_work_activity_who",
    ];
    const actual = Object.keys(QUESTION_BY_ID)
      .filter((id) => isWorkRequirementsQuestionId(id))
      .sort();
    expect(actual).toEqual(EXPECTED_WR_IDS);
    // And every pinned id still exists in the spec (no stale pins).
    for (const id of EXPECTED_WR_IDS) {
      expect(QUESTION_BY_ID[id], id).toBeDefined();
    }
  });

  it("promises only that answering needs no paperwork; proof may come later", () => {
    for (const note of [
      NO_PROOF_NEEDED_NOTE,
      NO_PROOF_NEEDED_NOTE_SENSITIVE,
      NO_PROOF_NEEDED_NOTE_SINGLE,
    ]) {
      expect(note).toContain("doctor's note");
      expect(note).toContain("may ask for proof later");
      // Guardrails: never a never-proof promise, never a records-first claim.
      expect(note).not.toMatch(
        /never (need|ask)|no proof will|records (will be |are )?checked/i,
      );
    }
    // The sensitive variant scopes itself to the work-requirements cards.
    expect(NO_PROOF_NEEDED_NOTE_SENSITIVE).toContain(
      "work-requirements questions below",
    );
    // The wizard variant is singular: one question per screen.
    expect(NO_PROOF_NEEDED_NOTE_SINGLE).toContain("answer this question");
  });
});

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

  it("withholds a 'no' when a named source's amount never made it into the total (claude-review P2)", () => {
    // benefits is named, but no benefits amount was captured: $100/week
    // alone stays under even the average conversion, yet the named
    // source's money is invisible — asked directly, never a blind 'no'.
    const namedButMissing = merge(
      amount("job_income_amount", 100),
      frequency("job_income_frequency", "weekly"),
      sources("job", "benefits"),
    );
    expect(matchIncome580(namedButMissing).proposal).toBeNull();
    // Same for an amount stored as not-known: uncounted, so unaccounted.
    const notKnown = merge(
      amount("job_income_amount", 100),
      frequency("job_income_frequency", "weekly"),
      { benefits_income_amount: { status: "unknown" as const, value: null } },
      sources("job", "benefits"),
    );
    expect(matchIncome580(notKnown).proposal).toBeNull();
    // With the benefits amount actually counted, the same session's
    // 'no' becomes certain (the total is genuinely under).
    const counted = merge(
      amount("job_income_amount", 100),
      frequency("job_income_frequency", "weekly"),
      amount("benefits_income_amount", 0),
      frequency("benefits_income_frequency", "monthly"),
      sources("job", "benefits"),
    );
    expect(matchIncome580(counted).proposal).toBe("no");
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

  it("asks directly when weekly pay straddles the threshold (HACK-126)", () => {
    // $134/week is $536 in a four-payday month and about $580.67 on
    // average, so neither a yes nor a no is certain. The total shown is
    // the average month, which is over the threshold.
    const match = matchIncome580(
      merge(
        amount("benefits_income_amount", 134),
        frequency("benefits_income_frequency", "weekly"),
      ),
    );
    expect(match.proposal).toBeNull();
    expect(match.countedSourceIds).toEqual(["benefits_income_amount"]);
    expect(match.monthlyTotal).toBeCloseTo((134 * 52) / 12);
    expect(match.monthlyTotal).toBeGreaterThan(INCOME_580_MONTHLY_THRESHOLD);
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
          // it, and every source the person named is counted (the stored
          // answer accounts for every source of money).
          expect(match.monthlyTotal).toBeLessThan(INCOME_580_MONTHLY_THRESHOLD);
          expect(match.uncountedSourceIds).toEqual([]);
          const named = answers.income_sources;
          expect(named?.status).toBe("known");
          const values = Array.isArray(named?.value) ? named.value : [named?.value];
          for (const item of values) {
            expect(["job", "benefits", "other", "none"]).toContain(item);
            if (item === "job") {
              expect(match.countedSourceIds).toContain("job_income_amount");
            } else if (item === "benefits") {
              expect(match.countedSourceIds).toContain("benefits_income_amount");
            } else if (item === "other") {
              expect(match.countedSourceIds).toContain("other_income_amount");
            }
          }
        } else {
          // Asked directly: the counted sources' certain minimum month stays
          // under the threshold, or the match would have said yes. The
          // average-month total it shows can still reach the threshold when
          // weekly or biweekly pay straddles it (HACK-126).
          expect(countedFloorTotal(answers, match.countedSourceIds)).toBeLessThan(
            INCOME_580_MONTHLY_THRESHOLD,
          );
          if (match.monthlyTotal === null) {
            expect(match.countedSourceIds).toEqual([]);
          }
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

/** The fewest paydays any month holds per frequency (the rule's floor). */
const FLOOR_FACTOR: Readonly<Record<string, number>> = {
  weekly: 4,
  biweekly: 2,
  twice_monthly: 2,
  monthly: 1,
};

const FREQUENCY_ID: Readonly<Record<string, string | null>> = {
  job_income_amount: "job_income_frequency",
  benefits_income_amount: "benefits_income_frequency",
  other_income_amount: null,
};

/** The certain minimum month of the sources the match counted. */
function countedFloorTotal(answers: AnswerMap, counted: readonly string[]): number {
  let total = 0;
  for (const id of counted) {
    const frequencyId = FREQUENCY_ID[id];
    const factor = frequencyId ? FLOOR_FACTOR[String(answers[frequencyId]?.value)] : 1;
    total += Number(answers[id]?.value) * factor!;
  }
  return total;
}

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

describe("the seasonal-work capture (HACK-130, rule 6)", () => {
  const seasonalYes = () =>
    frequency("job_income_seasonal", "yes") as AnswerMap;

  it("counts a seasonal job from its 6-month total, averaged exactly", () => {
    const match = matchIncome580(
      merge(
        sources("job"),
        seasonalYes(),
        amount(SEASONAL_TOTAL_QUESTION_ID, 3600),
      ),
    );
    expect(match.proposal).toBe("yes");
    expect(match.monthlyTotal).toBe(600);
    expect(match.countedSourceIds).toEqual([SEASONAL_TOTAL_QUESTION_ID]);
    expect(match.uncountedSourceIds).toEqual([]);
  });

  it("proposes 'no' when the 6-month average is certainly under $580", () => {
    const match = matchIncome580(
      merge(
        sources("job"),
        seasonalYes(),
        amount(SEASONAL_TOTAL_QUESTION_ID, 3000),
      ),
    );
    expect(match.proposal).toBe("no");
    expect(match.monthlyTotal).toBe(500);
  });

  it("never double-counts the in-season paycheck alongside the total", () => {
    const match = matchIncome580(
      merge(
        sources("job"),
        seasonalYes(),
        amount(SEASONAL_TOTAL_QUESTION_ID, 3600),
        amount("job_income_amount", 800),
        frequency("job_income_frequency", "weekly"),
      ),
    );
    // 3600 / 6 = 600 exactly; the $800 weekly paycheck adds nothing.
    expect(match.monthlyTotal).toBe(600);
    expect(match.proposal).toBe("yes");
  });

  it("asks directly when seasonal work has no captured total", () => {
    const match = matchIncome580(
      merge(
        sources("job"),
        seasonalYes(),
        amount("job_income_amount", 800),
        frequency("job_income_frequency", "weekly"),
      ),
    );
    expect(match.proposal).toBeNull();
    expect(match.uncountedSourceIds).toEqual(["job_income_amount"]);
  });

  it("keeps mixed year-round + seasonal work on the old path", () => {
    // The seasonal question asks whether ALL job work is seasonal, so a
    // mixed household answers "no": its job income stays on rules 1-5
    // (here "varies", so the screen is asked directly rather than the
    // seasonal total silently replacing the year-round income).
    const match = matchIncome580(
      merge(
        sources("job"),
        frequency("job_income_seasonal", "no"),
        amount(SEASONAL_TOTAL_QUESTION_ID, 3600),
        amount("job_income_amount", 900),
        frequency("job_income_frequency", "varies"),
      ),
    );
    expect(match.proposal).toBeNull();
    expect(match.countedSourceIds).toEqual([]);
    expect(match.uncountedSourceIds).toEqual(["job_income_amount"]);
  });

  it("still applies rule 4 around a counted seasonal source", () => {
    // Seasonal counting settles the job source, but an unread source
    // (self-employment) still withholds a confident "no".
    const under = matchIncome580(
      merge(
        sources("job", "self_employed"),
        seasonalYes(),
        amount(SEASONAL_TOTAL_QUESTION_ID, 3000),
      ),
    );
    expect(under.proposal).toBeNull();
    const over = matchIncome580(
      merge(
        sources("job", "self_employed"),
        seasonalYes(),
        amount(SEASONAL_TOTAL_QUESTION_ID, 3600),
      ),
    );
    expect(over.proposal).toBe("yes");
    expect(over.monthlyTotal).toBe(600);
  });

  it("leaves non-seasonal answers on the old path (a stale total is ignored)", () => {
    const match = matchIncome580(
      merge(
        sources("job"),
        frequency("job_income_seasonal", "no"),
        amount(SEASONAL_TOTAL_QUESTION_ID, 99999),
        amount("job_income_amount", 100),
        frequency("job_income_frequency", "weekly"),
      ),
    );
    expect(match.countedSourceIds).toEqual(["job_income_amount"]);
    expect(match.monthlyTotal).toBeCloseTo((100 * 52) / 12, 10);
    expect(match.proposal).toBe("no");
  });

  it("property: the seasonal contribution is always exactly total / 6", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 120000 }),
        fc.integer({ min: 0, max: 5000 }),
        (total, paycheck) => {
          const match = matchIncome580(
            merge(
              sources("job"),
              seasonalYes(),
              amount(SEASONAL_TOTAL_QUESTION_ID, total),
              amount("job_income_amount", paycheck),
              frequency("job_income_frequency", "weekly"),
            ),
          );
          expect(match.monthlyTotal).toBe(total / 6);
          expect(match.proposal).toBe(total / 6 >= 580 ? "yes" : "no");
        },
      ),
    );
  });
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
