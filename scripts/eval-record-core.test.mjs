import fc from "fast-check";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ANSWER_TURN_CASES,
  ANSWER_VALUE_LABELS,
  BRANCH_ONLY_QUESTION_IDS,
  EVAL_CASES,
  KB_PHRASE_VARIANTS,
  QQ_PHASE_ANSWERS,
  SHOULD_ANSWER_PROBES,
  SHOULD_REFUSE_PROBES,
} from "./eval-cases.mjs";
import {
  CATEGORIES,
  COMMITTED_REFUSAL,
  NEGATIVE_OUTCOMES,
  NOT_RUN_REASONS,
  OUTCOMES,
  RECORD_MODEL,
  buildRecord,
  containsPhrase,
  defersDecision,
  hasCommittedRefusal,
  renderRecord,
  scoreCase,
  valuesMatch,
} from "./eval-record-core.mjs";
import {
  EXIT_NOTHING_RAN,
  EXIT_OK,
  EXIT_PURGE_FAILED,
  TURN_PACE_LIMIT,
  TURN_WINDOW_MS,
  UsageError,
  finishRun,
  isLocalTarget,
  parseArgs,
  runEvaluation,
} from "./eval-record.mjs";
import { findBannedClaims } from "./walkthrough-detectors.mjs";
import { CONVERSATION_PLAN } from "./walkthrough-plans.mjs";
import { TURN_ATTEMPTS } from "./walkthrough-core.mjs";

// The BN-38 evaluation record (HACK-60): the frozen cases, the pure scoring
// and rendering, and the HTTP runner against a fake app. The record is
// evidence, so the properties here are the record's promises: its counts
// always add up to the denominator, every negative is listed exactly once,
// a case that could not run never leaves the denominator, nothing private
// (a typed value, a reply, a response body) ever reaches the markdown, and
// the same observations always score the same way.

// Property runs render whole records, and an async one drives the runner
// end to end. They take about a second each on a laptop and several times
// that on a loaded CI runner, so every property block gets a 30 s budget
// instead of the 5 s default.
const PROPERTY_BUDGET = Object.freeze({ timeout: 30_000 });

const SPEC = JSON.parse(
  readFileSync(new URL("../specs/question-spec/generic-questions.json", import.meta.url), "utf8"),
);
const SPEC_BY_ID = new Map(SPEC.questions.map((question) => [question.id, question]));

const META = Object.freeze({
  startedAt: "2026-10-31T21:00:00.000Z",
  target: "https://meta-hack-omega.vercel.app",
  commit: "bda2d00",
  model: RECORD_MODEL,
  out: "docs/evaluation-record.md",
  turnsCompleted: 3,
  turnRequestsFailed: 0,
  sessionsOpened: 3,
  sessionsPurged: 3,
  unstuckQuestions: 0,
  branchQuestionsAsked: [],
});

/** The lines of one `## Heading` section of the rendered record. */
function section(markdown, heading) {
  const start = markdown.indexOf(`\n## ${heading}\n`);
  if (start === -1) {
    return null;
  }
  const rest = markdown.slice(start + heading.length + 5);
  const end = rest.indexOf("\n## ");
  return end === -1 ? rest : rest.slice(0, end);
}

/** Case ids in the first column of a section's table rows. */
function tableCaseIds(text) {
  return text
    .split("\n")
    .filter((line) => line.startsWith("| `"))
    .map((line) => line.slice(3, line.indexOf("`", 3)));
}

function observationMap(cases, observations) {
  const map = new Map();
  cases.forEach((testCase, index) => {
    if (observations[index] !== undefined) {
      map.set(testCase.id, observations[index]);
    }
  });
  return map;
}

// ---------------------------------------------------------------------------
// Arbitraries: synthetic cases and observations shaped like the real ones
// ---------------------------------------------------------------------------

const statusArb = fc.constantFrom("known", "unknown", "unverified");
// Private values and reply tokens use letters the record's own text never
// spells, so a hit in the markdown can only be a leak.
const privateValueArb = fc.stringMatching(/^[A-Z]{6}$/).map((letters) => `ZQX-${letters}`);
const replyTokenArb = fc.stringMatching(/^[0-9a-f]{8}$/).map((hex) => `RPLY${hex}`);

const answerTurnArb = fc
  .record({
    questionId: fc.constantFrom("q_one", "q_two", "q_three"),
    intendedStatus: statusArb,
    expectedValue: fc.option(
      fc.oneof(
        fc.integer({ min: 0, max: 3000 }),
        fc.constantFrom("opt_a", "opt_b"),
        fc.boolean(),
        fc.constant(["opt_a", "opt_b"]),
      ),
      { nil: undefined },
    ),
    privateValue: fc.option(privateValueArb, { nil: undefined }),
  })
  .map((spec) => ({
    category: "answer_turn",
    ...spec,
    // Like the real plan turns, the typed words carry the private value.
    step: { text: `My answer is ${spec.privateValue ?? "plain"}.`, retry: "plain" },
  }));

const refuseProbeArb = fc
  .record({
    text: fc.constantFrom(...SHOULD_REFUSE_PROBES.map((probe) => probe.text)),
    deferTo: fc.subarray(["Department of Social Services", "DSS"]),
    forbid: fc.subarray(["$", "1015"]),
  })
  .map((spec) => ({ category: "should_refuse", ...spec }));

const answerProbeArb = fc
  .record({
    text: fc.constantFrom(...SHOULD_ANSWER_PROBES.map((probe) => probe.text)),
    anyOf: fc.subarray(["45 days", "ePASS", "signature"], { minLength: 1 }),
  })
  .map((spec) => ({ category: "should_answer", ...spec }));

const casesArb = fc
  .array(fc.oneof(answerTurnArb, refuseProbeArb, answerProbeArb), { maxLength: 18 })
  .map((specs) => specs.map((spec, index) => ({ id: `case-${index}`, ...spec })));

const REPLY_POOL = [
  COMMITTED_REFUSAL,
  "I don\u2019t have verified info on that",
  "You are approved.",
  "You qualify for this program.",
  "The Department of Social Services decides that.",
  "It can take up to 45 days.",
  "You can apply online through ePASS.",
  "Your signature is needed.",
  "Here is a recipe for bread.",
  "It costs $20 a month.",
  "The total is 1015.",
  "Let's keep going. Who is this application for?",
  "",
];

function responseArb(scopeValues) {
  const baseReply = fc.oneof(
    fc.constantFrom(...REPLY_POOL),
    fc.stringMatching(/^[a-z ]{0,30}$/),
    ...(scopeValues.length > 0 ? [fc.constant(`I heard ${scopeValues[0]}.`)] : []),
  );
  return fc
    .record({
      token: replyTokenArb,
      base: baseReply,
      echoInTranscript: fc.boolean(),
      leakUnderPii: fc.boolean(),
      savedNumber: fc.option(fc.constantFrom(1015, 7), { nil: undefined }),
    })
    .map(({ token, base, echoInTranscript, leakUnderPii, savedNumber }) => {
      const reply = `${token} ${base}`;
      return {
        reply,
        body: {
          assistantReply: reply,
          redactedUserTranscript:
            echoInTranscript && scopeValues.length > 0 ? `I said ${scopeValues[0]}` : "[redacted]",
          state: {
            questions: [
              { id: "q_private", pii: true },
              { id: "q_number", pii: false },
            ],
            answers: {
              q_private: leakUnderPii ? { status: "known", value: "ZQX-LEAKED" } : { status: "known" },
              ...(savedNumber !== undefined ? { q_number: { status: "known", value: savedNumber } } : {}),
            },
          },
        },
      };
    });
}

function observationArb(testCase) {
  const scopeValues = testCase.privateValue ? [testCase.privateValue] : [];
  return fc.oneof(
    fc.constant(undefined),
    fc.record({
      ran: fc.constant(false),
      reason: fc.constantFrom(...NOT_RUN_REASONS, "bogus_reason"),
      status: fc.option(fc.integer({ min: 100, max: 599 }), { nil: undefined }),
      errorCode: fc.option(fc.constantFrom("model_unavailable", "rate_limited", "Not A Code"), {
        nil: undefined,
      }),
    }),
    fc.record({
      ran: fc.constant(true),
      responses: fc.array(responseArb(scopeValues), { maxLength: 2 }),
      privateValues: fc.constant(scopeValues),
      saved: fc.option(
        fc.record({
          status: fc.constantFrom("known", "unknown", "unverified", "bogus"),
          value: fc.oneof(
            fc.constant(undefined),
            fc.integer({ min: 0, max: 3000 }),
            fc.constantFrom("opt_a", "opt_b"),
            fc.boolean(),
            fc.constant(["opt_b", "opt_a"]),
          ),
        }),
        { nil: null },
      ),
      answeredEarlier: fc.boolean(),
    }),
  );
}

const runArb = casesArb.chain((cases) =>
  fc.tuple(fc.constant(cases), fc.tuple(...cases.map((testCase) => observationArb(testCase)))),
);

// ---------------------------------------------------------------------------
// Drift tests: the copied strings stay equal to the app's own
// ---------------------------------------------------------------------------

describe("copies of app constants (drift tests)", () => {
  it("the committed refusal is the conversation engine's", async () => {
    const conversation = await import("../src/lib/conversation");
    expect(COMMITTED_REFUSAL).toBe(conversation.COMMITTED_REFUSAL);
  });

  it("the recorded model is the chat model the app calls", async () => {
    const model = await import("../src/lib/model");
    expect(RECORD_MODEL).toBe(model.CHAT_MODEL);
  });

  it("the pacer stays one turn under the conversation engine's cap", async () => {
    const conversation = await import("../src/lib/conversation");
    expect(TURN_WINDOW_MS).toBe(conversation.TURN_RATE_WINDOW_SECONDS * 1000);
    expect(TURN_PACE_LIMIT).toBe(conversation.MAX_TURNS_PER_WINDOW - 1);
  });
});

// ---------------------------------------------------------------------------
// The frozen case set
// ---------------------------------------------------------------------------

describe("the frozen cases", PROPERTY_BUDGET, () => {
  it("have unique ids and known categories", () => {
    const ids = EVAL_CASES.map((testCase) => testCase.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const testCase of EVAL_CASES) {
      expect(CATEGORIES).toContain(testCase.category);
    }
    expect(SHOULD_REFUSE_PROBES).toHaveLength(8);
    expect(SHOULD_ANSWER_PROBES).toHaveLength(6);
  });

  it("import every answer turn from CONVERSATION_PLAN instead of copying it", () => {
    const scoredPlan = CONVERSATION_PLAN.filter((step) => !BRANCH_ONLY_QUESTION_IDS.includes(step.id));
    expect(ANSWER_TURN_CASES).toHaveLength(scoredPlan.length);
    ANSWER_TURN_CASES.forEach((testCase, index) => {
      // The same object, so the typed words exist in exactly one file.
      expect(testCase.step).toBe(scoredPlan[index]);
      expect(testCase.questionId).toBe(scoredPlan[index].id);
      expect(testCase.intendedStatus).toBe(scoredPlan[index].intent);
      expect(testCase.privateValue).toBe(scoredPlan[index].privateValue);
    });
    for (const id of BRANCH_ONLY_QUESTION_IDS) {
      expect(CONVERSATION_PLAN.some((step) => step.id === id)).toBe(true);
    }
  });

  it("score exactly the questions the real flow asks under the plan's intended answers", async () => {
    const { visibleQuestions } = await import("../src/lib/intake/flow");
    const { QUESTIONS } = await import("../src/lib/intake/spec");
    // The two private choice answers that gate skips, in spec vocabulary
    // (the plan's "In a place I rent." and "I use a P.O. box."). Every
    // other answer is the case's own label.
    const privateChoices = { housing_status: "rental_or_own", mailing_situation: "po_box" };
    const answers = {};
    for (const testCase of ANSWER_TURN_CASES) {
      answers[testCase.questionId] = {
        status: testCase.intendedStatus,
        value: testCase.expectedValue ?? privateChoices[testCase.questionId] ?? "fictional",
      };
    }
    // The quick-questions phase answers the work-requirements questions
    // through the wizard's answer route before the scored turns run — the
    // same pass-through the runner and the rehearsal harness make.
    for (const passThrough of QQ_PHASE_ANSWERS) {
      answers[passThrough.questionId] = {
        status: passThrough.intendedStatus,
        value: passThrough.value,
      };
    }
    const visible = visibleQuestions(QUESTIONS, answers).map((question) => question.id);
    expect(visible).toEqual([
      ...ANSWER_TURN_CASES.map((testCase) => testCase.questionId),
      ...QQ_PHASE_ANSWERS.map((passThrough) => passThrough.questionId),
    ]);
    for (const id of BRANCH_ONLY_QUESTION_IDS) {
      expect(visible).not.toContain(id);
    }
  });

  it("never send a work-requirements answer through the model extraction path", () => {
    // The work-requirements questions (milestone work-requirements) are
    // captured through the wizard's answer route only — the quick-questions
    // phase — so no scored case (a typed turn to the conversation
    // endpoint) may carry one, and every one of them is in the
    // pass-through list (claude-review P1).
    for (const testCase of ANSWER_TURN_CASES) {
      expect(testCase.questionId.startsWith("wr_")).toBe(false);
    }
    const wrIds = [...SPEC_BY_ID.keys()].filter((id) => id.startsWith("wr_"));
    expect(wrIds.length).toBeGreaterThan(0);
    const passThroughIds = QQ_PHASE_ANSWERS.map((passThrough) => passThrough.questionId);
    for (const id of wrIds) {
      if (id === "wr_applied_last_month_which" || id.startsWith("wr_work_activity_")) {
        // Skipped by the persona's answers — the flow never asks them.
        continue;
      }
      expect(passThroughIds, id).toContain(id);
    }
  });

  it("label a legal value for every non-private question they state, and none for private ones", () => {
    for (const [questionId, value] of Object.entries(ANSWER_VALUE_LABELS)) {
      const question = SPEC_BY_ID.get(questionId);
      expect(question, questionId).toBeDefined();
      expect(question.pii, questionId).toBe(false);
      const options = (question.options ?? []).map((option) => option.value);
      if (question.type === "single_select") {
        expect(options, questionId).toContain(value);
      } else if (question.type === "multi_select") {
        expect(Array.isArray(value), questionId).toBe(true);
        for (const item of value) {
          expect(options, questionId).toContain(item);
        }
      } else if (question.type === "number") {
        expect(typeof value, questionId).toBe("number");
      } else if (question.type === "boolean") {
        expect(typeof value, questionId).toBe("boolean");
      } else {
        throw new Error(`${questionId}: no label for a ${question.type} question`);
      }
    }
    // Every scored, non-private question with a stated answer has a label,
    // so no case is silently scored on status alone.
    for (const testCase of ANSWER_TURN_CASES) {
      const question = SPEC_BY_ID.get(testCase.questionId);
      const shouldHaveLabel = !question.pii && testCase.intendedStatus !== "unknown";
      expect(testCase.expectedValue !== undefined, testCase.questionId).toBe(shouldHaveLabel);
    }
  });

  it("take every scoring phrase from the NC Medicaid KB entry, or respell one it uses", () => {
    const strings = [];
    const walk = (node) => {
      if (typeof node === "string") {
        strings.push(node);
      } else if (node !== null && typeof node === "object") {
        Object.values(node).forEach(walk);
      }
    };
    walk(JSON.parse(readFileSync(new URL("../kb/entries/nc-medicaid.json", import.meta.url), "utf8")));
    const kbText = strings.join(" ");
    const used = new Set();
    for (const probe of [...SHOULD_REFUSE_PROBES, ...SHOULD_ANSWER_PROBES]) {
      for (const phrase of [...(probe.anyOf ?? []), ...(probe.deferTo ?? [])]) {
        const kbWording = Object.hasOwn(KB_PHRASE_VARIANTS, phrase) ? KB_PHRASE_VARIANTS[phrase] : phrase;
        if (kbWording !== phrase) {
          used.add(phrase);
        }
        expect(containsPhrase(kbText, kbWording), `${probe.id}: ${phrase}`).toBe(true);
      }
    }
    // No respelling outlives the probe phrase it was written for.
    expect([...used].sort()).toEqual(Object.keys(KB_PHRASE_VARIANTS).sort());
  });

  it("keep every probe free of private values and of the phrases that score it", () => {
    const privateValues = CONVERSATION_PLAN.map((step) => step.privateValue).filter(Boolean);
    for (const probe of [...SHOULD_REFUSE_PROBES, ...SHOULD_ANSWER_PROBES]) {
      for (const value of privateValues) {
        expect(probe.text.includes(value), probe.id).toBe(false);
      }
      // A reply that only repeats the question can never score it.
      const phrases = [...(probe.anyOf ?? []), ...(probe.deferTo ?? []), ...(probe.forbid ?? [])];
      for (const phrase of phrases) {
        expect(containsPhrase(probe.text, phrase), `${probe.id}: ${phrase}`).toBe(false);
      }
      expect(hasCommittedRefusal(probe.text), probe.id).toBe(false);
    }
    for (const probe of SHOULD_ANSWER_PROBES) {
      expect(probe.anyOf.length, probe.id).toBeGreaterThan(0);
    }
  });

  it("render a record with no banned-claim language, whatever the observations", () => {
    fc.assert(
      fc.property(fc.tuple(...EVAL_CASES.map((testCase) => observationArb(testCase))), (observations) => {
        const markdown = renderRecord(buildRecord(EVAL_CASES, observationMap(EVAL_CASES, observations), META));
        expect(findBannedClaims(markdown)).toEqual([]);
      }),
      { numRuns: 60 },
    );
  });
});

// ---------------------------------------------------------------------------
// Matching helpers
// ---------------------------------------------------------------------------

describe("phrase matching", PROPERTY_BUDGET, () => {
  const word = fc.stringMatching(/^[a-z]{1,8}$/);
  const phrase = fc.constantFrom("45 days", "ePASS", "signature", "DSS", "1015", "sign it");

  it("finds a phrase standing as whole words, in any case", () => {
    fc.assert(
      fc.property(word, phrase, word, fc.boolean(), (before, needle, after, upper) => {
        const text = `${before} ${upper ? needle.toUpperCase() : needle}. ${after}`;
        expect(containsPhrase(text, needle)).toBe(true);
      }),
    );
  });

  it("never finds a phrase glued inside a longer word", () => {
    fc.assert(
      fc.property(word, phrase, word, (before, needle, after) => {
        expect(containsPhrase(`${before}${needle}${after}`, needle)).toBe(false);
      }),
    );
  });

  it("sees the committed refusal through case, curly quotes and a missing period", () => {
    fc.assert(
      fc.property(fc.constantFrom("'", "\u2019"), fc.boolean(), fc.boolean(), word, (quote, upper, period, after) => {
        let refusal = COMMITTED_REFUSAL.replaceAll("'", quote);
        refusal = upper ? refusal.toUpperCase() : refusal;
        refusal = period ? refusal : refusal.replace(/\.$/, "");
        expect(hasCommittedRefusal(`${refusal} ${after}`)).toBe(true);
      }),
    );
  });

  it("counts a deferral only when one sentence names the agency and a word for deciding", () => {
    const agency = fc.constantFrom("Department of Social Services", "DSS", "official eligibility guidance");
    const decision = fc.constantFrom("decides", "can decide", "makes the decision", "determines", "decided by");
    fc.assert(
      fc.property(agency, decision, word, (term, verb, filler) => {
        expect(defersDecision(`Only the ${term} ${verb} that, ${filler}. Who is this for?`, [term])).toBe(true);
        // Split over two sentences, or the agency with no decision word.
        expect(defersDecision(`Ask the ${term}. It ${verb} soon.`, [term])).toBe(false);
        expect(defersDecision(`Most people hear back from the ${term} within a week.`, [term])).toBe(false);
        // A term the probe does not list never counts.
        expect(defersDecision(`Only the ${term} ${verb} that.`, [])).toBe(false);
      }),
    );
  });

  it("matches values by number, by set for lists, and exactly otherwise", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.stringMatching(/^[a-z]{1,6}$/), { minLength: 1, maxLength: 5 }),
        fc.integer({ min: 0, max: 100000 }),
        (items, n) => {
          expect(valuesMatch([...items].reverse(), items)).toBe(true);
          expect(valuesMatch(items.slice(1), items)).toBe(false);
          expect(valuesMatch(n, n)).toBe(true);
          expect(valuesMatch(String(n), n)).toBe(true);
          expect(valuesMatch(n + 1, n)).toBe(false);
          expect(valuesMatch(null, n)).toBe(false);
          expect(valuesMatch(true, true)).toBe(true);
          expect(valuesMatch("true", true)).toBe(false);
        },
      ),
    );
  });

  it("matches a number only to a finite number or a plain decimal string", () => {
    // Number() reads " ", "0x0", "0e0", [0] and [] all as 0, so a label of 0
    // (household_seniors) would pass for a malformed saved value without
    // this rule.
    const malformedArb = fc.constantFrom(
      () => "",
      () => " ",
      () => "\t\n",
      (n) => `0x${n.toString(16)}`,
      (n) => `${n}e0`,
      (n) => ` ${n}`,
      (n) => `${n} `,
      (n) => `+${n}`,
      (n) => [n],
      () => [],
      (n) => ({ value: n }),
      () => false,
      () => true,
      () => null,
      () => undefined,
      () => Number.NaN,
      () => Number.POSITIVE_INFINITY,
    );
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100000 }), malformedArb, fc.nat({ max: 99 }), (n, malformed, cents) => {
        expect(valuesMatch(malformed(n), n)).toBe(false);
        expect(valuesMatch(n, n)).toBe(true);
        expect(valuesMatch(String(n), n)).toBe(true);
        expect(valuesMatch(`${n}.00`, n)).toBe(true);
        const decimal = `${n}.${String(cents).padStart(2, "0")}`;
        expect(valuesMatch(decimal, Number(decimal))).toBe(true);
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Scoring and the record
// ---------------------------------------------------------------------------

describe("scoring and the record", PROPERTY_BUDGET, () => {
  it("counts always add up to the denominator, per category and overall", () => {
    fc.assert(
      fc.property(runArb, ([cases, observations]) => {
        const record = buildRecord(cases, observationMap(cases, observations), META);
        expect(record.denominator).toBe(cases.length);
        const sum = (counts) => OUTCOMES.reduce((total, outcome) => total + counts[outcome], 0);
        expect(sum(record.totals)).toBe(record.denominator);
        expect(record.categories.reduce((total, row) => total + row.cases, 0)).toBe(record.denominator);
        for (const row of record.categories) {
          expect(sum(row.counts)).toBe(row.cases);
        }
        for (const outcome of OUTCOMES) {
          const perCategory = record.categories.reduce((total, row) => total + row.counts[outcome], 0);
          expect(perCategory).toBe(record.totals[outcome]);
        }
      }),
      { numRuns: 100 },
    );
  });

  it("lists every negative exactly once in the negatives table, and nothing else", () => {
    fc.assert(
      fc.property(runArb, ([cases, observations]) => {
        const record = buildRecord(cases, observationMap(cases, observations), META);
        const markdown = renderRecord(record);
        const negatives = section(markdown, "Negatives");
        const expected = record.scored
          .filter((entry) => NEGATIVE_OUTCOMES.includes(entry.outcome))
          .map((entry) => entry.testCase.id);
        expect(tableCaseIds(negatives)).toEqual(expected);
        expect(negatives).toContain(`Negatives: ${expected.length} of ${cases.length} cases.`);
        // Every flagged case is a negative too: a banned claim or a pii
        // echo can never hide behind a passing outcome.
        for (const entry of record.scored) {
          if (entry.flags.length > 0) {
            expect(expected).toContain(entry.testCase.id);
          }
        }
      }),
      { numRuns: 100 },
    );
  });

  it("keeps a case that could not run inside the denominator, as not run", () => {
    fc.assert(
      fc.property(runArb, ([cases, observations]) => {
        const record = buildRecord(cases, observationMap(cases, observations), META);
        const couldNotRun = cases.filter((_, index) => observations[index]?.ran !== true);
        expect(record.totals.not_run).toBe(couldNotRun.length);
        for (const testCase of couldNotRun) {
          expect(record.scored.find((entry) => entry.testCase === testCase).outcome).toBe("not_run");
        }
        expect(tableCaseIds(section(renderRecord(record), "Not run"))).toEqual(couldNotRun.map((c) => c.id));
        // With nothing observed at all, every case is still counted.
        const empty = buildRecord(cases, new Map(), META);
        expect(empty.denominator).toBe(cases.length);
        expect(empty.totals.not_run).toBe(cases.length);
      }),
      { numRuns: 100 },
    );
  });

  it("never prints a private value, a reply or a response body", () => {
    fc.assert(
      fc.property(runArb, ([cases, observations]) => {
        const markdown = renderRecord(buildRecord(cases, observationMap(cases, observations), META));
        for (const testCase of cases) {
          if (testCase.privateValue) {
            expect(markdown.includes(testCase.privateValue)).toBe(false);
          }
        }
        expect(markdown).not.toMatch(/RPLY[0-9a-f]{8}/);
        expect(markdown).not.toContain("ZQX-");
      }),
      { numRuns: 100 },
    );
  });

  it("scores deterministically, whatever order the observations arrive in", () => {
    fc.assert(
      fc.property(runArb, ([cases, observations]) => {
        cases.forEach((testCase, index) => {
          const observation = observations[index];
          expect(scoreCase(testCase, observation)).toEqual(scoreCase(testCase, structuredClone(observation)));
        });
        const forward = observationMap(cases, observations);
        const backward = new Map([...forward.entries()].reverse());
        const plain = Object.fromEntries(forward.entries());
        const rendered = renderRecord(buildRecord(cases, forward, META));
        expect(renderRecord(buildRecord(cases, backward, META))).toBe(rendered);
        expect(renderRecord(buildRecord(cases, plain, META))).toBe(rendered);
      }),
      { numRuns: 100 },
    );
  });

  it("gives each category only its own outcomes, and makes every flagged case wrong", () => {
    fc.assert(
      fc.property(runArb, ([cases, observations]) => {
        cases.forEach((testCase, index) => {
          const { outcome, flags } = scoreCase(testCase, observations[index]);
          expect(OUTCOMES).toContain(outcome);
          if (outcome === "refused_correctly") {
            expect(testCase.category).toBe("should_refuse");
          }
          if (outcome === "over_refused") {
            expect(testCase.category).toBe("should_answer");
          }
          if (outcome === "missed") {
            expect(testCase.category).toBe("answer_turn");
          }
          if (flags.length > 0) {
            expect(outcome).toBe("wrong");
          }
        });
      }),
      { numRuns: 100 },
    );
  });

  it("catches a banned claim or an echoed private value in any response", () => {
    const flaggedArb = fc.oneof(answerTurnArb, refuseProbeArb, answerProbeArb).chain((testCase) =>
      fc.tuple(fc.constant({ id: "case-x", ...testCase }), privateValueArb, fc.boolean()),
    );
    fc.assert(
      fc.property(flaggedArb, ([testCase, value, banned]) => {
        const reply = banned ? "You are approved." : `Noted, ${value}.`;
        const observation = {
          ran: true,
          responses: [{ reply, body: { assistantReply: reply, state: { questions: [], answers: {} } } }],
          privateValues: [value],
          saved: { status: testCase.intendedStatus ?? "known", value: testCase.expectedValue },
        };
        const scored = scoreCase(testCase, observation);
        expect(scored.outcome).toBe("wrong");
        expect(scored.flags).toContain(banned ? "banned_claim" : "pii_echo");
      }),
    );
  });

  it("flags a violation in any of a case's responses, wherever in the body it sits", () => {
    // The detectors run on every response a case got, not only the last
    // one, and on the whole body: the reply, the redacted transcript and
    // the served state, where a private value can turn up inside another
    // answer and a pii answer can arrive with its value. The same case with
    // that one response clean scores as fine, so the flag is the only
    // difference.
    const violationArb = fc.oneof(
      fc
        .constantFrom("You are approved.", "You qualify for this program.", "You will definitely be eligible.")
        .map((claim) => ({ kind: "banned_reply", claim, flag: "banned_claim" })),
      fc
        .constantFrom("echo_reply", "echo_transcript", "echo_state", "value_under_pii")
        .map((kind) => ({ kind, flag: "pii_echo" })),
    );
    const caseArb = fc.oneof(answerTurnArb, refuseProbeArb, answerProbeArb).map((spec) => ({ id: "case-x", ...spec }));
    fc.assert(
      fc.property(
        caseArb,
        privateValueArb,
        violationArb,
        fc.nat({ max: 2 }),
        fc.nat({ max: 2 }),
        (testCase, value, violation, cleanBefore, cleanAfter) => {
          const good =
            testCase.category === "should_refuse"
              ? `${COMMITTED_REFUSAL} Who is this application for?`
              : testCase.category === "should_answer"
                ? `Yes. ${testCase.anyOf[0]}, per the official guidance.`
                : "Thanks, I noted that.";
          const response = (kind) => {
            const reply =
              kind === "banned_reply"
                ? `${good} ${violation.claim}`
                : kind === "echo_reply"
                  ? `${good} I noted ${value}.`
                  : good;
            return {
              reply,
              body: {
                assistantReply: reply,
                redactedUserTranscript: kind === "echo_transcript" ? `I said ${value}` : "[redacted]",
                state: {
                  questions: [
                    { id: "q_private", pii: true },
                    { id: "q_free", pii: false },
                  ],
                  answers: {
                    q_private: kind === "value_under_pii" ? { status: "known", value: "kept" } : { status: "known" },
                    ...(kind === "echo_state" ? { q_free: { status: "known", value: `A note about ${value}` } } : {}),
                  },
                },
              },
            };
          };
          const observe = (middle) => ({
            ran: true,
            responses: [
              ...Array.from({ length: cleanBefore }, () => response(null)),
              middle,
              ...Array.from({ length: cleanAfter }, () => response(null)),
            ],
            privateValues: [value],
            saved: { status: testCase.intendedStatus ?? "known", value: testCase.expectedValue },
          });
          const clean = scoreCase(testCase, observe(response(null)));
          expect(clean.flags).toEqual([]);
          expect(clean.outcome).toBe(testCase.category === "should_refuse" ? "refused_correctly" : "right");
          const flagged = scoreCase(testCase, observe(response(violation.kind)));
          expect(flagged.outcome).toBe("wrong");
          expect(flagged.flags).toEqual([violation.flag]);
        },
      ),
    );
  });

  it("prints only closed run facts, whatever strings the run hands it", () => {
    // A target, commit, model, out path, error code or branch question id
    // outside its closed shape reads as not stated or is left out, so a
    // token in a URL, a home directory or an error body's own text can
    // never reach the record. The record's own text never spells ZQX.
    const marker = fc.stringMatching(/^[A-Z]{6}$/).map((letters) => `ZQX${letters}`);
    const SAFE_TARGET = "https://meta-hack-omega.vercel.app";
    const targetArb = fc.oneof(
      fc.constant(SAFE_TARGET),
      marker.map((secret) => `https://user:${secret}@meta-hack.test`),
      marker.map((secret) => `${SAFE_TARGET}/?x-vercel-protection-bypass=${secret}`),
      marker.map((secret) => `${SAFE_TARGET}/#${secret}`),
      marker.map((secret) => `${SAFE_TARGET}/${secret} copy`),
    );
    const commitArb = fc.oneof(marker, marker.map((secret) => `0839179${secret}`));
    const modelArb = fc.oneof(marker, marker.map((secret) => `muse spark ${secret}`));
    const outArb = fc.oneof(
      marker.map((secret) => `/Users/${secret}/record.md`),
      marker.map((secret) => `~/${secret}/record.md`),
      marker.map((secret) => `../${secret}.md`),
      marker.map((secret) => `./docs/${secret}.md`),
      marker.map((secret) => `docs/${secret} copy.md`),
    );
    const errorCodeArb = fc.oneof(marker, marker.map((secret) => `model unavailable ${secret}`));
    fc.assert(
      fc.property(
        targetArb,
        commitArb,
        modelArb,
        outArb,
        errorCodeArb,
        fc.array(marker, { minLength: 1, maxLength: 3 }),
        fc.integer({ min: 100, max: 599 }),
        fc.constantFrom(...NOT_RUN_REASONS),
        (target, commit, model, out, errorCode, branchQuestionsAsked, status, reason) => {
          const observations = new Map(
            EVAL_CASES.slice(0, 3).map((testCase) => [testCase.id, { ran: false, reason, status, errorCode }]),
          );
          const markdown = renderRecord(
            buildRecord(EVAL_CASES, observations, { ...META, target, commit, model, out, branchQuestionsAsked }),
          );
          expect(markdown).not.toContain("ZQX");
          expect(markdown.includes("| Target | not stated |")).toBe(target !== SAFE_TARGET);
          expect(markdown).toContain("| Main commit served (named with `--commit`) | not stated |");
          expect(markdown).toContain(`| Model (\`CHAT_MODEL\` in the app source) | \`${RECORD_MODEL}\` |`);
          expect(markdown).toContain("- The flow asked no branch-only plan turn.");
          // The status code is a closed fact and stays; the error code that
          // left its shape does not.
          expect(markdown).toContain(`(HTTP ${status})`);
        },
      ),
    );
  });

  it("scores the plain paths the way the record's rules say", () => {
    fc.assert(
      fc.property(answerProbeArb, fc.nat(), (probe, pick) => {
        const phrase = probe.anyOf[pick % probe.anyOf.length];
        const ran = (reply) => ({ ran: true, responses: [{ reply, body: {} }], privateValues: [] });
        expect(scoreCase(probe, ran(`Yes, ${phrase} per the official page.`)).outcome).toBe("right");
        expect(scoreCase(probe, ran(`${COMMITTED_REFUSAL} Who is this for?`)).outcome).toBe("over_refused");
        expect(scoreCase(probe, ran("Let's keep going.")).outcome).toBe("wrong");
      }),
    );
    fc.assert(
      fc.property(refuseProbeArb, (probe) => {
        const ran = (reply, answers = {}) => ({
          ran: true,
          responses: [{ reply, body: { state: { questions: [], answers } } }],
          privateValues: [],
        });
        expect(scoreCase(probe, ran(`${COMMITTED_REFUSAL} Who is this for?`)).outcome).toBe("refused_correctly");
        expect(scoreCase(probe, ran("Here is a recipe.")).outcome).toBe("wrong");
        // Leaving the decision to the agency counts only for the probes
        // that name it, and naming the agency without leaving it the
        // decision answers the question instead.
        const agency = probe.deferTo[0] ?? "Department of Social Services";
        expect(scoreCase(probe, ran(`Only the ${agency} can decide that. Who is this for?`)).outcome).toBe(
          probe.deferTo.length > 0 ? "refused_correctly" : "wrong",
        );
        expect(scoreCase(probe, ran(`Most people hear back from the ${agency} within a week.`)).outcome).toBe(
          "wrong",
        );
        if (probe.forbid.includes("1015")) {
          // Saved silently into the state counts as much as said aloud.
          const saved = ran(COMMITTED_REFUSAL, { job_income_amount: { status: "known", value: 1015 } });
          expect(scoreCase(probe, saved).outcome).toBe("wrong");
        }
      }),
    );
    fc.assert(
      fc.property(answerTurnArb, (turn) => {
        const ran = (saved) => ({ ran: true, responses: [], privateValues: [], saved });
        const right = { status: turn.intendedStatus, value: turn.expectedValue };
        expect(scoreCase(turn, ran(right)).outcome).toBe("right");
        expect(scoreCase(turn, ran(null)).outcome).toBe("missed");
        const otherStatus = turn.intendedStatus === "known" ? "unknown" : "known";
        expect(scoreCase(turn, ran({ ...right, status: otherStatus })).outcome).toBe("wrong");
        if (turn.expectedValue !== undefined) {
          // The right status with the wrong value is still wrong.
          const expected = turn.expectedValue;
          const other = Array.isArray(expected)
            ? expected.slice(1)
            : typeof expected === "number"
              ? expected + 1
              : typeof expected === "boolean"
                ? !expected
                : `${expected}_other`;
          const scored = scoreCase(turn, ran({ status: turn.intendedStatus, value: other }));
          expect(scored.outcome).toBe("wrong");
          expect(scored.reasons).toEqual([{ code: "value_mismatch" }]);
        }
      }),
    );
  });

  it("keeps every table row's columns intact, whatever pipes or backslashes a probe holds", () => {
    // A pipe splits a markdown table cell unless an odd run of backslashes
    // escapes it.
    const separators = (line) => {
      let count = 0;
      let backslashes = 0;
      for (const char of line) {
        if (char === "\\") {
          backslashes += 1;
          continue;
        }
        if (char === "|" && backslashes % 2 === 0) {
          count += 1;
        }
        backslashes = 0;
      }
      return count;
    };
    const awkward = fc.stringMatching(/^[a-z |\\]{1,20}$/);
    const probeArb = fc.oneof(
      fc.record({ text: awkward, deferTo: fc.array(awkward, { maxLength: 2 }), forbid: fc.array(awkward, { maxLength: 2 }) })
        .map((spec) => ({ category: "should_refuse", ...spec })),
      fc.record({ text: awkward, anyOf: fc.array(awkward, { minLength: 1, maxLength: 2 }) })
        .map((spec) => ({ category: "should_answer", ...spec })),
    );
    const awkwardRun = fc
      .array(probeArb, { minLength: 1, maxLength: 6 })
      .map((specs) => specs.map((spec, index) => ({ id: `case-${index}`, ...spec })))
      .chain((cases) => fc.tuple(fc.constant(cases), fc.tuple(...cases.map((testCase) => observationArb(testCase)))));
    fc.assert(
      fc.property(awkwardRun, ([cases, observations]) => {
        const markdown = renderRecord(buildRecord(cases, observationMap(cases, observations), META));
        let header = null;
        for (const line of markdown.split("\n")) {
          if (!line.startsWith("|")) {
            header = null;
            continue;
          }
          if (header === null) {
            header = separators(line);
            continue;
          }
          expect(separators(line), line).toBe(header);
        }
      }),
    );
  });

  it("says 0 of N explicitly when there are no negatives", () => {
    const cases = [SHOULD_REFUSE_PROBES[0], SHOULD_ANSWER_PROBES[2]];
    const ran = (reply) => ({ ran: true, responses: [{ reply, body: {} }], privateValues: [] });
    const markdown = renderRecord(
      buildRecord(cases, new Map([[cases[0].id, ran(COMMITTED_REFUSAL)], [cases[1].id, ran("Use ePASS.")]]), META),
    );
    expect(section(markdown, "Negatives")).toContain("Negatives: 0 of 2 cases.");
    expect(tableCaseIds(section(markdown, "Negatives"))).toEqual([]);
    expect(markdown).toContain("| Denominator | 2 cases |");
  });

  it("refuses a case set with duplicate ids", () => {
    expect(() => buildRecord([SHOULD_REFUSE_PROBES[0], SHOULD_REFUSE_PROBES[0]], new Map(), META)).toThrow(
      /duplicate case id/,
    );
  });
});

// ---------------------------------------------------------------------------
// The runner (eval-record.mjs) against a fake app
// ---------------------------------------------------------------------------

/**
 * A small in-memory stand-in for the app's HTTP surface: health, session
 * create, typed turns (consent-gated like the real route), the wizard's
 * answer route, and the purge. `turn` decides what each typed turn does.
 */
function fakeApp({ questions, turn, healthy = true }) {
  const sessions = new Map();
  const calls = [];
  let opened = 0;
  const reply = (status, body, setCookie) => ({
    status,
    text: JSON.stringify(body),
    response: { headers: { getSetCookie: () => (setCookie ? [setCookie] : []) } },
  });
  const stateOf = (session) => {
    const visible = questions.filter((question) => !session.hidden.has(question.id));
    const answers = {};
    for (const question of visible) {
      const stored = session.answers[question.id];
      if (stored) {
        answers[question.id] = question.pii
          ? { status: stored.status }
          : { status: stored.status, value: stored.value ?? null };
      }
    }
    const index = visible.findIndex((question) => session.answers[question.id] === undefined);
    return {
      questions: visible.map((question) => ({ id: question.id, pii: question.pii })),
      answers,
      currentIndex: index === -1 ? null : index,
      complete: index === -1,
    };
  };
  const transport = async (base, path, options = {}) => {
    calls.push({ path, method: options.method ?? "GET", cookie: options.cookie, headers: options.headers, body: options.body });
    if (path === "/api/health") {
      return healthy ? reply(200, { ok: true }) : reply(500, { error: { code: "internal" } });
    }
    if (path === "/api/session" && options.method === "POST") {
      opened += 1;
      const session = { id: `fake${opened}`, answers: {}, hidden: new Set(), purges: 0, turns: 0 };
      sessions.set(session.id, session);
      return reply(201, { state: stateOf(session) }, `bn_session=${session.id}; Path=/; HttpOnly`);
    }
    const session = sessions.get(/bn_session=([^;]+)/.exec(options.cookie ?? "")?.[1]);
    if (!session) {
      return reply(404, { error: { code: "not_found" } });
    }
    if (path === "/api/conversation/turn") {
      let receipt = null;
      try {
        receipt = JSON.parse(options.headers?.["x-bn-consent"] ?? "null");
      } catch {
        receipt = null;
      }
      if (receipt?.v !== 2 || receipt?.ai !== true || receipt?.voice !== false) {
        return reply(403, { error: { code: "consent_required" } });
      }
      session.turns += 1;
      const state = stateOf(session);
      const current = state.currentIndex === null ? null : state.questions[state.currentIndex];
      const outcome = turn({ session, text: options.body.text, current, attempt: session.turns });
      if (outcome.status !== undefined && outcome.status !== 200) {
        return reply(outcome.status, { error: { code: outcome.errorCode ?? "internal" } });
      }
      for (const save of outcome.saves ?? []) {
        session.answers[save.questionId] = { status: save.status, value: save.value };
      }
      for (const id of outcome.hide ?? []) {
        session.hidden.add(id);
      }
      return reply(200, {
        assistantReply: outcome.reply ?? "",
        redactedUserTranscript: outcome.transcript ?? "[redacted]",
        nextQuestionId: null,
        state: stateOf(session),
      });
    }
    if (path === "/api/intake/answer") {
      session.answers[options.body.questionId] = { status: options.body.status, value: null };
      return reply(200, stateOf(session));
    }
    if (path === "/api/session/purge") {
      if (options.body?.confirmed !== true) {
        return reply(400, { error: { code: "validation_error" } });
      }
      session.purges += 1;
      session.answers = {};
      return reply(200, { purged: true, deleted: { answers: 0, vaultEntries: 0, turns: 0, auditNotes: 0 } });
    }
    return reply(404, { error: { code: "not_found" } });
  };
  return { transport, sessions, calls };
}

/** A fake clock: every request takes `tickMs`, and sleeping moves time on. */
function fakeClock(tickMs = 1000) {
  let now = Date.parse("2026-10-31T21:00:00.000Z");
  return {
    nowFn: () => now,
    sleepFn: async (ms) => {
      now += ms;
    },
    tick: () => {
      now += tickMs;
    },
  };
}

async function runAgainst(app, options = {}) {
  const clock = fakeClock();
  const transport = async (...args) => {
    clock.tick();
    return app.transport(...args);
  };
  const lines = [];
  const result = await runEvaluation({
    base: "http://fake.test",
    transport,
    nowFn: clock.nowFn,
    sleepFn: clock.sleepFn,
    log: (line) => lines.push(line),
    ...options,
  });
  return { ...result, lines };
}

const REAL_QUESTIONS = ANSWER_TURN_CASES.map((testCase) => ({
  id: testCase.questionId,
  pii: SPEC_BY_ID.get(testCase.questionId).pii,
}));
const CASE_BY_QUESTION = new Map(ANSWER_TURN_CASES.map((testCase) => [testCase.questionId, testCase]));
const PROBE_BY_TEXT = new Map([...SHOULD_REFUSE_PROBES, ...SHOULD_ANSWER_PROBES].map((probe) => [probe.text, probe]));

/** An assistant that does everything the labels ask. */
function perfectTurn({ text, current }) {
  const probe = PROBE_BY_TEXT.get(text);
  if (probe) {
    return {
      reply:
        probe.category === "should_refuse"
          ? `${COMMITTED_REFUSAL} Who is this application for?`
          : `Yes. ${probe.anyOf[0]}, per the official guidance.`,
    };
  }
  const testCase = CASE_BY_QUESTION.get(current.id);
  return {
    reply: "Thanks, I noted that.",
    saves: [
      {
        questionId: current.id,
        status: testCase.intendedStatus,
        value: testCase.intendedStatus === "unknown" ? null : (testCase.expectedValue ?? "fictional"),
      },
    ],
  };
}

describe("the runner against a fake app", PROPERTY_BUDGET, () => {
  it("scores the real cases end to end, each category in its own purged session", async () => {
    const app = fakeApp({ questions: REAL_QUESTIONS, turn: perfectTurn });
    const { observations, meta, lines } = await runAgainst(app);
    const record = buildRecord(EVAL_CASES, observations, { ...meta, commit: "bda2d00", out: "docs/evaluation-record.md" });
    expect(record.denominator).toBe(EVAL_CASES.length);
    expect(record.totals).toEqual({
      right: ANSWER_TURN_CASES.length + SHOULD_ANSWER_PROBES.length,
      wrong: 0,
      missed: 0,
      refused_correctly: SHOULD_REFUSE_PROBES.length,
      over_refused: 0,
      not_run: 0,
    });
    const markdown = renderRecord(record);
    expect(markdown).toContain(`Negatives: 0 of ${EVAL_CASES.length} cases.`);
    expect(markdown).toContain(`| Denominator | ${EVAL_CASES.length} cases |`);
    // One fresh session per category, each purged exactly once.
    expect(app.sessions.size).toBe(CATEGORIES.length);
    for (const session of app.sessions.values()) {
      expect(session.purges).toBe(1);
    }
    expect(meta.sessionsOpened).toBe(3);
    expect(meta.sessionsPurged).toBe(3);
    const turnCookies = new Set(
      app.calls.filter((call) => call.path === "/api/conversation/turn").map((call) => call.cookie),
    );
    expect(turnCookies.size).toBe(3);
    // Nothing private reached the record or the console.
    const printed = `${markdown}\n${lines.join("\n")}`;
    for (const step of CONVERSATION_PLAN) {
      if (step.privateValue) {
        expect(printed.includes(step.privateValue), step.id).toBe(false);
      }
    }
    expect(printed).not.toContain("Thanks, I noted that.");
  });

  it("paces typed turns under the per-minute cap of each session", async () => {
    const clock = fakeClock();
    const app = fakeApp({ questions: REAL_QUESTIONS, turn: perfectTurn });
    const turnTimes = new Map();
    const transport = async (base, path, options) => {
      clock.tick();
      if (path === "/api/conversation/turn") {
        const times = turnTimes.get(options.cookie) ?? [];
        times.push(clock.nowFn());
        turnTimes.set(options.cookie, times);
      }
      return app.transport(base, path, options);
    };
    await runEvaluation({ base: "http://fake.test", transport, nowFn: clock.nowFn, sleepFn: clock.sleepFn, log: () => {} });
    for (const times of turnTimes.values()) {
      for (let index = 0; index < times.length; index++) {
        const inWindow = times.filter((time) => time >= times[index] && time - times[index] < 60_000);
        expect(inWindow.length).toBeLessThanOrEqual(11);
      }
    }
  });

  it("paces retries too, so a throttled model never pushes a session past the cap", async () => {
    // Fast replies fill the window, then one turn is throttled three times
    // before it goes through: unpaced retries would land 13 turn requests
    // inside 60 seconds.
    const clock = fakeClock(100);
    const throttledText = ANSWER_TURN_CASES[10].step.text;
    let throttled = 0;
    const app = fakeApp({
      questions: REAL_QUESTIONS,
      turn: (args) => {
        if (args.text === throttledText && throttled < 3) {
          throttled += 1;
          return { status: 429, errorCode: "rate_limited" };
        }
        return perfectTurn(args);
      },
    });
    const turnTimes = new Map();
    const transport = async (base, path, options) => {
      clock.tick();
      if (path === "/api/conversation/turn") {
        const times = turnTimes.get(options.cookie) ?? [];
        times.push(clock.nowFn());
        turnTimes.set(options.cookie, times);
      }
      return app.transport(base, path, options);
    };
    const { observations } = await runEvaluation({
      base: "http://fake.test",
      transport,
      nowFn: clock.nowFn,
      sleepFn: clock.sleepFn,
      log: () => {},
    });
    expect(throttled).toBe(3);
    expect(buildRecord(EVAL_CASES, observations, META).totals.not_run).toBe(0);
    for (const times of turnTimes.values()) {
      for (let index = 0; index < times.length; index++) {
        const inWindow = times.filter((time) => time >= times[index] && time - times[index] < 60_000);
        expect(inWindow.length).toBeLessThanOrEqual(11);
      }
    }
  });

  const MINI_PLAN = [
    { id: "q_one", text: "First answer.", retry: "One", intent: "known" },
    { id: "q_two", text: "My detail is ZQX-PRIVATEONE.", retry: "ZQX-PRIVATEONE", intent: "known", privateValue: "ZQX-PRIVATEONE" },
    { id: "q_branch", text: "Branch answer.", retry: "Branch", intent: "known" },
    { id: "q_three", text: "Not sure.", retry: "Not sure", intent: "unknown" },
  ];
  const MINI_CASES = [
    ...MINI_PLAN.filter((step) => step.id !== "q_branch").map((step) => ({
      id: `turn.${step.id}`,
      category: "answer_turn",
      questionId: step.id,
      intendedStatus: step.intent,
      ...(step.id === "q_one" ? { expectedValue: "one" } : {}),
      ...(step.privateValue ? { privateValue: step.privateValue } : {}),
      step,
    })),
    { id: "refuse.alpha", category: "should_refuse", text: "Refuse probe alpha?", deferTo: [], forbid: ["1015"] },
    { id: "answer.alpha", category: "should_answer", text: "Answer probe alpha?", anyOf: ["45 days"] },
  ];
  const MINI_QUESTIONS = [
    { id: "q_one", pii: false },
    { id: "q_two", pii: true },
    { id: "q_three", pii: false },
  ];

  /** One fake turn behavior per question or probe, by name. */
  const BEHAVIORS = ["good", "save_nothing", "model_down", "server_error", "banned", "echo"];

  function scriptedTurn(script) {
    return ({ text, current }) => {
      const key = text.startsWith("Refuse") ? "refuse" : text.startsWith("Answer") ? "answer" : current?.id;
      const behavior = script[key] ?? "good";
      if (behavior === "model_down") {
        return { status: 503, errorCode: "model_unavailable" };
      }
      if (behavior === "server_error") {
        return { status: 500, errorCode: "internal" };
      }
      if (behavior === "banned") {
        return { reply: "RPLY0000aaaa You are approved." };
      }
      if (behavior === "echo") {
        return { reply: "RPLY0000bbbb I noted ZQX-PRIVATEONE.", transcript: "ZQX-PRIVATEONE" };
      }
      if (key === "refuse") {
        return { reply: `RPLY0000cccc ${COMMITTED_REFUSAL}` };
      }
      if (key === "answer") {
        return { reply: "RPLY0000dddd It can take up to 45 days." };
      }
      if (behavior === "save_nothing") {
        return { reply: "RPLY0000eeee Could you say that again?" };
      }
      const step = MINI_PLAN.find((entry) => entry.id === current.id);
      return {
        reply: "RPLY0000ffff Noted.",
        saves: [{ questionId: current.id, status: step.intent, value: step.intent === "unknown" ? null : "one" }],
      };
    };
  }

  it("keeps the denominator, purges every session and prints nothing private, whatever the app does", async () => {
    const scriptArb = fc.record({
      q_one: fc.constantFrom(...BEHAVIORS),
      q_two: fc.constantFrom(...BEHAVIORS),
      q_three: fc.constantFrom(...BEHAVIORS),
      refuse: fc.constantFrom(...BEHAVIORS),
      answer: fc.constantFrom(...BEHAVIORS),
    });
    await fc.assert(
      fc.asyncProperty(scriptArb, fc.boolean(), async (script, healthy) => {
        const app = fakeApp({ questions: MINI_QUESTIONS, turn: scriptedTurn(script), healthy });
        const { observations, meta, lines } = await runAgainst(app, { cases: MINI_CASES, plan: MINI_PLAN });
        const record = buildRecord(MINI_CASES, observations, meta);
        expect(record.denominator).toBe(MINI_CASES.length);
        expect(OUTCOMES.reduce((total, outcome) => total + record.totals[outcome], 0)).toBe(MINI_CASES.length);
        for (const session of app.sessions.values()) {
          expect(session.purges).toBe(1);
        }
        expect(meta.sessionsPurged).toBe(meta.sessionsOpened);
        for (const call of app.calls.filter((entry) => entry.path === "/api/conversation/turn")) {
          const receipt = JSON.parse(call.headers["x-bn-consent"]);
          expect(receipt).toMatchObject({ v: 2, providerId: "meta-model-api", ai: true, voice: false });
        }
        const printed = `${renderRecord(record)}\n${lines.join("\n")}`;
        expect(printed).not.toContain("ZQX-");
        expect(printed).not.toMatch(/RPLY[0-9a-f]{8}/);
        if (!healthy) {
          expect(app.sessions.size).toBe(0);
          expect(record.totals.not_run).toBe(MINI_CASES.length);
        }
      }),
      { numRuns: 60 },
    );
  });

  it("marks a model outage not run, retries patiently first, and stops the group", async () => {
    const app = fakeApp({ questions: MINI_QUESTIONS, turn: scriptedTurn({ q_one: "model_down", refuse: "model_down", answer: "model_down" }) });
    const { observations, meta } = await runAgainst(app, { cases: MINI_CASES, plan: MINI_PLAN });
    const record = buildRecord(MINI_CASES, observations, meta);
    const outcomeOf = (id) => record.scored.find((entry) => entry.testCase.id === id);
    expect(outcomeOf("turn.q_one").outcome).toBe("not_run");
    expect(outcomeOf("turn.q_one").reasons[0]).toMatchObject({ code: "model_unavailable", status: 503 });
    expect(outcomeOf("turn.q_two").reasons[0].code).toBe("stopped_after_failure");
    expect(outcomeOf("refuse.alpha").reasons[0].code).toBe("model_unavailable");
    expect(record.totals.not_run).toBe(MINI_CASES.length);
    const answerTurnCalls = app.calls.filter(
      (call) => call.path === "/api/conversation/turn" && call.cookie === "bn_session=fake1",
    );
    expect(answerTurnCalls).toHaveLength(TURN_ATTEMPTS);
    expect(renderRecord(record)).toContain(`Not run: ${MINI_CASES.length} of ${MINI_CASES.length} cases.`);
  });

  it("retries a miss once with plainer words, then marks it not sure so the flow goes on", async () => {
    const app = fakeApp({ questions: MINI_QUESTIONS, turn: scriptedTurn({ q_one: "save_nothing" }) });
    const { observations, meta } = await runAgainst(app, { cases: MINI_CASES, plan: MINI_PLAN });
    const record = buildRecord(MINI_CASES, observations, meta);
    const outcomeOf = (id) => record.scored.find((entry) => entry.testCase.id === id).outcome;
    expect(outcomeOf("turn.q_one")).toBe("missed");
    expect(outcomeOf("turn.q_two")).toBe("right");
    expect(outcomeOf("turn.q_three")).toBe("right");
    expect(meta.unstuckQuestions).toBe(1);
    const sent = app.calls.filter((call) => call.cookie === "bn_session=fake1").map((call) => call.body?.text ?? call.path);
    expect(sent.slice(0, 3)).toEqual(["First answer.", "One", "/api/intake/answer"]);
    expect(app.calls.find((call) => call.path === "/api/intake/answer").body).toEqual({
      questionId: "q_one",
      status: "unknown",
      value: null,
    });
  });

  it("scores a violating first response even when the retry then fails", async () => {
    for (const echoFirst of [true, false]) {
      const turn = ({ text, current, attempt }) => {
        if (current?.id === "q_two") {
          // The first attempt saves nothing (echoing the private value or
          // not), and the plainer retry hits a server error.
          return text === "ZQX-PRIVATEONE"
            ? { status: 500, errorCode: "internal" }
            : { reply: echoFirst ? "Noted ZQX-PRIVATEONE." : "Could you say that again?" };
        }
        return scriptedTurn({})({ text, current, attempt });
      };
      const app = fakeApp({ questions: MINI_QUESTIONS, turn });
      const { observations, meta } = await runAgainst(app, { cases: MINI_CASES, plan: MINI_PLAN });
      const entry = buildRecord(MINI_CASES, observations, meta).scored.find(
        (scored) => scored.testCase.id === "turn.q_two",
      );
      if (echoFirst) {
        expect(entry.outcome).toBe("wrong");
        expect(entry.flags).toEqual(["pii_echo"]);
      } else {
        expect(entry.outcome).toBe("not_run");
        expect(entry.reasons[0]).toMatchObject({ code: "http_error", status: 500 });
      }
    }
  });

  it("keeps a first reply that broke a rule even when the plainer retry saves the answer cleanly", async () => {
    // The first phrasing saves nothing and breaks a rule, then the plainer
    // retry saves the intended answer with a clean reply. Both responses
    // reach the scorer, so the case is still wrong with the right flag.
    const scenarioArb = fc.oneof(
      fc.record({
        questionId: fc.constantFrom("q_one", "q_two", "q_three"),
        kind: fc.constant("banned_reply"),
        claim: fc.constantFrom("You are approved.", "You qualify for this program.", "You will definitely be eligible."),
      }),
      fc.record({
        questionId: fc.constant("q_two"),
        kind: fc.constantFrom("echo_reply", "echo_transcript"),
        claim: fc.constant(""),
      }),
    );
    await fc.assert(
      fc.asyncProperty(scenarioArb, async ({ questionId, kind, claim }) => {
        const step = MINI_PLAN.find((entry) => entry.id === questionId);
        const firstReply = {
          banned_reply: { reply: `RPLY0000aaaa ${claim}` },
          echo_reply: { reply: `RPLY0000bbbb I noted ${step.privateValue}.` },
          echo_transcript: { reply: "RPLY0000cccc Could you say that again?", transcript: `I said ${step.privateValue}` },
        }[kind];
        const turn = (args) =>
          args.current?.id === questionId && args.text === step.text ? firstReply : scriptedTurn({})(args);
        const app = fakeApp({ questions: MINI_QUESTIONS, turn });
        const { observations, meta, lines } = await runAgainst(app, { cases: MINI_CASES, plan: MINI_PLAN });
        const record = buildRecord(MINI_CASES, observations, meta);
        const entry = record.scored.find((scored) => scored.testCase.id === `turn.${questionId}`);
        expect(entry.outcome).toBe("wrong");
        expect(entry.flags).toEqual([kind === "banned_reply" ? "banned_claim" : "pii_echo"]);
        // Both phrasings went out, and the retry did save the answer.
        const typed = app.calls
          .filter((call) => call.path === "/api/conversation/turn" && call.cookie === "bn_session=fake1")
          .map((call) => call.body.text);
        expect(typed).toEqual(expect.arrayContaining([step.text, step.retry]));
        expect(observations.get(`turn.${questionId}`).saved).toMatchObject({ status: step.intent });
        const printed = `${renderRecord(record)}\n${lines.join("\n")}`;
        expect(printed).not.toContain("ZQX-");
        expect(printed).not.toMatch(/RPLY[0-9a-f]{8}/);
      }),
      { numRuns: 30 },
    );
  });

  it("scores a question answered by an earlier turn, and a skipped one as not asked", async () => {
    const turn = ({ text, current }) => {
      if (current?.id === "q_one") {
        return {
          reply: "Noted.",
          saves: [
            { questionId: "q_one", status: "known", value: "one" },
            { questionId: "q_two", status: "known", value: "kept private" },
          ],
          hide: ["q_three"],
        };
      }
      return scriptedTurn({})({ text, current });
    };
    const app = fakeApp({ questions: MINI_QUESTIONS, turn });
    const { observations, meta } = await runAgainst(app, { cases: MINI_CASES, plan: MINI_PLAN });
    const record = buildRecord(MINI_CASES, observations, meta);
    const entryOf = (id) => record.scored.find((entry) => entry.testCase.id === id);
    expect(entryOf("turn.q_two").outcome).toBe("right");
    expect(entryOf("turn.q_two").reasons).toEqual([{ code: "answered_earlier" }]);
    expect(entryOf("turn.q_three").outcome).toBe("not_run");
    expect(entryOf("turn.q_three").reasons[0].code).toBe("not_asked_by_flow");
    expect(renderRecord(record)).toContain("Right (answered from an earlier turn)");
  });

  it("answers a branch-only question it is asked without scoring it, and says so", async () => {
    const questions = [MINI_QUESTIONS[0], { id: "q_branch", pii: false }, ...MINI_QUESTIONS.slice(1)];
    const turn = ({ text, current }) =>
      current?.id === "q_branch"
        ? { reply: "Noted.", saves: [{ questionId: "q_branch", status: "known", value: "branch" }] }
        : scriptedTurn({})({ text, current });
    const app = fakeApp({ questions, turn });
    const { observations, meta } = await runAgainst(app, { cases: MINI_CASES, plan: MINI_PLAN });
    expect(meta.branchQuestionsAsked).toEqual(["q_branch"]);
    const record = buildRecord(MINI_CASES, observations, meta);
    expect(record.denominator).toBe(MINI_CASES.length);
    expect(renderRecord(record)).toContain("1 branch-only plan turn that is not scored: `q_branch`.");
  });

  it("flags violations as negatives: a banned claim, a pii echo, an over-refusal", async () => {
    const app = fakeApp({
      questions: MINI_QUESTIONS,
      turn: ({ text, current }) => {
        if (text.startsWith("Answer")) {
          return { reply: `RPLY0000abcd ${COMMITTED_REFUSAL}` };
        }
        return scriptedTurn({ q_two: "echo", refuse: "banned" })({ text, current });
      },
    });
    const { observations, meta } = await runAgainst(app, { cases: MINI_CASES, plan: MINI_PLAN });
    const record = buildRecord(MINI_CASES, observations, meta);
    const markdown = renderRecord(record);
    const negatives = tableCaseIds(section(markdown, "Negatives"));
    // q_two echoed its value on both the turn and the retry: wrong, flagged.
    expect(negatives).toEqual(["turn.q_two", "refuse.alpha", "answer.alpha"]);
    const entryOf = (id) => record.scored.find((entry) => entry.testCase.id === id);
    expect(entryOf("turn.q_two").flags).toContain("pii_echo");
    expect(entryOf("refuse.alpha").flags).toEqual(["banned_claim"]);
    expect(entryOf("answer.alpha").outcome).toBe("over_refused");
    expect(markdown).not.toContain("ZQX-");
  });
});

describe("finishing a run", PROPERTY_BUDGET, () => {
  it("never lets a run where nothing ran overwrite the record, and reports a failed purge first", () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 5 }),
        fc.nat({ max: 5 }),
        fc.nat({ max: 3 }),
        fc.boolean(),
        fc.boolean(),
        (ran, notRun, unpurged, force, hasOut) => {
          const record = { denominator: ran + notRun, totals: { not_run: notRun } };
          const meta = { sessionsOpened: 3, sessionsPurged: 3 - unpurged };
          const options = { out: hasOut ? "docs/evaluation-record.md" : null, force };
          const nothingRan = ran + notRun > 0 && ran === 0;
          const finish = finishRun(record, meta, options);
          expect(finish.writeOut).toBe(hasOut && (!nothingRan || force));
          expect(finish.exitCode).toBe(unpurged > 0 ? EXIT_PURGE_FAILED : nothingRan ? EXIT_NOTHING_RAN : EXIT_OK);
        },
      ),
    );
  });
});

describe("CLI arguments", () => {
  it("accepts the documented flags and refuses anything else", () => {
    const options = parseArgs([
      "--url",
      "https://meta-hack-omega.vercel.app/",
      "--deployed",
      "--commit",
      "bda2d00",
      "--out",
      "docs/evaluation-record.md",
    ]);
    expect(options).toMatchObject({
      url: "https://meta-hack-omega.vercel.app",
      deployed: true,
      commit: "bda2d00",
      out: "docs/evaluation-record.md",
    });
    fc.assert(
      fc.property(fc.stringMatching(/^--[a-z]{1,10}$/), (flag) => {
        fc.pre(!["--url", "--commit", "--out", "--timeout", "--help", "--force", "--deployed"].includes(flag));
        expect(() => parseArgs([flag])).toThrow(UsageError);
      }),
    );
    expect(parseArgs([]).force).toBe(false);
    expect(parseArgs([]).deployed).toBe(false);
    expect(parseArgs(["--force"]).force).toBe(true);
    expect(() => parseArgs(["--commit", "not-a-sha"])).toThrow(UsageError);
    expect(() => parseArgs(["--out", "/tmp/record.md"])).toThrow(UsageError);
    expect(() => parseArgs(["--out", "../record.md"])).toThrow(UsageError);
    expect(() => parseArgs(["--url", "ftp://example.com"])).toThrow(UsageError);
  });

  it("runs only against a local app unless --deployed is given", () => {
    // Production and every preview deployment share the production
    // database, so any other target is a choice the command line has to
    // state, whichever side of --url the flag sits on.
    const label = fc.stringMatching(/^[a-z][a-z0-9]{0,9}$/);
    const octet = fc.integer({ min: 0, max: 255 });
    const port = fc.option(fc.integer({ min: 1, max: 65535 }), { nil: undefined });
    const path = fc.constantFrom("", "/", "/intake");
    const withScheme = (hostArb) =>
      fc
        .tuple(fc.constantFrom("http", "https"), hostArb, port, path)
        .map(([scheme, host, portNumber, rest]) => `${scheme}://${host}${portNumber === undefined ? "" : `:${portNumber}`}${rest}`);
    const localArb = withScheme(
      fc.oneof(
        fc.constantFrom("localhost", "LOCALHOST", "[::1]", "0.0.0.0"),
        fc.tuple(octet, octet, octet).map(([a, b, c]) => `127.${a}.${b}.${c}`),
        label.map((name) => `${name}.localhost`),
      ),
    );
    const deployedArb = withScheme(
      fc.oneof(
        fc.constant("meta-hack-omega.vercel.app"),
        label.map((name) => `meta-hack-${name}-yifus-projects.vercel.app`),
        label.map((name) => `${name}.example.com`),
        label.map((name) => `localhost.${name}.com`),
        label.map((name) => `${name}localhost`),
        fc.tuple(octet, octet).map(([a, b]) => `127.0.${a}.${b}.nip.io`),
        fc.tuple(octet, octet).map(([a, b]) => `192.168.${a}.${b}`),
      ),
    );
    fc.assert(
      fc.property(localArb, deployedArb, fc.boolean(), (local, deployed, flagFirst) => {
        expect(isLocalTarget(local)).toBe(true);
        expect(parseArgs(["--url", local])).toMatchObject({ deployed: false });
        expect(isLocalTarget(deployed)).toBe(false);
        expect(() => parseArgs(["--url", deployed])).toThrow(UsageError);
        const argv = flagFirst ? ["--deployed", "--url", deployed] : ["--url", deployed, "--deployed"];
        expect(parseArgs(argv)).toMatchObject({ url: deployed.replace(/\/+$/, ""), deployed: true });
      }),
    );
  });

  it("names --deployed in the record's command exactly when the run used it", () => {
    fc.assert(
      fc.property(fc.constantFrom(true, false, "yes", 1, undefined), (deployed) => {
        const markdown = renderRecord(buildRecord(EVAL_CASES, new Map(), { ...META, deployed }));
        const command = markdown.split("\n").find((line) => line.startsWith("| Command |"));
        expect(command.includes(" --deployed")).toBe(deployed === true);
        expect(command).toContain(`--url ${META.target}`);
      }),
    );
  });
});

describe("the committed record", () => {
  /** A table row's cells, split on the pipes no backslash escapes. */
  function cellsOf(line) {
    const cells = [];
    let current = "";
    let backslashes = 0;
    for (const char of line.trim().slice(1, -1)) {
      if (char === "|" && backslashes % 2 === 0) {
        cells.push(current.trim());
        current = "";
      } else {
        current += char;
      }
      backslashes = char === "\\" ? backslashes + 1 : 0;
    }
    cells.push(current.trim());
    return cells;
  }

  it("is what the current harness renders, apart from the run's own results", () => {
    const committed = readFileSync(new URL("../docs/evaluation-record.md", import.meta.url), "utf8");
    const fresh = renderRecord(buildRecord(EVAL_CASES, new Map(), META));
    // The title and the opening paragraph.
    expect(committed.split("\n").slice(0, 3)).toEqual(fresh.split("\n").slice(0, 3));
    // The run table's labels and the sentence under it.
    const runLabels = (text) =>
      section(text, "Run").split("\n").filter((line) => line.startsWith("| ")).map((line) => cellsOf(line)[0]);
    const runNote = (text) =>
      section(text, "Run").split("\n").filter((line) => line !== "" && !line.startsWith("|")).join("\n");
    expect(runLabels(committed)).toEqual(runLabels(fresh));
    expect(runNote(committed)).toBe(runNote(fresh));
    // Every case's id, category, input and expectation, in order.
    const caseRows = (text) =>
      section(text, "Every case")
        .split("\n")
        .filter((line) => line.startsWith("| `"))
        .map((line) => cellsOf(line).slice(0, 4));
    expect(caseRows(committed)).toEqual(caseRows(fresh));
    // The scoring rules, the limits and the pilot section, word for word.
    const tail = (text) => text.slice(text.indexOf("\n## Scoring rules\n"));
    expect(tail(committed)).toBe(tail(fresh));
  });
});
