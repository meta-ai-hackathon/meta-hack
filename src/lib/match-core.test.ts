import fc from "fast-check";
import { beforeAll, describe, expect, it } from "vitest";
import type { AnswerStatus } from "./honesty";
import { KB_ENTRIES, SAMPLE_KB_ENTRIES, type KbEntry } from "./kb";
import type { AnswerMap, StoredAnswer } from "./intake/flow";
import { QUESTIONS, type Question } from "./intake/spec";
import * as core from "./match-core";
import * as server from "./match";
import { setLogSink } from "./telemetry";

// The browser-safe match (HACK-115): match-core.ts builds, with no model
// and no server module, exactly the match the consent-declined server
// route builds, and match.ts still hands every caller the very same
// functions it did before the split.

beforeAll(() => {
  setLogSink(() => undefined);
});

/** The explainer the declined route uses: the entry's own facts, no model call. */
const factsExplainer: server.MatchExplainer = (entry) =>
  Promise.resolve({ text: core.composeFallbackExplanation(entry), source: "facts" });

const ALL_ENTRIES: readonly KbEntry[] = [...SAMPLE_KB_ENTRIES, ...KB_ENTRIES];

/** A value a person could give `question`, in the shape the stores keep it. */
function valueFor(question: Question): fc.Arbitrary<unknown> {
  const options = (question.options ?? []).map((option) => option.value);
  switch (question.type) {
    case "single_select":
      return fc.constantFrom(...options);
    case "multi_select":
      return fc.uniqueArray(fc.constantFrom(...options), { minLength: 1, maxLength: 3 });
    case "number":
      return fc.integer({ min: 0, max: 9 });
    case "boolean":
      return fc.boolean();
    case "date":
      return fc
        .date({ min: new Date("1930-01-01"), max: new Date("2026-10-30"), noInvalidDate: true })
        .map((date) => date.toISOString().slice(0, 10));
    case "text":
    case "address":
      // Free text, including words the knowledge base itself uses.
      return fc.oneof(
        fc.stringMatching(/^[A-Za-z][A-Za-z0-9 .'-]{2,20}$/),
        fc.constantFrom("application", "Mecklenburg", "555-0100", "person@example.com"),
      );
  }
}

const statusArb: fc.Arbitrary<AnswerStatus> = fc.constantFrom("known", "unknown", "unverified");

function storedFor(question: Question): fc.Arbitrary<StoredAnswer> {
  return fc
    .tuple(statusArb, valueFor(question))
    .map(([status, value]) => ({ status, value: status === "unknown" ? null : value }));
}

/** Any subset of the spec's questions answered, every status represented. */
const answerMapArb: fc.Arbitrary<AnswerMap> = fc.record(
  Object.fromEntries(QUESTIONS.map((question) => [question.id, storedFor(question)])),
  { requiredKeys: [] },
);

describe("the facts-only match (match-core.ts)", () => {
  it("is exactly what the declined server build returns, for any answers", async () => {
    await fc.assert(
      fc.asyncProperty(answerMapArb, fc.boolean(), async (answers, allEntries) => {
        const entries = allEntries ? ALL_ENTRIES : KB_ENTRIES;
        const device = core.buildFactsMatchResponse(answers, entries);
        const routed = await server.buildMatchResponse(answers, {
          entries,
          explainer: factsExplainer,
        });
        expect(device).toEqual(routed);
      }),
      { numRuns: 200 },
    );
  });

  it("explains every card from its entry's facts", () => {
    fc.assert(
      fc.property(answerMapArb, (answers) => {
        const response = core.buildFactsMatchResponse(answers, ALL_ENTRIES);
        for (const card of response.matches) {
          const entry = ALL_ENTRIES.find((candidate) => candidate.id === card.entryId)!;
          expect(card.explanation).toEqual({
            text: core.composeFallbackExplanation(entry),
            source: "facts",
          });
          expect(card.score).toBeGreaterThan(0);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("never puts a private answer's value into the match", () => {
    // Private free-text and date answers drawn so they can't coincide with
    // anything the knowledge base or the spec prints (its dates are all in
    // 2026), so any appearance in the match would be the answer itself.
    const privateText = fc.stringMatching(/^PRIV[A-Z0-9]{8}$/);
    const privateDate = fc
      .date({ min: new Date("1930-01-01"), max: new Date("1999-12-31"), noInvalidDate: true })
      .map((date) => date.toISOString().slice(0, 10));
    const privateFirst = fc.record(
      Object.fromEntries(
        QUESTIONS.map((question) => {
          if (question.pii && (question.type === "text" || question.type === "date")) {
            const value = question.type === "text" ? privateText : privateDate;
            return [
              question.id,
              fc.tuple(statusArb, value).map(([status, value]) => ({
                status,
                value: status === "unknown" ? null : value,
              })),
            ];
          }
          return [question.id, storedFor(question)];
        }),
      ),
      { requiredKeys: [] },
    ) as fc.Arbitrary<AnswerMap>;
    fc.assert(
      fc.property(privateFirst, (answers) => {
        const shown = JSON.stringify(core.buildFactsMatchResponse(answers, ALL_ENTRIES));
        for (const question of QUESTIONS) {
          const value = answers[question.id]?.value;
          const drawnPrivate = question.pii && (question.type === "text" || question.type === "date");
          if (drawnPrivate && typeof value === "string") {
            expect(shown).not.toContain(value);
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  it("is the production default when no entries are given", () => {
    fc.assert(
      fc.property(answerMapArb, (answers) => {
        expect(core.buildFactsMatchResponse(answers)).toEqual(
          core.buildFactsMatchResponse(answers, KB_ENTRIES),
        );
      }),
      { numRuns: 50 },
    );
  });
});

describe("match.ts after the split", () => {
  it("re-exports the moved functions and constants themselves, not copies", () => {
    expect(server.MATCH_FRAMING).toBe(core.MATCH_FRAMING);
    expect(server.EXPLANATION_FRAMING).toBe(core.EXPLANATION_FRAMING);
    expect(server.scoreEntry).toBe(core.scoreEntry);
    expect(server.rankEntries).toBe(core.rankEntries);
    expect(server.buildRequirements).toBe(core.buildRequirements);
    expect(server.buildToResolve).toBe(core.buildToResolve);
    expect(server.composeFallbackExplanation).toBe(core.composeFallbackExplanation);
    expect(server.matchCardText).toBe(core.matchCardText);
  });
});
