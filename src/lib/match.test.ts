import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import { findBannedClaims } from "./honesty";
import sampleEntryJson from "../../kb/entries/pilot-program-sample.json";
import {
  KB_ENTRIES,
  parseKbEntry,
  type KbEntry,
} from "./kb";
import { QUESTION_BY_ID } from "./intake/spec";
import type { AnswerMap } from "./intake/flow";
import { resetModelTransport, setModelTransport } from "./model";
import {
  EXPLANATION_FRAMING,
  MATCH_FRAMING,
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

const ACTIVE = KB_ENTRIES[0];
const STALE = fixtureEntry("stale");
const WITHDRAWN = fixtureEntry("withdrawn");

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
      const first = JSON.stringify(rankEntries(answers, KB_ENTRIES));
      const second = JSON.stringify(rankEntries(answers, KB_ENTRIES));
      return first === second;
    });
    fc.assert(attempts, { numRuns: 300 });
  });

  it("ignores answer-map key insertion order (pure function of the answers)", () => {
    const attempts = fc.property(answerMapArb, (answers) => {
      const reversed = Object.fromEntries(Object.entries(answers).reverse());
      return (
        JSON.stringify(rankEntries(answers, KB_ENTRIES)) ===
        JSON.stringify(rankEntries(reversed, KB_ENTRIES))
      );
    });
    fc.assert(attempts, { numRuns: 200 });
  });

  it("never mutates the answers it reads", () => {
    const attempts = fc.property(answerMapArb, (answers) => {
      const snapshot = JSON.stringify(answers);
      rankEntries(answers, KB_ENTRIES);
      return JSON.stringify(answers) === snapshot;
    });
    fc.assert(attempts, { numRuns: 100 });
  });

  it("breaks score ties deterministically by entry id", () => {
    const ranked = rankEntries({}, KB_ENTRIES);
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
    const response = await buildMatchResponse(known("main_goal", "food"), {
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
    const ranked = rankEntries(known("main_goal", "food"), KB_ENTRIES);
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
    const ranked = rankEntries(known("housing_status", "shelter"), KB_ENTRIES);
    const reasons = ranked.flatMap((r) => r.reasons);
    expect(reasons.length).toBeGreaterThan(0);
    // housing_status is pii:true: the answer label must be OMITTED entirely.
    for (const reason of reasons) {
      if (reason.questionId === "housing_status") {
        expect(reason.answerLabel).toBeUndefined();
      }
    }
    const labeled = rankEntries(known("main_goal", "food"), KB_ENTRIES).flatMap(
      (r) => r.reasons,
    );
    expect(labeled.some((reason) => reason.answerLabel === "Food")).toBe(true);
    expect(labeled.some((reason) => reason.answerLabel === "food")).toBe(false);
  });

  it("carries a complete source citation on every reason, requirement, and link", async () => {
    const response = await buildMatchResponse(
      { ...known("main_goal", "food"), ...known("housing_status", "shelter") },
      { explainer: async () => ({ text: "stub", source: "facts" }) },
    );
    expect(response.matches.length).toBe(KB_ENTRIES.length);
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
    const response = await buildMatchResponse({}, {
      explainer: async () => ({ text: "stub", source: "facts" }),
    });
    for (const card of response.matches) {
      const kinds = new Set(card.requirements.map((requirement) => requirement.kind));
      expect(kinds.has("document")).toBe(true);
      expect(kinds.has("step")).toBe(true);
      expect(kinds.has("deadline")).toBe(true);
      // Every shipped sample carries the renewal placeholder deadline.
      expect(kinds.has("renewal")).toBe(true);
    }
  });

  it("frames every card with the honest may-be-worth-pursuing copy", () => {
    expect(MATCH_FRAMING).toBe("This may be worth pursuing.");
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
      const ranked = rankEntries(answers, KB_ENTRIES);
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
    const response = await buildMatchResponse({}, {
      explainer: async () => ({ text: "stub", source: "facts" }),
    });
    const seeded = `${response.matches[0]!.framing} You qualify for this program.`;
    expect(findBannedClaims(seeded).length).toBeGreaterThan(0);
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
  });

  function installChat(content: string): void {
    process.env.MODEL_API_KEY = "sentinel-test-key-never-log";
    setModelTransport(async () => {
      return new Response(
        JSON.stringify({
          id: "chatcmpl-test",
          model: "muse-spark-1.3",
          choices: [
            {
              index: 0,
              finish_reason: "stop",
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

  it("composes fallback copy that stays grounded on every shipped entry", () => {
    for (const entry of KB_ENTRIES) {
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
      explainer: async () => ({ text: "stub", source: "facts" }),
    });
    expect(() => assertNoPiiValuesInMatch(response, answers)).not.toThrow();
  });

  it("bites when a reason would carry a private value", async () => {
    const answers: AnswerMap = {
      date_of_birth: { status: "known", value: "1980-02-03" },
    };
    const poisoned = await buildMatchResponse({}, {
      explainer: async () => ({ text: "stub", source: "facts" }),
    });
    const poisonedCard = {
      ...poisoned.matches[0]!,
      reasons: [
        {
          text: "You told us your date of birth is 1980-02-03.",
          source: poisoned.matches[0]!.reasons[0]?.source ?? {
            entryId: "x",
            entryTitle: "x",
            entryVersion: 1,
            entryStatus: "active" as const,
            sourceUrl: "https://example.org/x",
            retrievedAt: "2026-10-29",
          },
        },
      ],
    };
    expect(() =>
      assertNoPiiValuesInMatch(
        { ...poisoned, matches: [poisonedCard, ...poisoned.matches.slice(1)] },
        answers,
      ),
    ).toThrow();
  });
});
