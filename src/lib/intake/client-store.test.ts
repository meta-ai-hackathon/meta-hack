import { webcrypto } from "node:crypto";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  CLIENT_ANSWERS_KEY,
  EMPTY_CLIENT_ANSWERS,
  clearClientAnswers,
  deleteClientAnswer,
  hasAnyAnswer,
  loadClientAnswers,
  openSealed,
  parseClientAnswers,
  removeStoredAnswers,
  saveClientAnswer,
  saveClientAnswers,
  sealForStorage,
  serializeClientAnswers,
  toAnswerMap,
  vaultValues,
  type ClientAnswerRecord,
  type ClientKeyProvider,
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

// --- sealed persistence (PR #52) -------------------------------------------------
// Node's WebCrypto stands in for the browser's; the seal core takes the
// SubtleCrypto explicitly, so this is the real algorithm, not a mock.

const subtle = webcrypto.subtle as unknown as SubtleCrypto;

async function testKey(): Promise<CryptoKey> {
  return (await subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ])) as CryptoKey;
}

// One stable key per provider instance, like the real device key: save and
// load must see the SAME key or every load reads as a foreign ciphertext.
let sharedKey: Promise<CryptoKey> | null = null;
const testKeys: ClientKeyProvider = {
  getKey: () => (sharedKey ??= testKey()),
};
const noKeys: ClientKeyProvider = { getKey: async () => null };

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
  };
}

describe("sealed persistence", () => {
  it("the stored blob contains no plaintext answer values", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(anyValidRecordArb, { maxLength: 10 }), async (records) => {
        const storage = memoryStorage();
        const state = buildState(records);
        expect(await saveClientAnswers(state, storage, testKeys)).toBe(true);
        const stored = storage.getItem(CLIENT_ANSWERS_KEY);
        expect(stored).not.toBeNull();
        expect(stored!.startsWith("sealed1.")).toBe(true);
        for (const record of Object.values(state)) {
          if (record && typeof record.value === "string" && record.value.length >= 4) {
            expect(stored).not.toContain(record.value);
          }
        }
        expect(await loadClientAnswers(storage, testKeys)).toEqual(state);
      }),
    );
  });

  it("seal/open round-trips and fails closed on tampering, wrong keys and legacy plaintext", async () => {
    const key = await testKey();
    const other = await testKey();
    await fc.assert(
      fc.asyncProperty(fc.string({ maxLength: 200 }), async (plaintext) => {
        const sealed = await sealForStorage(plaintext, key, subtle);
        expect(await openSealed(sealed, key, subtle)).toBe(plaintext);
        expect(await openSealed(sealed, other, subtle)).toBeNull();
        expect(await openSealed(plaintext, key, subtle)).toBeNull();
        // Tamper the IV's first base64 character: a different nonce must
        // fail GCM authentication, never decrypt to something plausible.
        const ivStart = "sealed1.".length;
        const tampered =
          sealed.slice(0, ivStart) +
          (sealed[ivStart] === "A" ? "B" : "A") +
          sealed.slice(ivStart + 1);
        expect(await openSealed(tampered, key, subtle)).toBeNull();
      }),
    );
  });

  it("without a device key nothing is written and loads read empty", async () => {
    const storage = memoryStorage();
    const state = buildState([
      {
        questionId: QUESTION_IDS[0],
        status: "known",
        provenance: "user_supplied",
        value: "kept-off-disk",
      },
    ]);
    expect(await saveClientAnswers(state, storage, noKeys)).toBe(false);
    expect(storage.getItem(CLIENT_ANSWERS_KEY)).toBeNull();
    expect(await loadClientAnswers(storage, noKeys)).toEqual(EMPTY_CLIENT_ANSWERS);
  });

  it("save and purge report failure honestly when storage refuses", async () => {
    const refusing = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    };
    const state = buildState([]);
    expect(await saveClientAnswers(state, refusing, testKeys)).toBe(false);
    expect(removeStoredAnswers(refusing)).toBe(false);
    // A purge that leaves the slot readable reports false too.
    const sticky = {
      getItem: () => "sealed1.stays",
      setItem: () => undefined,
      removeItem: () => undefined,
    };
    expect(removeStoredAnswers(sticky)).toBe(false);
  });
});

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
  it("saving then purging storage leaves nothing loadable behind", async () => {
    // PR #52 P3: the old clear property discarded its generated state and
    // proved nothing. This exercises the real storage half: save a built
    // state, purge, and assert the load comes back empty.
    await fc.assert(
      fc.asyncProperty(fc.array(anyValidRecordArb, { maxLength: 10 }), async (records) => {
        const storage = memoryStorage();
        const state = buildState(records);
        expect(await saveClientAnswers(state, storage, testKeys)).toBe(true);
        expect(removeStoredAnswers(storage)).toBe(true);
        expect(storage.getItem(CLIENT_ANSWERS_KEY)).toBeNull();
        expect(await loadClientAnswers(storage, testKeys)).toEqual(
          EMPTY_CLIENT_ANSWERS,
        );
      }),
    );
  });

  it("clearing empties any reachable state completely", () => {
    fc.assert(
      fc.property(fc.array(anyValidRecordArb, { maxLength: 15 }), (records) => {
        const state = buildState(records);
        expect(hasAnyAnswer(state)).toBe(records.length > 0);
        const cleared = clearClientAnswers();
        expect(hasAnyAnswer(cleared)).toBe(false);
        expect(toAnswerMap(cleared)).toEqual({});
        expect(vaultValues(cleared, QUESTIONS)).toEqual({});
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
