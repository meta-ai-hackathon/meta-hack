import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { DeviceKv, KvGuard } from "../device-kv";
import {
  EMPTY_CLIENT_ANSWERS,
  openSealed,
  saveClientAnswer,
  sealForStorage,
  type ClientAnswerRecord,
  type ClientAnswerState,
} from "./client-store";
import {
  DEVICE_ANSWERS_CRYPTO_KEY_KEY,
  DEVICE_ANSWERS_ENVELOPE_KEY,
  DEVICE_SAVE_ATTEMPTS,
  DEVICE_SESSION_ENVELOPE_KEY,
  isSealingKey,
  loadDeviceAnswers,
  openDeviceAnswerStore,
  purgeDeviceAnswers,
  recordDeviceAnswer,
  type DeviceAnswerStoreDeps,
} from "./device-answer-store";
import { loadRampartSession } from "./rampart-session-store";
import { QUESTIONS } from "./spec";

// The durable on-device answer store (HACK-99). The properties that matter
// are the ones a bug could silently break: an answer reaching storage in
// plaintext, a reload not getting back exactly what was saved, a slower tab
// overwriting another tab's answer or undoing a purge, an invalid answer
// entering storage, and a purge reporting success while anything remains.

/** In-memory DeviceKv with the adapter's guard semantics and an interleaving hook. */
function memoryKv(options: { beforeGuardedWrite?: (store: Map<string, unknown>) => void } = {}) {
  const store = new Map<string, unknown>();
  const counts = { writes: 0, deletes: 0 };
  const kv: DeviceKv = {
    getMany: async (keys) => keys.map((key) => store.get(key)),
    setMany: async (entries, guard?: KvGuard) => {
      if (guard !== undefined) {
        // Another tab's transaction may land between this save's read and
        // its write; the guard then decides inside the write's transaction.
        options.beforeGuardedWrite?.(store);
        if (guard.keep(store.get(guard.key))) {
          return false;
        }
      }
      for (const [key, value] of entries) {
        store.set(key, value);
      }
      counts.writes += 1;
      return true;
    },
    deleteMany: async (keys, guard?: KvGuard) => {
      if (guard !== undefined && guard.keep(store.get(guard.key))) {
        return false;
      }
      for (const key of keys) {
        store.delete(key);
      }
      counts.deletes += 1;
      return true;
    },
  };
  return { kv, store, counts };
}

function deps(kv: DeviceKv): DeviceAnswerStoreDeps {
  return { kv, subtle: crypto.subtle };
}

const TEXT_PII = QUESTIONS.filter((question) => question.type === "text" && question.pii);
const QUESTION_IDS = QUESTIONS.map((question) => question.id);

/** A valid record whose value is a distinctive marker string (pii text questions). */
const markedRecordArb: fc.Arbitrary<ClientAnswerRecord> = fc
  .record({
    question: fc.constantFrom(...TEXT_PII),
    marker: fc.stringMatching(/^[A-Za-z]{6,12}$/),
    status: fc.constantFrom("known", "unverified") as fc.Arbitrary<"known" | "unverified">,
  })
  .map(({ question, marker, status }) => ({
    questionId: question.id,
    status,
    provenance: "user_supplied" as const,
    value: `MARK-${marker}`,
  }));

/** An opaque non-blank Rampart session serialization: pure payload here. */
const sessionTextArb = fc
  .string({ minLength: 1, maxLength: 80 })
  .filter((text) => text.trim() !== "");

const recordArb: fc.Arbitrary<ClientAnswerRecord> = fc.oneof(
  markedRecordArb,
  fc.constantFrom(...QUESTION_IDS).map((questionId) => ({
    questionId,
    status: "unknown" as const,
    provenance: "user_supplied" as const,
    value: null,
  })),
);

function fold(records: readonly ClientAnswerRecord[]): ClientAnswerState {
  return records.reduce<ClientAnswerState>(
    (state, record) => saveClientAnswer(state, record),
    EMPTY_CLIENT_ANSWERS,
  );
}

describe("saving and reloading", () => {
  it("a reload reads back exactly the answers saved, one by one", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(recordArb, { minLength: 1, maxLength: 8 }), async (records) => {
        const { kv } = memoryKv();
        let stored = false;
        for (const record of records) {
          const result = await recordDeviceAnswer(deps(kv), record, { expectStored: stored });
          expect(result.status).toBe("saved");
          stored = true;
        }
        const loaded = await loadDeviceAnswers(deps(kv));
        expect(loaded.status).toBe("ok");
        expect(loaded.state).toEqual(fold(records));
      }),
      { numRuns: 40 },
    );
  });

  it("nothing saved is ever readable in storage: no value, no question id", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(markedRecordArb, { minLength: 1, maxLength: 6 }), async (records) => {
        const { kv, store } = memoryKv();
        let stored = false;
        for (const record of records) {
          await recordDeviceAnswer(deps(kv), record, { expectStored: stored });
          stored = true;
        }
        const envelope = store.get(DEVICE_ANSWERS_ENVELOPE_KEY);
        expect(typeof envelope).toBe("string");
        for (const record of records) {
          expect(envelope as string).not.toContain(String(record.value));
          expect(envelope as string).not.toContain(record.questionId);
        }
        expect([...store.keys()].sort()).toEqual(
          [DEVICE_ANSWERS_CRYPTO_KEY_KEY, DEVICE_ANSWERS_ENVELOPE_KEY].sort(),
        );
      }),
      { numRuns: 30 },
    );
  });

  it("keeps one non-extractable key for the store's life and seals each save afresh", async () => {
    const { kv, store } = memoryKv();
    const [first, second] = fc.sample(markedRecordArb, 2);
    await recordDeviceAnswer(deps(kv), first, { expectStored: false });
    const key = store.get(DEVICE_ANSWERS_CRYPTO_KEY_KEY) as CryptoKey;
    const envelope = store.get(DEVICE_ANSWERS_ENVELOPE_KEY);
    expect(isSealingKey(key)).toBe(true);
    await expect(crypto.subtle.exportKey("raw", key)).rejects.toThrow();
    await recordDeviceAnswer(deps(kv), second, { expectStored: true });
    expect(store.get(DEVICE_ANSWERS_CRYPTO_KEY_KEY)).toBe(key);
    expect(store.get(DEVICE_ANSWERS_ENVELOPE_KEY)).not.toBe(envelope);
  });

  it("an unknown answer keeps no value, even over an earlier known one", async () => {
    const { kv } = memoryKv();
    const [known] = fc.sample(markedRecordArb, 1);
    await recordDeviceAnswer(deps(kv), known, { expectStored: false });
    await recordDeviceAnswer(
      deps(kv),
      { questionId: known.questionId, status: "unknown", provenance: "user_supplied", value: null },
      { expectStored: true },
    );
    const loaded = await loadDeviceAnswers(deps(kv));
    expect(loaded.state[known.questionId]).toEqual({
      questionId: known.questionId,
      status: "unknown",
      provenance: "user_supplied",
      value: null,
    });
  });
});

describe("invalid answers never reach storage", () => {
  it("rejects records the client store forbids before reading or writing anything", async () => {
    const invalid: ClientAnswerRecord[] = [
      { questionId: "not_a_question", status: "known", provenance: "user_supplied", value: "x" },
      { questionId: "constructor", status: "known", provenance: "user_supplied", value: "x" },
      {
        questionId: TEXT_PII[0].id,
        status: "known",
        provenance: "ai_drafted",
        value: "drafted",
      },
      {
        questionId: TEXT_PII[0].id,
        status: "maybe" as "known",
        provenance: "user_supplied",
        value: "x",
      },
    ];
    for (const record of invalid) {
      const { kv, store, counts } = memoryKv();
      await expect(recordDeviceAnswer(deps(kv), record, { expectStored: false })).rejects.toThrow();
      expect(counts.writes).toBe(0);
      expect(store.size).toBe(0);
    }
  });
});

describe("several tabs", () => {
  it("a save that loses a race to another tab's save lands on top of it: no answer is lost", async () => {
    await fc.assert(
      fc.asyncProperty(markedRecordArb, markedRecordArb, async (mine, theirs) => {
        fc.pre(mine.questionId !== theirs.questionId);
        // The other tab's save lands between this save's read and its
        // write: its key and its sealed answer replace what this save read.
        const theirKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
          "encrypt",
          "decrypt",
        ]);
        const theirEnvelope = await sealForStorage(
          JSON.stringify({ records: { [theirs.questionId]: theirs } }),
          theirKey,
          crypto.subtle,
        );
        let injected = false;
        const racing = memoryKv({
          beforeGuardedWrite: (store) => {
            if (!injected) {
              injected = true;
              store.set(DEVICE_ANSWERS_CRYPTO_KEY_KEY, theirKey);
              store.set(DEVICE_ANSWERS_ENVELOPE_KEY, theirEnvelope);
            }
          },
        });
        const result = await recordDeviceAnswer(deps(racing.kv), mine, { expectStored: false });
        expect(result.status).toBe("saved");
        const loaded = await loadDeviceAnswers(deps(racing.kv));
        expect(loaded.state[mine.questionId]?.value).toBe(mine.value);
        expect(loaded.state[theirs.questionId]?.value).toBe(theirs.value);
        // The other tab's key stays: the pair on the device still matches.
        expect(racing.store.get(DEVICE_ANSWERS_CRYPTO_KEY_KEY)).toBe(theirKey);
      }),
      { numRuns: 20 },
    );
  });

  it("retries under a usable key a concurrent first save of the session table lands (review P2)", async () => {
    // A Rampart session's first save claims the key with the SESSION
    // envelope: the answers envelope looks unchanged to this save, so the
    // anchor of a generated-key write is the key slot itself. The winner's
    // key is kept, never replaced, and the retry lands the answers under
    // it — no envelope is left sealed under a displaced key.
    const theirKey = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
    const sessionText = '{"version":1,"entries":[]}';
    const theirSession = await sealForStorage(sessionText, theirKey, crypto.subtle);
    let injected = false;
    const racing = memoryKv({
      beforeGuardedWrite: (store) => {
        if (!injected) {
          injected = true;
          store.set(DEVICE_ANSWERS_CRYPTO_KEY_KEY, theirKey);
          store.set(DEVICE_SESSION_ENVELOPE_KEY, theirSession);
        }
      },
    });
    const [record] = fc.sample(markedRecordArb, 1);
    const result = await recordDeviceAnswer(deps(racing.kv), record, {
      expectStored: false,
    });
    expect(result.status).toBe("saved");
    expect(racing.store.get(DEVICE_ANSWERS_CRYPTO_KEY_KEY)).toBe(theirKey);
    const loaded = await loadDeviceAnswers(deps(racing.kv));
    expect(loaded.state[record.questionId]?.value).toBe(record.value);
    expect(await loadRampartSession(deps(racing.kv))).toEqual({
      status: "ok",
      serialized: sessionText,
    });
  });

  it("whatever the answer and the session serialization, a session save claiming the key between this save's read and its write leaves both envelopes openable", async () => {
    await fc.assert(
      fc.asyncProperty(
        markedRecordArb,
        sessionTextArb,
        async (record, sessionText) => {
          const theirKey = await crypto.subtle.generateKey(
            { name: "AES-GCM", length: 256 },
            false,
            ["encrypt", "decrypt"],
          );
          const theirSession = await sealForStorage(sessionText, theirKey, crypto.subtle);
          let injected = false;
          const racing = memoryKv({
            beforeGuardedWrite: (store) => {
              if (!injected) {
                injected = true;
                store.set(DEVICE_ANSWERS_CRYPTO_KEY_KEY, theirKey);
                store.set(DEVICE_SESSION_ENVELOPE_KEY, theirSession);
              }
            },
          });
          const result = await recordDeviceAnswer(deps(racing.kv), record, {
            expectStored: false,
          });
          // The abort-and-retry semantics: the save lands under the session
          // writer's key, the session envelope still opens with every
          // serialization, and the answer is in the loaded answers.
          expect(result.status).toBe("saved");
          expect(racing.store.get(DEVICE_ANSWERS_CRYPTO_KEY_KEY)).toBe(theirKey);
          const loaded = await loadDeviceAnswers(deps(racing.kv));
          expect(loaded.state[record.questionId]?.value).toBe(record.value);
          expect(await loadRampartSession(deps(racing.kv))).toEqual({
            status: "ok",
            serialized: sessionText,
          });
        },
      ),
      { numRuns: 20 },
    );
  });

  it("a delete in another tab is never undone by a slower save", async () => {
    const [first, second] = fc.sample(markedRecordArb, 2);
    for (const expectStored of [true, false]) {
      let purgeNow = false;
      const racing = memoryKv({
        beforeGuardedWrite: (store) => {
          if (purgeNow) {
            purgeNow = false;
            store.delete(DEVICE_ANSWERS_ENVELOPE_KEY);
            store.delete(DEVICE_ANSWERS_CRYPTO_KEY_KEY);
          }
        },
      });
      expect((await recordDeviceAnswer(deps(racing.kv), first, { expectStored: false })).status).toBe(
        "saved",
      );
      // The other tab purges between this save's read and its write. Even a
      // page that did not know answers were stored stops, because its own
      // read saw them.
      purgeNow = true;
      const result = await recordDeviceAnswer(deps(racing.kv), second, { expectStored });
      expect(result.status).toBe("purged");
      expect(racing.store.size).toBe(0);
    }
  });

  it("a purge between a generated-key save's read and its write is never undone (review P2)", async () => {
    for (const expectStored of [false, true]) {
      // Answers are on the device but the key slot is garbage, so this
      // save walks the generated-key path; the other tab purges on the
      // SECOND guarded write - after the key claim has committed, in
      // exactly the window the two-write design protects (review P3).
      let purgeArmed = false;
      let guardedWrites = 0;
      const racing = memoryKv({
        beforeGuardedWrite: (store) => {
          if (purgeArmed) {
            guardedWrites += 1;
            if (guardedWrites === 2) {
              purgeArmed = false;
              store.delete(DEVICE_ANSWERS_ENVELOPE_KEY);
              store.delete(DEVICE_SESSION_ENVELOPE_KEY);
              store.delete(DEVICE_ANSWERS_CRYPTO_KEY_KEY);
            }
          }
        },
      });
      racing.store.set(DEVICE_ANSWERS_ENVELOPE_KEY, "sealed1.deadbeef.x");
      racing.store.set(DEVICE_ANSWERS_CRYPTO_KEY_KEY, "not-a-key");
      const [record] = fc.sample(markedRecordArb, 1);
      purgeArmed = true;
      const result = await recordDeviceAnswer(deps(racing.kv), record, { expectStored });
      expect(result.status).toBe("purged");
      // Nothing comes back: no answers envelope, no session envelope. The
      // claimed key may remain — it holds no data and becomes the next
      // legitimate sealing key if the person saves again.
      expect(racing.store.get(DEVICE_ANSWERS_ENVELOPE_KEY)).toBeUndefined();
      expect(racing.store.get(DEVICE_SESSION_ENVELOPE_KEY)).toBeUndefined();
    }
  });

  it("whatever the answer, a purge landing inside a generated-key save wins (review P2)", async () => {
    await fc.assert(
      fc.asyncProperty(markedRecordArb, fc.boolean(), async (record, expectStored) => {
        // A purge counter: only when the SECOND guarded write of the
        // racing save fires does the purge run, so the key claim has
        // committed and the accepted window is exercised (review P3).
        let armPurge = false;
        let armedWrites = 0;
        const racing = memoryKv({
          beforeGuardedWrite: (store) => {
            if (armPurge) {
              armedWrites += 1;
              if (armedWrites === 2) {
                armPurge = false;
                store.delete(DEVICE_ANSWERS_ENVELOPE_KEY);
                store.delete(DEVICE_SESSION_ENVELOPE_KEY);
                store.delete(DEVICE_ANSWERS_CRYPTO_KEY_KEY);
              }
            }
          },
        });
        // The device holds answers sealed under a key this page cannot
        // use: the next save generates a key, and the purge races that
        // save's envelope write.
        const [prior] = fc.sample(markedRecordArb, 1);
        // The prior save goes through the same kv, with the arm flag off.
        const priorSave = await recordDeviceAnswer(deps(racing.kv), prior, {
          expectStored: false,
        });
        expect(priorSave.status).toBe("saved");
        racing.store.set(DEVICE_ANSWERS_CRYPTO_KEY_KEY, "not-a-key");
        armPurge = true;
        const result = await recordDeviceAnswer(deps(racing.kv), record, { expectStored });
        expect(result.status).toBe("purged");
        expect(racing.store.get(DEVICE_ANSWERS_ENVELOPE_KEY)).toBeUndefined();
        expect(racing.store.get(DEVICE_SESSION_ENVELOPE_KEY)).toBeUndefined();
      }),
      { numRuns: 20 },
    );
  });
  it("a page that knew answers were stored stops when it finds them gone", async () => {
    const { kv, store } = memoryKv();
    const [record] = fc.sample(markedRecordArb, 1);
    const result = await recordDeviceAnswer(deps(kv), record, { expectStored: true });
    expect(result.status).toBe("purged");
    expect(store.size).toBe(0);
  });

  it("gives up without writing when other tabs keep winning", async () => {
    let theirs = 0;
    // The competing tab claims the shared key slot with a usable key of
    // its own every time (a real writer always writes a usable key with
    // its envelope): the generated-key write's anchor is that slot
    // (HACK-107 review P2), so this save stops again and again.
    const foreignKey = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
    const racing = memoryKv({
      beforeGuardedWrite: (store) => {
        theirs += 1;
        store.set(DEVICE_ANSWERS_ENVELOPE_KEY, `sealed1.other-tab-${theirs}.x`);
        store.set(DEVICE_ANSWERS_CRYPTO_KEY_KEY, foreignKey);
      },
    });
    const [record] = fc.sample(markedRecordArb, 1);
    const result = await recordDeviceAnswer(deps(racing.kv), record, { expectStored: false });
    expect(result.status).toBe("busy");
    expect(theirs).toBe(DEVICE_SAVE_ATTEMPTS);
    expect(racing.counts.writes).toBe(0);
  });
});

describe("what cannot be opened", () => {
  it("reads as unreadable, is left in place, and the next save replaces it under the SAME key, never orphaning the shared key", async () => {
    const unreadable: unknown[] = [
      "not-an-envelope",
      "sealed1.@@@.###",
      { not: "a string" },
      // A real envelope sealed under a key that is not the stored one.
      await sealForStorage(
        JSON.stringify({ records: {} }),
        await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
          "encrypt",
          "decrypt",
        ]),
        crypto.subtle,
      ),
    ];
    for (const envelope of unreadable) {
      const { kv, store } = memoryKv();
      const strayKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
        "encrypt",
        "decrypt",
      ]);
      store.set(DEVICE_ANSWERS_ENVELOPE_KEY, envelope);
      store.set(DEVICE_ANSWERS_CRYPTO_KEY_KEY, strayKey);
      const loaded = await loadDeviceAnswers(deps(kv));
      expect(loaded).toEqual({ status: "unreadable", state: EMPTY_CLIENT_ANSWERS });
      expect(store.get(DEVICE_ANSWERS_ENVELOPE_KEY)).toBe(envelope);

      const [record] = fc.sample(markedRecordArb, 1);
      // The same stored key also seals the Rampart session envelope: the
      // save must REUSE the key and replace only the answers envelope, or
      // the session would be orphaned (review P2) and its token ordinals
      // would restart against server history still holding old tokens.
      const straySession = await sealForStorage(
        JSON.stringify({ version: 1, entries: [] }),
        strayKey,
        crypto.subtle,
      );
      store.set(DEVICE_SESSION_ENVELOPE_KEY, straySession);
      const saved = await recordDeviceAnswer(deps(kv), record, { expectStored: false });
      expect(saved).toEqual({ status: "saved", state: fold([record]) });
      expect(store.get(DEVICE_ANSWERS_CRYPTO_KEY_KEY)).toBe(strayKey);
      expect(
        await openSealed(straySession, strayKey, crypto.subtle),
      ).toBe(JSON.stringify({ version: 1, entries: [] }));
      expect((await loadDeviceAnswers(deps(kv))).state).toEqual(fold([record]));
    }
  });

  it("replaces a garbage key slot like an empty slot (review P3)", async () => {
    const { kv, store } = memoryKv();
    store.set(DEVICE_ANSWERS_CRYPTO_KEY_KEY, "not-a-key");
    const [record] = fc.sample(markedRecordArb, 1);
    const saved = await recordDeviceAnswer(deps(kv), record, { expectStored: false });
    expect(saved.status).toBe("saved");
    // The generated key is written WITH the envelope it sealed: the slot no
    // longer holds garbage, and the device pair matches.
    expect(isSealingKey(store.get(DEVICE_ANSWERS_CRYPTO_KEY_KEY))).toBe(true);
    expect((await loadDeviceAnswers(deps(kv))).state).toEqual(fold([record]));
  });

  it("an extractable or non-AES key is never used to open or seal", async () => {
    const extractable = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
      "encrypt",
      "decrypt",
    ]);
    expect(isSealingKey(extractable)).toBe(false);
    expect(isSealingKey({ type: "secret", extractable: false, algorithm: { name: "AES-CBC" }, usages: ["encrypt", "decrypt"] })).toBe(false);
    expect(isSealingKey(null)).toBe(false);
    const { kv, store } = memoryKv();
    store.set(DEVICE_ANSWERS_CRYPTO_KEY_KEY, extractable);
    const [record] = fc.sample(markedRecordArb, 1);
    await recordDeviceAnswer(deps(kv), record, { expectStored: false });
    expect(store.get(DEVICE_ANSWERS_CRYPTO_KEY_KEY)).not.toBe(extractable);
    expect(isSealingKey(store.get(DEVICE_ANSWERS_CRYPTO_KEY_KEY))).toBe(true);
  });
});

describe("purge", () => {
  it("deletes the key and the answers together and confirms nothing is left", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(markedRecordArb, { minLength: 1, maxLength: 5 }), async (records) => {
        const { kv, store } = memoryKv();
        let stored = false;
        for (const record of records) {
          await recordDeviceAnswer(deps(kv), record, { expectStored: stored });
          stored = true;
        }
        expect(await purgeDeviceAnswers(deps(kv))).toBe(true);
        expect(store.size).toBe(0);
        expect(await loadDeviceAnswers(deps(kv))).toEqual({
          status: "none",
          state: EMPTY_CLIENT_ANSWERS,
        });
        // Purging again is fine: nothing is there.
        expect(await purgeDeviceAnswers(deps(kv))).toBe(true);
      }),
      { numRuns: 20 },
    );
  });

  it("never reports success when storage refuses or anything lingers", async () => {
    const refusing: DeviceKv = {
      getMany: async () => [undefined, undefined],
      setMany: async () => true,
      deleteMany: async () => {
        throw new Error("storage refused");
      },
    };
    expect(await purgeDeviceAnswers(deps(refusing))).toBe(false);

    const sticky: DeviceKv = {
      getMany: async () => ["sealed1.still.here", undefined],
      setMany: async () => true,
      deleteMany: async () => true,
    };
    expect(await purgeDeviceAnswers(deps(sticky))).toBe(false);

    const unreadable: DeviceKv = {
      getMany: async () => {
        throw new Error("read failed");
      },
      setMany: async () => true,
      deleteMany: async () => true,
    };
    expect(await purgeDeviceAnswers(deps(unreadable))).toBe(false);
  });
});

describe("openDeviceAnswerStore", () => {
  it("tells a browser that can't store apart from storage that failed, and wraps what opens", async () => {
    const { kv } = memoryKv();
    expect(await openDeviceAnswerStore(async () => kv, () => false)).toEqual({ status: "unsupported" });
    expect(await openDeviceAnswerStore(async () => null, () => true)).toEqual({ status: "failed" });
    expect(
      await openDeviceAnswerStore(() => Promise.reject(new Error("blocked")), () => true),
    ).toEqual({ status: "failed" });
    const opened = await openDeviceAnswerStore(async () => kv, () => true);
    expect(opened).toEqual({ status: "ok", store: { kv, subtle: crypto.subtle } });
  });
});
