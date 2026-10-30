import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import { findBannedClaims } from "./honesty";
import sampleEntryJson from "../../kb/entries/pilot-program-sample.json";
import {
  KB_ENTRIES,
  SAMPLE_KB_ENTRIES,
  parseKbEntry,
  type KbEntry,
} from "./kb";
import { PII_QUESTION_IDS_IN_SPEC, QUESTION_BY_ID } from "./intake/spec";
import type { AnswerMap } from "./intake/flow";
import {
  CHAT_MAX_ATTEMPTS,
  resetModelTransport,
  setModelTransport,
} from "./model";
import { setLogSink } from "./telemetry";
import {
  EXPLANATION_FRAMING,
  MATCH_FRAMING,
  MATCH_EXPLANATION_MAX_TOKENS,
  type MatchExplanation,
  assertNoPiiValuesInMatch,
  buildMatchResponse,
  buildToResolve,
  checkExplanationGrounding,
  composeFallbackExplanation,
  explainEntry,
  matchCardText,
  rankEntries,
} from "./match";

// Benefit match tests (Mission v2 M3, VAL-MATCH-001..006): the scorer is a
// pure, deterministic function of the answer map; cards carry a source
// citation on every claim; stale/withdrawn entries never surface; unknowns
// become an explicit to-resolve list; explanations trace to the matched
// entry and pass the banned-claim gate.

function known(questionId: string, value: unknown): AnswerMap {
  return { [questionId]: { status: "known", value } };
}

function answerOf(questionId: string, value: unknown): AnswerMap {
  return known(questionId, value);
}

// Status fixtures start from the RAW sample JSON (snake_case) and run
// through parseKbEntry, so they follow the exact production path.
function fixtureEntry(status: "stale" | "withdrawn"): KbEntry {
  const raw = structuredClone(sampleEntryJson) as Record<string, unknown>;
  raw.status = status;
  raw.status_reason = `Test fixture: entry marked ${status}`;
  return parseKbEntry(raw);
}

// The production dataset is the seam-driven real entry only
// (VAL-PILOTREAL-004); the samples are the test-only fixtures. The unit
// suites exercise the FULL shipped population — production entries plus
// the sample fixtures, in the pre-split load order — through the explicit
// `entries` option, while the zero-signal/empty-state tests use the
// production default.
const ACTIVE = SAMPLE_KB_ENTRIES[0];
const STALE = fixtureEntry("stale");
const WITHDRAWN = fixtureEntry("withdrawn");
const ALL_ENTRIES: readonly KbEntry[] = [...SAMPLE_KB_ENTRIES, ...KB_ENTRIES];

// ---------------------------------------------------------------------------
// Randomized answer maps over the questions the shipped signals evaluate
// ---------------------------------------------------------------------------

const SIGNAL_QUESTION_IDS = [
  "application_role",
  "main_goal",
  "housing_status",
  "income_sources",
  "household_size",
  "id_status",
  "citizenship_status",
  "disability_status",
  "state",
] as const;

function valueArbitraryFor(questionId: string): fc.Arbitrary<unknown> {
  const question = QUESTION_BY_ID[questionId];
  if (!question?.options) {
    if (question?.type === "number") {
      return fc.integer({ min: 1, max: 8 }).map((n) => n);
    }
    return fc.constant("sample-answer");
  }
  const values = question.options.map((option) => option.value);
  const single = fc.constantFrom(...values);
  if (question.type === "multi_select") {
    return fc.array(single, { maxLength: 3 });
  }
  return single;
}

// One answer per signal question: absent, or a tri-state with a value. The
// statuses include unknown/unverified so the property tests exercise the
// never-inferred rule over the full population.
const answerMapArb: fc.Arbitrary<AnswerMap> = fc
  .tuple(
    ...SIGNAL_QUESTION_IDS.map((questionId) =>
      fc.option(
        fc.record(
          {
            status: fc.constantFrom("known", "unknown", "unverified") as fc.Arbitrary<
              "known" | "unknown" | "unverified"
            >,
            value: valueArbitraryFor(questionId),
          },
          { requiredKeys: [] as const },
        ),
        { nil: undefined },
      ).map((stored) => [questionId, stored] as const),
    ),
  )
  .map((pairs) => Object.fromEntries(pairs) as AnswerMap);

// ---------------------------------------------------------------------------
// VAL-MATCH-001: deterministic scoring
// ---------------------------------------------------------------------------

describe("rankEntries determinism (VAL-MATCH-001)", () => {
  it("produces byte-identical rankings over randomized answer sets", () => {
    const attempts = fc.property(answerMapArb, (answers) => {
      const first = JSON.stringify(rankEntries(answers, ALL_ENTRIES));
      const second = JSON.stringify(rankEntries(answers, ALL_ENTRIES));
      return first === second;
    });
    fc.assert(attempts, { numRuns: 300 });
  });

  it("ignores answer-map key insertion order (pure function of the answers)", () => {
    const attempts = fc.property(answerMapArb, (answers) => {
      const reversed = Object.fromEntries(Object.entries(answers).reverse());
      return (
        JSON.stringify(rankEntries(answers, ALL_ENTRIES)) ===
        JSON.stringify(rankEntries(reversed, ALL_ENTRIES))
      );
    });
    fc.assert(attempts, { numRuns: 200 });
  });

  it("never mutates the answers it reads", () => {
    const attempts = fc.property(answerMapArb, (answers) => {
      const snapshot = JSON.stringify(answers);
      rankEntries(answers, ALL_ENTRIES);
      return JSON.stringify(answers) === snapshot;
    });
    fc.assert(attempts, { numRuns: 100 });
  });

  it("breaks score ties deterministically by entry id", () => {
    const ranked = rankEntries({}, ALL_ENTRIES);
    const scores = ranked.map((r) => r.score);
    for (let index = 1; index < ranked.length; index += 1) {
      const previous = scores[index - 1] as number;
      const current = scores[index] as number;
      expect(previous).toBeGreaterThanOrEqual(current);
      if (previous === current) {
        expect(ranked[index - 1]!.entry.id < ranked[index]!.entry.id).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// VAL-MATCH-004 / BN-29: stale and withdrawn entries never surface
// ---------------------------------------------------------------------------

describe("active-only presentation (VAL-MATCH-004)", () => {
  it("ranks only active entries from a mixed-status fixture set", () => {
    const ranked = rankEntries(known("main_goal", "food"), [
      ACTIVE,
      STALE,
      WITHDRAWN,
    ]);
    expect(ranked.map((entry) => entry.entry.status)).toEqual(["active"]);
    expect(ranked.map((entry) => entry.entry.id)).toEqual([ACTIVE.id]);
  });

  it("never surfaces stale or withdrawn facts in any built card", async () => {
    // A housing answer scores the ACTIVE sample (its signals are
    // housing/id/income) so the active card actually renders — and the
    // same-signal stale/withdrawn clones stay out.
    const response = await buildMatchResponse(known("housing_status", "shelter"), {
      entries: [STALE, WITHDRAWN, ACTIVE],
      explainer: async () => ({ text: "stub explanation", source: "facts" }),
    });
    const serialized = JSON.stringify(response);
    expect(serialized).not.toContain("Test fixture: entry marked stale");
    expect(serialized).not.toContain("Test fixture: entry marked withdrawn");
    expect(response.matches.map((card) => card.entryId)).toEqual([ACTIVE.id]);
  });
});

// ---------------------------------------------------------------------------
// VAL-MATCH-002: reasons + requirements, every claim source-linked
// ---------------------------------------------------------------------------

describe("match cards (VAL-MATCH-002)", () => {
  it("builds reasons only from matched signals of known answers", () => {
    const ranked = rankEntries(known("main_goal", "food"), ALL_ENTRIES);
    const card = ranked[0]!.entry.id === "pilot_program_sample_b"
      ? ranked[0]!
      : ranked.find((r) => r.entry.id === "pilot_program_sample_b")!;
    expect(card.score).toBeGreaterThan(0);
    expect(card.reasons.length).toBeGreaterThan(0);
    for (const reason of card.reasons) {
      expect(reason.questionId).toBe("main_goal");
    }
  });

  it("labels matched option answers in plain language, never raw values", () => {
    const ranked = rankEntries(known("housing_status", "shelter"), ALL_ENTRIES);
    const reasons = ranked.flatMap((r) => r.reasons);
    expect(reasons.length).toBeGreaterThan(0);
    // housing_status is pii:true: the answer label must be OMITTED entirely.
    for (const reason of reasons) {
      if (reason.questionId === "housing_status") {
        expect(reason.answerLabel).toBeUndefined();
      }
    }
    const labeled = rankEntries(known("main_goal", "food"), ALL_ENTRIES).flatMap(
      (r) => r.reasons,
    );
    expect(labeled.some((reason) => reason.answerLabel === "Food")).toBe(true);
    expect(labeled.some((reason) => reason.answerLabel === "food")).toBe(false);
  });

  it("carries a complete source citation on every reason, requirement, and link", async () => {
    // Every shipped entry scores positive here, so every entry gets a card:
    // sample A via housing, sample B via the food goal, sample C via the
    // disability status, and the real pilot entry via the state answer
    // (mission v2.1 M6).
    const response = await buildMatchResponse(
      {
        ...known("main_goal", "food"),
        ...known("housing_status", "shelter"),
        ...known("disability_status", "yes"),
        ...known("state", "NC"),
      },
      { entries: ALL_ENTRIES, explainer: async () => ({ text: "stub", source: "facts" }) },
    );
    expect(response.matches.length).toBe(ALL_ENTRIES.length);
    for (const card of response.matches) {
      for (const item of [
        ...card.reasons.map((reason) => reason.source),
        ...card.requirements.map((requirement) => requirement.source),
        ...card.links.map((link) => link.source),
      ]) {
        expect(item.entryId.length).toBeGreaterThan(0);
        expect(item.entryVersion).toBeGreaterThanOrEqual(1);
        expect(item.entryStatus).toBe("active");
        expect(item.sourceUrl.startsWith("https://")).toBe(true);
        expect(item.retrievedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    }
  });

  it("builds the requirements checklist from documents, steps, and deadlines", async () => {
    // Every shipped entry must score positive here so each one's checklist
    // is exercised (a zero-signal session produces no cards at all). The
    // real pilot entry scores via the state answer; the samples via their
    // sample signals.
    const response = await buildMatchResponse(
      {
        ...known("main_goal", "food"),
        ...known("housing_status", "shelter"),
        ...known("disability_status", "yes"),
        ...known("state", "NC"),
      },
      { entries: ALL_ENTRIES, explainer: async () => ({ text: "stub", source: "facts" }) },
    );
    for (const card of response.matches) {
      const kinds = new Set(card.requirements.map((requirement) => requirement.kind));
      expect(kinds.has("document")).toBe(true);
      expect(kinds.has("step")).toBe(true);
      expect(kinds.has("deadline")).toBe(true);
      // Renewal: the samples carry the renewal placeholder deadline; the
      // real entry carries only deadlines its official sources state (the
      // county page's renewal cadence is not in its deadlines group), so
      // the renewal kind is asserted only for the samples.
      if (card.entryId !== "nc_medicaid") {
        expect(kinds.has("renewal")).toBe(true);
      }
    }
  });

  it("frames every card with the honest may-be-worth-pursuing copy", () => {
    expect(MATCH_FRAMING).toBe("This may be worth pursuing.");
  });

  it("pins the explanation completion budget at or above 4096 tokens", () => {
    // Live-verified on this exact prompt: reasoning tokens are part of the
    // completion budget, and the grounded-explanation constraints burned a
    // 2048 budget into null content with finish_reason "length".
    expect(MATCH_EXPLANATION_MAX_TOKENS).toBeGreaterThanOrEqual(4096);
  });
});

// ---------------------------------------------------------------------------
// VAL-MATCH-005 / BN-16: unknowns surface as to-resolve, never inferred
// ---------------------------------------------------------------------------

describe("to-resolve list (VAL-MATCH-005)", () => {
  it("names every unknown and unverified answer in plain language", () => {
    const answers: AnswerMap = {
      ...answerOf("main_goal", "food"),
    };
    (answers as Record<string, { status: string; value?: unknown }>)["housing_status"] = {
      status: "unknown",
    };
    (answers as Record<string, { status: string; value?: unknown }>)["id_status"] = {
      status: "unverified",
    };
    const toResolve = buildToResolve(answers);
    const byId = new Map(toResolve.map((item) => [item.questionId, item]));
    expect(byId.get("housing_status")?.status).toBe("unknown");
    expect(byId.get("housing_status")?.prompt).toBe(
      QUESTION_BY_ID["housing_status"]?.prompt,
    );
    expect(byId.get("id_status")?.status).toBe("unverified");
    expect(byId.get("id_status")?.statusLabel).toBe("Answered but not verified");
  });

  it("never builds a reason from an unknown or unverified answer (property)", () => {
    const attempts = fc.property(answerMapArb, (answers) => {
      const ranked = rankEntries(answers, ALL_ENTRIES);
      for (const rankedEntry of ranked) {
        for (const reason of rankedEntry.reasons) {
          if (!reason.questionId) {
            continue;
          }
          const stored = answers[reason.questionId];
          if (!stored || stored.status !== "known") {
            return false;
          }
        }
      }
      return true;
    });
    fc.assert(attempts, { numRuns: 300 });
  });

  it("gives every unknown question id a to-resolve entry (property)", () => {
    const attempts = fc.property(answerMapArb, (answers) => {
      const toResolve = buildToResolve(answers);
      const ids = new Set(toResolve.map((item) => item.questionId));
      for (const [questionId, stored] of Object.entries(answers)) {
        if (stored && (stored.status === "unknown" || stored.status === "unverified")) {
          if (!ids.has(questionId)) {
            return false;
          }
        }
      }
      return true;
    });
    fc.assert(attempts, { numRuns: 200 });
  });
});

// ---------------------------------------------------------------------------
// VAL-MATCH-003: zero banned claims on the rendered card population
// ---------------------------------------------------------------------------

describe("banned-claim scan over the card population (VAL-MATCH-003)", () => {
  it("finds zero banned claims across randomized-answer cards", async () => {
    const attempts = fc.asyncProperty(answerMapArb, async (answers) => {
      const response = await buildMatchResponse(answers, {
        entries: ALL_ENTRIES,
        explainer: async () => ({
          text: composeFallbackExplanation(ACTIVE),
          source: "facts",
        }),
      });
      for (const card of response.matches) {
        expect(findBannedClaims(matchCardText(card))).toEqual([]);
      }
      return true;
    });
    await fc.assert(attempts, { numRuns: 60 });
  });

  it("bites on a seeded banned-claim card fixture", async () => {
    // A positive-scoring session, so a card exists to poison.
    const response = await buildMatchResponse(known("main_goal", "food"), {
      entries: ALL_ENTRIES,
      explainer: async () => ({ text: "stub", source: "facts" }),
    });
    const seeded = `${response.matches[0]!.framing} You qualify for this program.`;
    expect(findBannedClaims(seeded).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Zero-signal honesty (claude-review P2-1 on PR #45): a score-0 entry is
// never presented as a "may be worth pursuing" card, and no model call is
// spent on a zero-signal top entry — the honest empty state speaks instead.
// ---------------------------------------------------------------------------

describe("zero-signal honesty", () => {
  it("never presents a score-0 entry as a card and spends no explainer call", async () => {
    let explainerCalls = 0;
    const explainer = async (): Promise<MatchExplanation> => {
      explainerCalls += 1;
      return { text: "stub", source: "facts" };
    };
    const zeroSignalAnswerSets: AnswerMap[] = [
      // No answers at all.
      {},
      // A known answer no signal evaluates (a pii free-text question).
      { county: { status: "known", value: "anywhere" } },
      // A known answer that matches no signal values.
      { main_goal: { status: "known", value: "other" } },
    ];
    for (const answers of zeroSignalAnswerSets) {
      const response = await buildMatchResponse(answers, {
        explainer,
        explanationCache: new Map<string, MatchExplanation>(),
      });
      expect(response.matches, JSON.stringify(answers)).toEqual([]);
    }
    expect(explainerCalls).toBe(0);
  });

  it("keeps the to-resolve list honest when nothing scores", async () => {
    const response = await buildMatchResponse(
      { id_status: { status: "unknown" } },
      { explanationCache: new Map() },
    );
    expect(response.matches).toEqual([]);
    expect(response.toResolve.map((item) => item.questionId)).toEqual([
      "id_status",
    ]);
  });

  it("gives every built card a positive score (property)", async () => {
    await fc.assert(
      fc.asyncProperty(answerMapArb, async (answers) => {
        const response = await buildMatchResponse(answers, {
          entries: ALL_ENTRIES,
          explainer: async () => ({ text: "stub", source: "facts" as const }),
          explanationCache: new Map(),
        });
        return response.matches.every((card) => card.score > 0);
      }),
      { numRuns: 40 },
    );
  });
});

// ---------------------------------------------------------------------------
// Explanation cache (claude-review P2-2 on PR #45): ONE gated explanation
// per entry id + version, independent of rank, attached at ranking time —
// repeated turns never re-fire the model call.
// ---------------------------------------------------------------------------

describe("explanation cache", () => {
  it("spends one explainer call per entry across repeated builds", async () => {
    const cache = new Map<string, MatchExplanation>();
    let calls = 0;
    const explainer = async (): Promise<MatchExplanation> => {
      calls += 1;
      return { text: "model explanation", source: "model" };
    };
    const answers = known("main_goal", "food");
    // Three turns with the same answers: one call, then cache hits.
    await buildMatchResponse(answers, {
      entries: ALL_ENTRIES,
      explainer,
      explanationCache: cache,
    });
    await buildMatchResponse(answers, { explainer, explanationCache: cache });
    await buildMatchResponse(answers, { explainer, explanationCache: cache });
    expect(calls).toBe(1);
  });

  it("attaches the cached explanation regardless of the entry's current rank", async () => {
    const cache = new Map<string, MatchExplanation>();
    const calls: string[] = [];
    const explainer = async (entry: KbEntry): Promise<MatchExplanation> => {
      calls.push(entry.id);
      return { text: `model explanation for ${entry.id}`, source: "model" };
    };
    // Turn 1: the food sample is top (food goal; the other entries score 0).
    await buildMatchResponse(known("main_goal", "food"), {
      entries: ALL_ENTRIES,
      explainer,
      explanationCache: cache,
    });
    expect(calls).toEqual(["pilot_program_sample_b"]);
    // Turn 2: food + housing — the housing sample ties at the top (entry-id
    // tiebreak) and the food sample drops to a lower positive rank. The
    // food sample's card must carry its cached MODEL explanation, not fall
    // back to entry-fact copy, and no second call may fire for it.
    const response = await buildMatchResponse(
      { ...known("main_goal", "food"), ...known("housing_status", "shelter") },
      { entries: ALL_ENTRIES, explainer, explanationCache: cache },
    );
    expect(calls).toEqual(["pilot_program_sample_b", "pilot_program_sample"]);
    const foodCard = response.matches.find(
      (card) => card.entryId === "pilot_program_sample_b",
    );
    expect(foodCard?.explanation).toEqual({
      text: "model explanation for pilot_program_sample_b",
      source: "model",
    });
  });

  it("earns a fresh explanation when the entry version is bumped", async () => {
    const cache = new Map<string, MatchExplanation>();
    const calls: string[] = [];
    const explainer = async (entry: KbEntry): Promise<MatchExplanation> => {
      calls.push(`${entry.id}:v${entry.version}`);
      return {
        text: `model explanation for ${entry.id} v${entry.version}`,
        source: "model",
      };
    };
    const answers = known("main_goal", "food");
    await buildMatchResponse(answers, {
      entries: ALL_ENTRIES,
      explainer,
      explanationCache: cache,
    });
    const current = ALL_ENTRIES.find(
      (entry) => entry.id === "pilot_program_sample_b",
    )!;
    const bumped: KbEntry = { ...current, version: current.version + 1 };
    const response = await buildMatchResponse(answers, {
      entries: [bumped],
      explainer,
      explanationCache: cache,
    });
    expect(calls).toEqual([
      "pilot_program_sample_b:v1",
      "pilot_program_sample_b:v2",
    ]);
    expect(response.matches[0]!.explanation.text).toContain("v2");
  });

  it("does not cache a degraded fallback — the next turn retries the model", async () => {
    // A transient failure (outage, gate block, truncation) must not pin the
    // entry to fallback copy until process restart: only model-sourced
    // explanations are cached (claude-review P2 on PR #46). ONE shared
    // cache across both builds proves the failed explanation never enters
    // it.
    process.env.MODEL_API_KEY = "sentinel-test-key-never-log";
    let attempts = 0;
    setModelTransport(async () => {
      attempts += 1;
      return new Response(JSON.stringify({ error: { message: "down" } }), {
        status: 500,
      });
    });
    const cache = new Map<string, MatchExplanation>();
    try {
      const answers = known("main_goal", "food");
      const first = await buildMatchResponse(answers, { entries: ALL_ENTRIES, explanationCache: cache });
      const second = await buildMatchResponse(answers, { entries: ALL_ENTRIES, explanationCache: cache });
      expect(first.matches[0]?.explanation.source).toBe("facts");
      expect(second.matches[0]?.explanation.source).toBe("facts");
      expect(cache.size).toBe(0);
      expect(attempts).toBe(2 * CHAT_MAX_ATTEMPTS);
    } finally {
      resetModelTransport();
    }
  });

  it("never exceeds one explainer call per entry id+version (property)", async () => {
    const cache = new Map<string, MatchExplanation>();
    const calls: string[] = [];
    const explainer = async (entry: KbEntry): Promise<MatchExplanation> => {
      calls.push(`${entry.id}:v${entry.version}`);
      return { text: "model explanation", source: "model" };
    };
    await fc.assert(
      fc.asyncProperty(answerMapArb, async (answers) => {
        const response = await buildMatchResponse(answers, {
          entries: ALL_ENTRIES,
          explainer,
          explanationCache: cache,
        });
        // No entry id+version is ever explained twice across turns.
        if (new Set(calls).size !== calls.length) {
          return false;
        }
        // The top card always carries the cached explanation.
        const top = response.matches[0];
        return (
          top === undefined ||
          cache.has(`${top.entryId}:v${top.entryVersion}`)
        );
      }),
      { numRuns: 40 },
    );
  });
});

// ---------------------------------------------------------------------------
// VAL-MATCH-006: explanation grounding
// ---------------------------------------------------------------------------

describe("grounding checker (VAL-MATCH-006)", () => {
  it("accepts an explanation built from the entry's own facts", () => {
    const violations = checkExplanationGrounding(
      `${EXPLANATION_FRAMING} The official rules state: applicants must satisfy the residency and income rules stated in the official rules source. You would need: identity document.`,
      ACTIVE,
    );
    expect(violations).toEqual([]);
  });

  it("flags an explanation citing facts absent from the entry", () => {
    for (const sentence of [
      "This program covers dental care for every county resident.",
      "The program pays 500 dollars monthly to each applicant.",
    ]) {
      const violations = checkExplanationGrounding(
        `${EXPLANATION_FRAMING} ${sentence}`,
        ACTIVE,
      );
      expect(violations.length, sentence).toBeGreaterThan(0);
      expect(violations[0]!.sentence, sentence).toBe(sentence);
    }
  });

  it("allows the committed framing sentence", () => {
    expect(checkExplanationGrounding(EXPLANATION_FRAMING, ACTIVE)).toEqual([]);
  });

  it("accepts entry-derived sentences and rejects disjoint-vocabulary sentences (property)", () => {
    const entryWords = [
      "official rules",
      "residency",
      "income",
      "identity document",
      "residency document",
      "application window",
    ];
    const derived = fc
      .array(fc.constantFrom(...entryWords), { minLength: 1, maxLength: 3 })
      .map((parts) => `The program's official rules describe ${parts.join(" and ")}.`);
    const alien = fc
      .array(fc.constantFrom("qqq", "wwww", "zzzq", "xkcdf", "fffee"), {
        minLength: 1,
        maxLength: 3,
      })
      .map((parts) => `The qqqj wwww zzzq ${parts.join(" ")} fffee.`);

    const grounded = fc.property(derived, (sentence) => {
      return checkExplanationGrounding(sentence, ACTIVE).length === 0;
    });
    fc.assert(grounded, { numRuns: 100 });

    const ungrounded = fc.property(alien, (sentence) => {
      return checkExplanationGrounding(sentence, ACTIVE).length > 0;
    });
    fc.assert(ungrounded, { numRuns: 100 });
  });
});

describe("explainEntry with scripted model responses (VAL-MATCH-006)", () => {
  afterEach(() => {
    resetModelTransport();
    setLogSink(() => undefined);
  });

  function installChat(content: string, finishReason = "stop"): void {
    process.env.MODEL_API_KEY = "sentinel-test-key-never-log";
    setModelTransport(async () => {
      return new Response(
        JSON.stringify({
          id: "chatcmpl-test",
          model: "muse-spark-1.3",
          choices: [
            {
              index: 0,
              finish_reason: finishReason,
              message: { role: "assistant", content },
            },
          ],
          usage: {
            prompt_tokens: 20,
            completion_tokens: 30,
            total_tokens: 50,
            completion_tokens_details: { reasoning_tokens: 10 },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
  }

  it("passes a grounded model explanation through", async () => {
    installChat(
      `${EXPLANATION_FRAMING} The official rules state: applicants must satisfy the residency and income rules stated in the official rules source.`,
    );
    const explanation = await explainEntry(ACTIVE);
    expect(explanation.source).toBe("model");
  });

  it("replaces an ungrounded model explanation with entry-fact copy", async () => {
    installChat(
      `${EXPLANATION_FRAMING} This program covers dental care for every county resident.`,
    );
    const explanation = await explainEntry(ACTIVE);
    expect(explanation.source).toBe("facts");
    expect(checkExplanationGrounding(explanation.text, ACTIVE)).toEqual([]);
  });

  it("replaces promise language with entry-fact copy before render", async () => {
    installChat(
      `${EXPLANATION_FRAMING} You will be approved for this program.`,
    );
    const explanation = await explainEntry(ACTIVE);
    expect(explanation.source).toBe("facts");
    expect(findBannedClaims(explanation.text)).toEqual([]);
  });

  it("degrades to entry-fact copy when the model is unavailable", async () => {
    process.env.MODEL_API_KEY = "sentinel-test-key-never-log";
    setModelTransport(async () => {
      return new Response(JSON.stringify({ error: { message: "down" } }), {
        status: 500,
      });
    });
    const explanation = await explainEntry(ACTIVE);
    expect(explanation.source).toBe("facts");
    expect(checkExplanationGrounding(explanation.text, ACTIVE)).toEqual([]);
  });

  it("degrades to entry-fact copy when the reply is budget-truncated", async () => {
    // droid-review P2 on PR #45: chatCompletion returns non-empty content
    // even with finish_reason "length" — a truncated final sentence must
    // never ship as a complete model-sourced explanation.
    const events: string[] = [];
    setLogSink((line) => {
      events.push(String((JSON.parse(line) as { event?: unknown }).event));
    });
    installChat(
      `${EXPLANATION_FRAMING} The official rules state: applicants must satis`,
      "length",
    );
    const explanation = await explainEntry(ACTIVE);
    expect(explanation.source).toBe("facts");
    expect(checkExplanationGrounding(explanation.text, ACTIVE)).toEqual([]);
    expect(events).toContain("match_explanation_length_truncated_blocked");
  });

  it("composes fallback copy that stays grounded on every shipped entry", () => {
    for (const entry of ALL_ENTRIES) {
      const text = composeFallbackExplanation(entry);
      expect(findBannedClaims(text)).toEqual([]);
      expect(checkExplanationGrounding(text, entry)).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// PII defense in depth
// ---------------------------------------------------------------------------

describe("assertNoPiiValuesInMatch", () => {
  it("passes a response built from answers carrying pii values", async () => {
    const answers: AnswerMap = {
      housing_status: { status: "known", value: "shelter" },
      citizenship_status: { status: "known", value: "us_citizen" },
      date_of_birth: { status: "known", value: "1980-02-03" },
      main_goal: { status: "known", value: "food" },
    };
    const response = await buildMatchResponse(answers, {
      entries: ALL_ENTRIES,
      explainer: async () => ({ text: "stub", source: "facts" }),
      explanationCache: new Map(),
    });
    expect(() => assertNoPiiValuesInMatch(response, answers)).not.toThrow();
  });

  it("does not fail the match list when a pii answer equals common KB copy", async () => {
    // claude-review P2-3 on PR #45: a free-text pii answer that happens to
    // equal a common word of KB/glossary copy must not fail-closed the
    // user's whole match list. Every shipped entry's deadline text names an
    // application window, so the old whole-serialization scan threw on this
    // exact session; the gate now excuses values that are exact words of
    // the response's public copy.
    const answers: AnswerMap = {
      goal_detail: { status: "known", value: "application" },
      main_goal: { status: "known", value: "food" },
    };
    const response = await buildMatchResponse(answers, {
      entries: ALL_ENTRIES,
      explainer: async () => ({ text: "stub", source: "facts" }),
      explanationCache: new Map(),
    });
    // The response really does carry the word in its static KB copy — the
    // false-positive class the old scan died on.
    expect(JSON.stringify(response).toLowerCase()).toContain("application");
    expect(() => assertNoPiiValuesInMatch(response, answers)).not.toThrow();
  });

  it("bites when a reason would carry a private answer label", async () => {
    const answers: AnswerMap = {
      date_of_birth: { status: "known", value: "1980-02-03" },
    };
    const clean = await buildMatchResponse(known("main_goal", "food"), {
      entries: ALL_ENTRIES,
      explainer: async () => ({ text: "stub", source: "facts" }),
      explanationCache: new Map(),
    });
    const cleanCard = clean.matches[0]!;
    const baseReason = cleanCard.reasons[0]!;
    const poisonedCard = {
      ...cleanCard,
      reasons: [
        {
          ...baseReason,
          // The regression this gate exists for: a bug routed the person's
          // private answer into the reason's user-derived label field.
          answerLabel: "1980-02-03",
        },
      ],
    };
    expect(() =>
      assertNoPiiValuesInMatch(
        { ...clean, matches: [poisonedCard, ...clean.matches.slice(1)] },
        answers,
      ),
    ).toThrow();
  });

  it("checks multi-select array elements individually", async () => {
    // claude-review P2-3: the old check stringified the whole array — a
    // `["a","b"]` JSON string can never substring-match card copy — so
    // multi-select pii values were never really checked. Each element must
    // be checked on its own.
    const answers: AnswerMap = {
      housing_status: {
        status: "known",
        value: ["shelter", "transitional_12b"],
      },
      main_goal: { status: "known", value: "food" },
    };
    const clean = await buildMatchResponse(answers, {
      entries: ALL_ENTRIES,
      explainer: async () => ({ text: "stub", source: "facts" }),
      explanationCache: new Map(),
    });
    // No element reaches a user-derived surface: the response passes.
    expect(() => assertNoPiiValuesInMatch(clean, answers)).not.toThrow();
    // One leaked element in a reason label: the gate bites on that element
    // alone.
    const cleanCard = clean.matches[0]!;
    const baseReason = cleanCard.reasons[0]!;
    const poisonedCard = {
      ...cleanCard,
      reasons: [{ ...baseReason, answerLabel: "transitional_12b" }],
    };
    expect(() =>
      assertNoPiiValuesInMatch(
        { ...clean, matches: [poisonedCard, ...clean.matches.slice(1)] },
        answers,
      ),
    ).toThrow();
  });

  it("bites on a private value in reason text", async () => {
    const answers: AnswerMap = {
      date_of_birth: { status: "known", value: "1980-02-03" },
    };
    const clean = await buildMatchResponse(known("main_goal", "food"), {
      entries: ALL_ENTRIES,
      explainer: async () => ({ text: "stub", source: "facts" }),
      explanationCache: new Map(),
    });
    const cleanCard = clean.matches[0]!;
    const poisoned = {
      ...clean,
      matches: [
        {
          ...cleanCard,
          reasons: cleanCard.reasons.map((reason, index) =>
            index === 0
              ? { ...reason, text: "You told us your date of birth is 1980-02-03." }
              : reason,
          ),
        },
        ...clean.matches.slice(1),
      ],
    };
    expect(() => assertNoPiiValuesInMatch(poisoned, answers)).toThrow();
  });

  it("bites on a private value in model-sourced explanation text", async () => {
    const answers: AnswerMap = {
      date_of_birth: { status: "known", value: "1980-02-03" },
    };
    const clean = await buildMatchResponse(known("main_goal", "food"), {
      entries: ALL_ENTRIES,
      explainer: async () => ({ text: "stub", source: "facts" }),
      explanationCache: new Map(),
    });
    const cleanCard = clean.matches[0]!;
    const poisoned = {
      ...clean,
      matches: [
        {
          ...cleanCard,
          explanation: {
            text: "You told us your date of birth is 1980-02-03.",
            source: "model" as const,
          },
        },
        ...clean.matches.slice(1),
      ],
    };
    expect(() => assertNoPiiValuesInMatch(poisoned, answers)).toThrow();
  });

  it("excuses a pii value that is an exact word of the response's own static copy", async () => {
    // The entry's own deadline text names an application window, and a card
    // whose explanation quotes a glossary term renders that term — a
    // free-text pii answer equal to such a word must not fail the user's
    // match list. A glossary word the response does NOT render still
    // throws. The explanation goes through the explainer stub so the card
    // (and its rendered terms) is built from the final copy, as in
    // production.
    const withModelExplanation = (text: string) =>
      buildMatchResponse(known("main_goal", "food"), {
        entries: ALL_ENTRIES,
        explainer: async () => ({ text, source: "model" as const }),
        explanationCache: new Map(),
      });
    const applicationAnswers: AnswerMap = {
      goal_detail: { status: "known", value: "application" },
    };
    const applicationEcho = await withModelExplanation(
      "The application window stays open.",
    );
    expect(() =>
      assertNoPiiValuesInMatch(applicationEcho, applicationAnswers),
    ).not.toThrow();
    const termWordAnswers: AnswerMap = {
      goal_detail: { status: "known", value: "assistance" },
    };
    const termEcho = await withModelExplanation(
      "Food assistance may be worth pursuing.",
    );
    expect(() =>
      assertNoPiiValuesInMatch(termEcho, termWordAnswers),
    ).not.toThrow();
    const unrenderedGlossaryWord: AnswerMap = {
      goal_detail: { status: "known", value: "agency" },
    };
    const unrenderedEcho = await withModelExplanation(
      "Contact the agency for help.",
    );
    expect(() =>
      assertNoPiiValuesInMatch(unrenderedEcho, unrenderedGlossaryWord),
    ).toThrow();
  });

  it("excuses a pii answer equal to a shown option label or status label", async () => {
    // The reviewer fixture (claude-review P2 on PR #46): a free-text pii
    // answer that happens to equal one of the spec's own display labels
    // must not permanently 500 the match list — the label is public
    // vocabulary, not the user's text. The health-care goal scores sample
    // C, so its spec label renders on a card reason.
    const answers: AnswerMap = {
      goal_detail: { status: "known", value: "health care" },
      main_goal: { status: "known", value: "healthcare" },
      id_status: { status: "unverified" },
    };
    const response = await buildMatchResponse(answers, {
      entries: ALL_ENTRIES,
      explainer: async () => ({ text: "stub", source: "facts" }),
      explanationCache: new Map(),
    });
    // The spec-produced label really renders, and the to-resolve status
    // label really contains the word "verified".
    const serialized = JSON.stringify(response).toLowerCase();
    expect(serialized).toContain("health care");
    expect(serialized).toContain("verified");
    expect(() => assertNoPiiValuesInMatch(response, answers)).not.toThrow();
    // The bite side — a private value in a rendered label — is pinned by
    // the dedicated answer-label and property tests above.
  });

  it("excuses a pii value that matches a word of a to-resolve prompt", async () => {
    // The to-resolve prompts are verbatim spec questions — static copy this
    // response renders. A free-text pii answer that happens to equal a
    // prompt word ("messages" in the phone prompt) must not fail the
    // user's match list; only user-derived fields and non-static copy
    // throw.
    const answers: AnswerMap = {
      goal_detail: { status: "known", value: "messages" },
      phone_contact: { status: "unknown" },
    };
    const response = await buildMatchResponse(answers, {
      entries: ALL_ENTRIES,
      explainer: async () => ({ text: "stub", source: "facts" }),
      explanationCache: new Map(),
    });
    expect(JSON.stringify(response).toLowerCase()).toContain("messages");
    expect(() => assertNoPiiValuesInMatch(response, answers)).not.toThrow();
  });

  it("degrades a model explanation that echoes this session's pii value", async () => {
    // Round-5 P2 on PR #46: the explanation is model output grounded on the
    // entry — it never sees user content — so a word colliding with this
    // session's free-text pii answer is coincidence. THIS response's card
    // degrades to entry-fact copy instead of failing the whole match list,
    // and the per-entry cache (shared across users) is untouched.
    const answers: AnswerMap = {
      goal_detail: { status: "known", value: "gather" },
      main_goal: { status: "known", value: "food" },
    };
    const response = await buildMatchResponse(answers, {
      entries: ALL_ENTRIES,
      explainer: async () => ({
        text: "Applicants should gather documents early.",
        source: "model" as const,
      }),
      explanationCache: new Map(),
    });
    const card = response.matches.find(
      (entry) => entry.entryId === "pilot_program_sample_b",
    )!;
    expect(card.explanation.source).toBe("facts");
    expect(card.explanation.text).not.toContain("gather");
    expect(() => assertNoPiiValuesInMatch(response, answers)).not.toThrow();
  });

  it("degrades an explanation carrying a pii value inside a larger word", async () => {
    // The degrade predicate mirrors the gate EXACTLY (substring trigger,
    // word-boundary excusal): "regather" contains "gather" as a substring,
    // so the gate would reject this explanation — it is degraded at build
    // time instead, and a cached copy can never pin a session to a 500.
    const answers: AnswerMap = {
      goal_detail: { status: "known", value: "gather" },
      main_goal: { status: "known", value: "food" },
    };
    const response = await buildMatchResponse(answers, {
      entries: ALL_ENTRIES,
      explainer: async () => ({
        text: "Applicants may need to regather their documents.",
        source: "model" as const,
      }),
      explanationCache: new Map(),
    });
    const card = response.matches.find(
      (entry) => entry.entryId === "pilot_program_sample_b",
    )!;
    expect(card.explanation.source).toBe("facts");
    expect(() => assertNoPiiValuesInMatch(response, answers)).not.toThrow();
  });

  it("keeps a model explanation whose words are the entry's own copy", async () => {
    const answers: AnswerMap = {
      goal_detail: { status: "known", value: "application" },
      main_goal: { status: "known", value: "food" },
    };
    const response = await buildMatchResponse(answers, {
      entries: ALL_ENTRIES,
      explainer: async () => ({
        text: "The application window stays open.",
        source: "model" as const,
      }),
      explanationCache: new Map(),
    });
    const card = response.matches.find(
      (entry) => entry.entryId === "pilot_program_sample_b",
    )!;
    // "application" is the entry's own deadline word — grounded copy, kept.
    expect(card.explanation.source).toBe("model");
    expect(() => assertNoPiiValuesInMatch(response, answers)).not.toThrow();
  });

  it("excuses an option-label value even when echoed into an answer label", async () => {
    // Pins the per-value excusal (round-6 P2 on PR #46): a free-text pii
    // answer equal to a shown option label is public vocabulary — it is
    // excused wherever it appears, INCLUDING a (buggy) echo into the
    // answer-label field. A value indistinguishable from public copy is
    // not a disclosure; everything else still throws.
    const answers: AnswerMap = {
      goal_detail: { status: "known", value: "health care" },
      main_goal: { status: "known", value: "healthcare" },
    };
    const clean = await buildMatchResponse(answers, {
      entries: ALL_ENTRIES,
      explainer: async () => ({ text: "stub", source: "facts" }),
      explanationCache: new Map(),
    });
    const cleanCard = clean.matches.find(
      (card) => card.entryId === "pilot_program_sample_c",
    )!;
    const echoed = {
      ...clean,
      matches: [
        {
          ...cleanCard,
          reasons: [
            {
              ...cleanCard.reasons[0]!,
              answerLabel: "Health care",
            },
          ],
        },
        ...clean.matches.slice(1),
      ],
    };
    expect(() => assertNoPiiValuesInMatch(echoed, answers)).not.toThrow();
  });

  it("bites exactly when a specific pii value reaches a user-derived field (property)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...PII_QUESTION_IDS_IN_SPEC),
        fc.stringMatching(/^[a-z]{8,12}$/),
        async (questionId, value) => {
          const answers: AnswerMap = {
            [questionId]: { status: "known", value },
          };
          const response = await buildMatchResponse(known("main_goal", "food"), {
            entries: ALL_ENTRIES,
            explainer: async () => ({ text: "stub", source: "facts" }),
            explanationCache: new Map(),
          });
          // The value appears in no user-derived surface of a clean
          // response — and static KB copy never triggers the gate.
          expect(() =>
            assertNoPiiValuesInMatch(response, answers),
          ).not.toThrow();
          // The value in a reason's answer label: bites.
          const labelPoisoned = {
            ...response,
            matches: response.matches.map((card, cardIndex) =>
              cardIndex === 0
                ? {
                    ...card,
                    reasons: card.reasons.map((reason, reasonIndex) =>
                      reasonIndex === 0
                        ? { ...reason, answerLabel: value }
                        : reason,
                    ),
                  }
                : card,
            ),
          };
          expect(() =>
            assertNoPiiValuesInMatch(labelPoisoned, answers),
          ).toThrow();
          // The value in a to-resolve label: bites too.
          const toResolvePoisoned = {
            ...response,
            toResolve: [
              ...response.toResolve,
              {
                questionId: "main_goal",
                prompt: QUESTION_BY_ID["main_goal"]?.prompt ?? "main goal",
                status: "unknown" as const,
                statusLabel: value,
              },
            ],
          };
          expect(() =>
            assertNoPiiValuesInMatch(toResolvePoisoned, answers),
          ).toThrow();
          return true;
        },
      ),
      { numRuns: 40 },
    );
  });
});
