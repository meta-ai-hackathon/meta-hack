import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  EMPTY_CLIENT_ANSWERS,
  clearClientAnswers,
  deleteClientAnswer,
  hasAnyAnswer,
  parseClientAnswers,
  saveClientAnswer,
  serializeClientAnswers,
  toAnswerMap,
  vaultValues,
  type ClientAnswerRecord,
} from "./client-store";
import { QUESTIONS } from "./spec";
import { firstUnansweredIndex, visibleQuestions } from "./flow";

// Client answer store invariants (HACK-94): where answers live. The
// properties that matter are the ones a bug could silently break: an
// invalid record entering the store, an unknown carrying a lingering
// value, the flow engine landing somewhere different after a save /
// reload cycle, or the purge leaving residue.

const QUESTION_IDS = QUESTIONS.map((question) => question.id);
const PII_IDS = QUESTIONS.filter((question) => question.pii).map(
  (question) => question.id,
);

const statusArb = fc.constantFrom("known", "unknown", "unverified") as fc.Arbitrary<
  "known" | "unknown" | "unverified"
>;
const valueArb = fc.oneof(
  fc.string({ maxLength: 20 }),
  fc.integer(),
  fc.boolean(),
  fc.constant(null),
);

const validRecordArb: fc.Arbitrary<ClientAnswerRecord> = fc
  .record({
    questionId: fc.constantFrom(...QUESTION_IDS),
    status: statusArb,
    provenance: fc.constantFrom(
      "user_supplied",
      "source_verified",
    ) as fc.Arbitrary<"user_supplied" | "source_verified">,
    value: valueArb,
  })
  .map((record) => ({
    ...record,
    // unknown carries no value by contract
    value: record.status === "unknown" ? null : record.value,
  }));

const draftRecordArb: fc.Arbitrary<ClientAnswerRecord> = fc.record({
  questionId: fc.constantFrom(...QUESTION_IDS),
  status: fc.constant("unverified"),
  provenance: fc.constant("ai_drafted"),
  value: valueArb,
});

const anyValidRecordArb = fc.oneof(validRecordArb, draftRecordArb);

function buildState(records: readonly ClientAnswerRecord[]) {
  return records.reduce(
    (state, record) => saveClientAnswer(state, record),
    EMPTY_CLIENT_ANSWERS,
  );
}

describe("save contracts", () => {
  it("rejects records the flow contracts forbid, however they are shaped", () => {
    const base = buildState([]);
    expect(() =>
      saveClientAnswer(base, {
        questionId: "not_a_question",
        status: "known",
        provenance: "user_supplied",
        value: "x",
      }),
    ).toThrow();
    expect(() =>
      saveClientAnswer(base, {
        questionId: QUESTION_IDS[0],
        status: "known",
        provenance: "ai_drafted",
        value: "x",
      }),
    ).toThrow();
    expect(() =>
      saveClientAnswer(base, {
        questionId: QUESTION_IDS[0],
        status: "sideways" as never,
        provenance: "user_supplied",
        value: "x",
      }),
    ).toThrow();
  });

  it("never lets an unknown record carry a value into the store", () => {
    fc.assert(
      fc.property(fc.constantFrom(...QUESTION_IDS), valueArb, (questionId, value) => {
        const state = saveClientAnswer(EMPTY_CLIENT_ANSWERS, {
          questionId,
          status: "unknown",
          provenance: "user_supplied",
          value,
        });
        expect(state[questionId]?.value).toBeNull();
      }),
    );
  });

  it("never mutates the state it was given", () => {
    fc.assert(
      fc.property(fc.array(anyValidRecordArb, { maxLength: 10 }), anyValidRecordArb, (records, next) => {
        const before = buildState(records);
        const snapshot = serializeClientAnswers(before);
        saveClientAnswer(before, next);
        expect(serializeClientAnswers(before)).toBe(snapshot);
      }),
    );
  });
});

describe("flow engine over the client store", () => {
  it("resumes at the first unanswered visible question after a save → serialize → parse cycle", () => {
    fc.assert(
      fc.property(fc.array(anyValidRecordArb, { maxLength: 15 }), (records) => {
        const state = buildState(records);
        const reloaded = parseClientAnswers(serializeClientAnswers(state));
        expect(reloaded).toEqual(state);
        const map = toAnswerMap(reloaded);
        const visible = visibleQuestions(QUESTIONS, map);
        const index = firstUnansweredIndex(visible, map);
        if (index === -1) {
          expect(visible.every((question) => map[question.id] !== undefined)).toBe(true);
        } else {
          expect(map[visible[index].id]).toBeUndefined();
          for (let earlier = 0; earlier < index; earlier += 1) {
            expect(map[visible[earlier].id]).toBeDefined();
          }
        }
      }),
    );
  });
});

describe("on-device vault view", () => {
  it("surfaces exactly the known/unverified pii values and nothing else", () => {
    fc.assert(
      fc.property(fc.array(anyValidRecordArb, { maxLength: 15 }), (records) => {
        const state = buildState(records);
        const values = vaultValues(state, QUESTIONS);
        for (const [questionId, value] of Object.entries(values)) {
          expect(PII_IDS).toContain(questionId);
          expect(state[questionId]?.status).not.toBe("unknown");
          expect(value).not.toBeNull();
        }
        for (const questionId of PII_IDS) {
          const record = state[questionId];
          if (record && record.status !== "unknown" && record.value !== null && record.value !== undefined) {
            expect(values[questionId]).toEqual(record.value);
          } else {
            expect(values[questionId]).toBeUndefined();
          }
        }
        for (const record of Object.values(state)) {
          if (record && !PII_IDS.includes(record.questionId)) {
            expect(values[record.questionId]).toBeUndefined();
          }
        }
      }),
    );
  });
});

describe("purge and deletion", () => {
  it("clearing empties any reachable state completely", () => {
    fc.assert(
      fc.property(fc.array(anyValidRecordArb, { maxLength: 15 }), (records) => {
        const cleared = clearClientAnswers();
        expect(hasAnyAnswer(cleared)).toBe(false);
        expect(toAnswerMap(cleared)).toEqual({});
        expect(vaultValues(cleared, QUESTIONS)).toEqual({});
        void records;
      }),
    );
  });

  it("deleting removes exactly that record and is idempotent", () => {
    fc.assert(
      fc.property(fc.array(anyValidRecordArb, { maxLength: 10 }), fc.constantFrom(...QUESTION_IDS), (records, questionId) => {
        const state = buildState(records);
        const once = deleteClientAnswer(state, questionId);
        expect(once[questionId]).toBeUndefined();
        expect(deleteClientAnswer(once, questionId)).toEqual(once);
        for (const [otherId, record] of Object.entries(state)) {
          if (otherId !== questionId) {
            expect(once[otherId]).toEqual(record);
          }
        }
      }),
    );
  });
});

describe("stored answers", () => {
  it("round-trips any state the save path can produce", () => {
    fc.assert(
      fc.property(fc.array(anyValidRecordArb, { maxLength: 15 }), (records) => {
        const state = buildState(records);
        expect(parseClientAnswers(serializeClientAnswers(state))).toEqual(state);
      }),
    );
  });

  it("never parses an arbitrary blob into a record for an unknown question", () => {
    fc.assert(
      fc.property(fc.string(), (raw) => {
        const state = parseClientAnswers(raw);
        for (const questionId of Object.keys(state)) {
          expect(QUESTION_IDS).toContain(questionId);
        }
      }),
    );
  });

  it("drops invalid records on load instead of repairing them", () => {
    const blob = JSON.stringify({
      records: {
        [QUESTION_IDS[0]]: {
          status: "unknown",
          provenance: "user_supplied",
          value: "lingering",
        },
        [QUESTION_IDS[1]]: {
          status: "known",
          provenance: "ai_drafted",
          value: "mislabeled draft",
        },
        [QUESTION_IDS[2]]: {
          status: "known",
          provenance: "user_supplied",
          value: "fine",
        },
      },
    });
    const state = parseClientAnswers(blob);
    expect(state[QUESTION_IDS[0]]).toBeUndefined();
    expect(state[QUESTION_IDS[1]]).toBeUndefined();
    expect(state[QUESTION_IDS[2]]?.value).toBe("fine");
  });
});
