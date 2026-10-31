import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEVICE_STORAGE_TIMEOUT_MS, type DeviceKv, type KvGuard } from "../device-kv";
import { findBannedClaims } from "../honesty";
import { canonicalAnswerValue } from "./answer-input";
import { buildClientState } from "./client-state";
import { EMPTY_CLIENT_ANSWERS, toAnswerMap } from "./client-store";
import {
  DEVICE_ANSWERS_CRYPTO_KEY_KEY,
  DEVICE_ANSWERS_ENVELOPE_KEY,
  type DeviceAnswerStoreOpen,
} from "./device-answer-store";
import {
  DEVICE_INTAKE_COPY,
  answerNotice,
  answerOnDevice,
  deleteDeviceIntake,
  keepingBlurb,
  keepsAnswers,
  loadDeviceIntake,
  privateAnswerNote,
  refreshDeviceIntake,
  saveForLaterNotice,
  type DeviceIntake,
} from "./device-intake";
import { firstUnansweredIndex, visibleQuestions } from "./flow";
import { QUESTIONS, QUESTION_BY_ID, type Question } from "./spec";

// The step-by-step page's on-device intake (HACK-99): a whole journey runs
// without one network request, resumes after a reload exactly where the
// flow engine says, checks answers as the server does, and tells the
// person the truth about what the browser kept and what was deleted, in
// every storage failure the browser can produce.

function memoryKv() {
  const store = new Map<string, unknown>();
  const kv: DeviceKv = {
    getMany: async (keys) => keys.map((key) => store.get(key)),
    setMany: async (entries, guard?: KvGuard) => {
      if (guard !== undefined && guard.keep(store.get(guard.key))) {
        return false;
      }
      for (const [key, value] of entries) {
        store.set(key, value);
      }
      return true;
    },
    deleteMany: async (keys, guard?: KvGuard) => {
      if (guard !== undefined && guard.keep(store.get(guard.key))) {
        return false;
      }
      for (const key of keys) {
        store.delete(key);
      }
      return true;
    },
  };
  return { kv, store };
}

function opener(kv: DeviceKv): () => Promise<DeviceAnswerStoreOpen> {
  return async () => ({ status: "ok", store: { kv, subtle: crypto.subtle } });
}
const unsupported = async (): Promise<DeviceAnswerStoreOpen> => ({ status: "unsupported" });
const failed = async (): Promise<DeviceAnswerStoreOpen> => ({ status: "failed" });

const noPersist = async () => false;

/** A valid answer for any question type, as the page's controls produce it. */
function validDraft(question: Question): unknown {
  switch (question.type) {
    case "text":
    case "address":
      return "  Some answer  ";
    case "number":
      return "3";
    case "boolean":
      return true;
    case "date":
      return "1990-04-02";
    case "single_select":
      return question.options![0].value;
    case "multi_select":
      return [question.options![0].value];
  }
}

/** Answer the first `count` visible questions, as one visit would. */
async function answerFirst(intake: DeviceIntake, count: number): Promise<DeviceIntake> {
  let current = intake;
  for (let i = 0; i < count; i += 1) {
    const question = current.view.questions[current.view.currentIndex ?? 0];
    const result = await answerOnDevice(current, question.id, "known", validDraft(QUESTION_BY_ID[question.id]), noPersist);
    expect(result.kind).toBe("saved");
    if (result.kind !== "saved") {
      throw new Error("not saved");
    }
    current = result.intake;
  }
  return current;
}

let fetchSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchSpy = vi.fn(() => Promise.reject(new Error("no network on the device path")));
  vi.stubGlobal("fetch", fetchSpy);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("a whole journey on the device", () => {
  it("answers everything, resumes after reloads, and deletes, with zero network requests", async () => {
    const { kv, store } = memoryKv();
    const loaded = await loadDeviceIntake(opener(kv));
    expect(loaded.notice).toBe("");
    let intake = loaded.intake;
    expect(keepsAnswers(intake)).toBe(true);
    let steps = 0;
    while (intake.view.currentIndex !== null && steps < 200) {
      steps += 1;
      const question = intake.view.questions[intake.view.currentIndex];
      const status = steps % 5 === 0 ? "unknown" : steps % 7 === 0 ? "unverified" : "known";
      const result = await answerOnDevice(
        intake,
        question.id,
        status,
        validDraft(QUESTION_BY_ID[question.id]),
        noPersist,
      );
      expect(result.kind).toBe("saved");
      if (result.kind !== "saved") {
        return;
      }
      intake = result.intake;
      // A reload at every step resumes exactly where the flow engine says.
      const reloaded = await loadDeviceIntake(opener(kv));
      expect(reloaded.notice).toBe(DEVICE_INTAKE_COPY.resumedOnLoad);
      expect(reloaded.intake.answers).toEqual(intake.answers);
      const map = toAnswerMap(reloaded.intake.answers);
      const visible = visibleQuestions(QUESTIONS, map);
      const first = firstUnansweredIndex(visible, map);
      expect(reloaded.intake.view.currentIndex).toBe(first === -1 ? null : first);
      intake = reloaded.intake;
    }
    expect(intake.view.complete).toBe(true);
    expect(store.size).toBe(2);

    const deleted = await deleteDeviceIntake(intake);
    expect(deleted.deleted).toBe(true);
    expect(deleted.notice).toBe(DEVICE_INTAKE_COPY.deleted);
    expect(deleted.intake.answers).toEqual(EMPTY_CLIENT_ANSWERS);
    expect(store.size).toBe(0);
    const afterDelete = await loadDeviceIntake(opener(kv));
    expect(afterDelete.intake.answers).toEqual(EMPTY_CLIENT_ANSWERS);
    expect(afterDelete.intake.view.currentIndex).toBe(0);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("never puts a private answer's value into what the page renders", async () => {
    const { kv } = memoryKv();
    let { intake } = await loadDeviceIntake(opener(kv));
    for (const question of QUESTIONS.filter((candidate) => candidate.pii)) {
      const result = await answerOnDevice(intake, question.id, "known", validDraft(question), noPersist);
      if (result.kind === "saved") {
        intake = result.intake;
      }
    }
    for (const question of QUESTIONS.filter((candidate) => candidate.pii)) {
      const shown = intake.view.answers[question.id];
      if (shown) {
        expect("value" in shown).toBe(false);
      }
    }
    expect(intake.view).toEqual(buildClientState(toAnswerMap(intake.answers)));
  });
});

describe("answers are checked as the server checks them", () => {
  it("keeps the canonical value for any valid answer and refuses anything else", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...QUESTIONS),
        fc.oneof(
          fc.string({ maxLength: 12 }),
          fc.integer(),
          fc.double(),
          fc.boolean(),
          fc.constant(null),
          fc.array(fc.string({ maxLength: 8 }), { maxLength: 3 }),
        ),
        async (question, draft) => {
          const { kv, store } = memoryKv();
          const { intake } = await loadDeviceIntake(opener(kv));
          const result = await answerOnDevice(intake, question.id, "known", draft, noPersist);
          const canonical = canonicalAnswerValue(question, draft);
          if (canonical === null) {
            expect(result).toEqual({ kind: "invalid", message: DEVICE_INTAKE_COPY.invalidAnswer });
            expect(store.size).toBe(0);
          } else {
            expect(result.kind).toBe("saved");
            if (result.kind === "saved") {
              expect(result.intake.answers[question.id]?.value).toEqual(canonical);
            }
          }
        },
      ),
      { numRuns: 80 },
    );
  });

  it("an unknown answer keeps no value whatever was typed, and unknown question ids are refused", async () => {
    const { kv } = memoryKv();
    const { intake } = await loadDeviceIntake(opener(kv));
    const question = QUESTIONS[0];
    const result = await answerOnDevice(intake, question.id, "unknown", "typed then disavowed", noPersist);
    expect(result.kind).toBe("saved");
    if (result.kind === "saved") {
      expect(result.intake.answers[question.id]?.value).toBeNull();
    }
    for (const id of ["nope", "constructor", "__proto__"]) {
      expect((await answerOnDevice(intake, id, "known", "x", noPersist)).kind).toBe("invalid");
    }
  });
});

describe("a browser that can't store anything", () => {
  it("works in memory, says so at every step, and clears only the page on delete", async () => {
    const { intake, notice } = await loadDeviceIntake(unsupported);
    expect(notice).toBe(DEVICE_INTAKE_COPY.unsupportedOnLoad);
    expect(keepsAnswers(intake)).toBe(false);
    expect(keepingBlurb(intake)).toBe(DEVICE_INTAKE_COPY.unsupportedBlurb);
    const answered = await answerFirst(intake, 1);
    expect(answerNotice("known", answered.view.progress, answered)).toMatch(/can't save answers/);
    expect(privateAnswerNote(answered)).toBe(DEVICE_INTAKE_COPY.privateNotKept);
    expect(saveForLaterNotice(answered)).toBe(DEVICE_INTAKE_COPY.unsupportedBlurb);
    const cleared = await deleteDeviceIntake(answered);
    expect(cleared).toMatchObject({ deleted: true, notice: DEVICE_INTAKE_COPY.clearedNothingStored });
    expect(cleared.intake.answers).toEqual(EMPTY_CLIENT_ANSWERS);
  });
});

describe("storage that fails while answers from an earlier visit are stored", () => {
  async function earlierVisit() {
    const disk = memoryKv();
    const { intake } = await loadDeviceIntake(opener(disk.kv));
    await answerFirst(intake, 2);
    expect(disk.store.size).toBe(2);
    return disk;
  }

  it("a delete after a failed open runs the verified purge on a fresh open", async () => {
    const disk = await earlierVisit();
    const { intake, notice } = await loadDeviceIntake(failed);
    expect(notice).toBe(DEVICE_INTAKE_COPY.unavailableOnLoad);
    expect(keepingBlurb(intake)).toBe(DEVICE_INTAKE_COPY.unavailableBlurb);
    const result = await deleteDeviceIntake(intake, opener(disk.kv));
    expect(result).toMatchObject({ deleted: true, notice: DEVICE_INTAKE_COPY.deleted });
    expect(disk.store.size).toBe(0);
  });

  it("a delete that can't reach storage never reports success, and the stored answers are untouched", async () => {
    const disk = await earlierVisit();
    const { intake } = await loadDeviceIntake(failed);
    for (const reopen of [failed, () => Promise.reject(new Error("blocked"))]) {
      const result = await deleteDeviceIntake(intake, reopen);
      expect(result.deleted).toBe(false);
      expect(result.notice).toBe(DEVICE_INTAKE_COPY.deleteUnconfirmed);
    }
    expect(disk.store.size).toBe(2);
  });

  it("a store that opens but can't be read keeps its handle, so a delete still purges it", async () => {
    const disk = await earlierVisit();
    let reads = 0;
    const flaky: DeviceKv = {
      ...disk.kv,
      getMany: (keys) => {
        reads += 1;
        return reads === 1 ? Promise.reject(new Error("read failed")) : disk.kv.getMany(keys);
      },
    };
    const { intake, notice } = await loadDeviceIntake(opener(flaky));
    expect(notice).toBe(DEVICE_INTAKE_COPY.unavailableOnLoad);
    expect(intake.store).not.toBeNull();
    const result = await deleteDeviceIntake(intake, failed);
    expect(result).toMatchObject({ deleted: true, notice: DEVICE_INTAKE_COPY.deleted });
    expect(disk.store.size).toBe(0);
  });
});

describe("a save that fails mid-visit", () => {
  it("after earlier saves, says those are still on the device and new changes aren't", async () => {
    const disk = memoryKv();
    const failing: DeviceKv = { ...disk.kv };
    const { intake } = await loadDeviceIntake(opener(failing));
    const saved = await answerFirst(intake, 2);
    failing.setMany = () => Promise.reject(new Error("quota exceeded"));
    const next = saved.view.questions[saved.view.currentIndex ?? 0];
    const result = await answerOnDevice(saved, next.id, "known", validDraft(QUESTION_BY_ID[next.id]), noPersist);
    expect(result).toMatchObject({ kind: "saved", notice: DEVICE_INTAKE_COPY.stoppedKeeping });
    if (result.kind !== "saved") {
      return;
    }
    expect(result.intake.keeping).toBe("stopped");
    expect(keepingBlurb(result.intake)).toBe(DEVICE_INTAKE_COPY.stoppedBlurb);
    expect(saveForLaterNotice(result.intake)).toBe(DEVICE_INTAKE_COPY.stoppedBlurb);
    const later = result.intake.view.questions[result.intake.view.currentIndex ?? 0];
    const after = await answerOnDevice(result.intake, later.id, "known", validDraft(QUESTION_BY_ID[later.id]), noPersist);
    expect(after.kind).toBe("saved");
    if (after.kind === "saved") {
      expect(after.notice).toMatch(/This answer isn't saved\. Answers saved before stay on this device\./);
    }
    // And that is the truth: a reload brings back exactly the two saved answers.
    const reloaded = await loadDeviceIntake(opener(disk.kv));
    expect(Object.keys(reloaded.intake.answers)).toEqual(Object.keys(saved.answers));
    // A delete still reaches the stored answers.
    expect((await deleteDeviceIntake(result.intake)).deleted).toBe(true);
    expect(disk.store.size).toBe(0);
  });

  it("before anything was saved, says the answers last only until the page closes", async () => {
    const { kv } = memoryKv();
    const failing: DeviceKv = { ...kv, setMany: () => Promise.reject(new Error("quota exceeded")) };
    const { intake } = await loadDeviceIntake(opener(failing));
    const question = intake.view.questions[0];
    const result = await answerOnDevice(intake, question.id, "known", validDraft(QUESTION_BY_ID[question.id]), noPersist);
    expect(result).toMatchObject({ kind: "saved", notice: DEVICE_INTAKE_COPY.stoppedKeepingNothingStored });
    if (result.kind === "saved") {
      expect(keepingBlurb(result.intake)).toBe(DEVICE_INTAKE_COPY.stoppedBlurbNothingStored);
    }
  });

  it("a save that never settles gives up at the deadline instead of hanging the page", async () => {
    vi.useFakeTimers();
    const { kv } = memoryKv();
    const stalled: DeviceKv = { ...kv, setMany: () => new Promise(() => undefined) };
    const { intake } = await loadDeviceIntake(opener(stalled));
    const question = intake.view.questions[0];
    const pending = answerOnDevice(intake, question.id, "known", validDraft(QUESTION_BY_ID[question.id]), noPersist);
    await vi.advanceTimersByTimeAsync(DEVICE_STORAGE_TIMEOUT_MS + 1);
    const result = await pending;
    expect(result).toMatchObject({ kind: "saved", notice: DEVICE_INTAKE_COPY.saveTimedOut });
  });

  it("a save that lands after the deadline was only called possibly kept, and a delete still removes it", async () => {
    vi.useFakeTimers();
    const disk = memoryKv();
    let land: (() => void) | undefined;
    const slow: DeviceKv = {
      ...disk.kv,
      setMany: (entries, guard) =>
        new Promise((resolve) => {
          land = () => void disk.kv.setMany(entries, guard).then(resolve);
        }),
    };
    const { intake } = await loadDeviceIntake(opener(slow));
    const question = intake.view.questions[0];
    const pending = answerOnDevice(intake, question.id, "known", validDraft(QUESTION_BY_ID[question.id]), noPersist);
    // Let the save reach its write (sealing runs on real crypto), then let
    // the deadline pass while that write is still in flight.
    await vi.waitFor(() => expect(land).toBeDefined());
    await vi.advanceTimersByTimeAsync(DEVICE_STORAGE_TIMEOUT_MS + 1);
    const result = await pending;
    expect(result).toMatchObject({ kind: "saved", notice: DEVICE_INTAKE_COPY.saveTimedOut });
    if (result.kind !== "saved") {
      return;
    }
    // The page never says the answer was not saved, and it treats the
    // device as possibly holding answers from here on.
    expect(result.notice).not.toMatch(/isn't saved|aren't saved|won't be/);
    expect(result.intake.keeping).toBe("stopped");
    expect(result.intake.stored).toBe(true);
    expect(keepingBlurb(result.intake)).toBe(DEVICE_INTAKE_COPY.stoppedBlurb);
    // The write the page gave up on commits anyway...
    land?.();
    await vi.advanceTimersByTimeAsync(1);
    expect(disk.store.size).toBe(2);
    vi.useRealTimers();
    // ...and the delete still finds it and removes it.
    const deleted = await deleteDeviceIntake(result.intake);
    expect(deleted).toMatchObject({ deleted: true, notice: DEVICE_INTAKE_COPY.deleted });
    expect(disk.store.size).toBe(0);
  });
});

describe("other tabs and windows", () => {
  it("a refresh picks up another tab's answers and a delete made elsewhere", async () => {
    const disk = memoryKv();
    const mine = await answerFirst((await loadDeviceIntake(opener(disk.kv))).intake, 1);
    // Another tab answers one more question on the same device.
    const theirs = await answerFirst((await loadDeviceIntake(opener(disk.kv))).intake, 2);
    const refreshed = await refreshDeviceIntake(mine);
    expect(refreshed).toMatchObject({ changed: true, notice: DEVICE_INTAKE_COPY.updatedElsewhere });
    expect(refreshed.intake.answers).toEqual(theirs.answers);
    expect((await refreshDeviceIntake(refreshed.intake)).changed).toBe(false);

    // Another tab deletes everything.
    disk.store.clear();
    const gone = await refreshDeviceIntake(refreshed.intake);
    expect(gone).toMatchObject({ changed: true, notice: DEVICE_INTAKE_COPY.purgedElsewhere });
    expect(gone.intake.answers).toEqual(EMPTY_CLIENT_ANSWERS);
    expect(saveForLaterNotice(gone.intake)).toBe(DEVICE_INTAKE_COPY.savedForLaterKept);
  });

  it("a save after another tab's delete is not written, and the page starts fresh", async () => {
    const disk = memoryKv();
    const intake = await answerFirst((await loadDeviceIntake(opener(disk.kv))).intake, 1);
    disk.store.clear();
    const question = intake.view.questions[intake.view.currentIndex ?? 0];
    const result = await answerOnDevice(intake, question.id, "known", validDraft(QUESTION_BY_ID[question.id]), noPersist);
    expect(result).toMatchObject({ kind: "purged", notice: DEVICE_INTAKE_COPY.purgedElsewhere });
    expect(disk.store.size).toBe(0);
  });
});

describe("honest copy", () => {
  it("asks the browser to keep the store once, on the first answer it keeps", async () => {
    const { kv } = memoryKv();
    let { intake } = await loadDeviceIntake(opener(kv));
    let asked = 0;
    const persist = async () => {
      asked += 1;
      return true;
    };
    for (const question of intake.view.questions.slice(0, 3)) {
      const result = await answerOnDevice(intake, question.id, "known", validDraft(QUESTION_BY_ID[question.id]), persist);
      if (result.kind === "saved") {
        intake = result.intake;
      }
    }
    expect(asked).toBe(1);
  });

  it("does not claim a delete it could not confirm, and keeps showing what is still stored", async () => {
    const { kv, store } = memoryKv();
    const saved = await answerFirst((await loadDeviceIntake(opener(kv))).intake, 1);
    const refusing: DeviceIntake = {
      ...saved,
      store: { kv: { ...kv, deleteMany: () => Promise.reject(new Error("refused")) }, subtle: crypto.subtle },
    };
    const result = await deleteDeviceIntake(refusing);
    expect(result.deleted).toBe(false);
    expect(result.notice).toBe(DEVICE_INTAKE_COPY.deleteUnconfirmed);
    expect(result.intake.answers).toEqual(saved.answers);
    expect(store.size).toBe(2);
  });

  it("states progress plainly, warns about shared computers, and keeps every line free of promise language", async () => {
    const { kv } = memoryKv();
    const { intake } = await loadDeviceIntake(opener(kv));
    const progress = { answered: 3, remaining: 4, total: 7 };
    expect(answerNotice("known", progress, intake)).toBe("Saved on this device. 3 of 7 answered.");
    expect(answerNotice("unknown", progress, intake)).toBe("Marked as not sure. You can come back to it.");
    expect(keepingBlurb(intake)).toMatch(/Anyone who uses this browser can see them/);
    expect(saveForLaterNotice(intake)).toMatch(/Private windows/);
    const lines = [
      ...Object.values(DEVICE_INTAKE_COPY),
      answerNotice("unverified", progress, { keeping: "unsupported", stored: false, store: null }),
      answerNotice("known", progress, { keeping: "stopped", stored: true, store: null }),
      answerNotice("known", progress, { keeping: "unavailable", stored: false, store: null }),
    ];
    for (const line of lines) {
      expect(findBannedClaims(line)).toEqual([]);
    }
    // No line says answers are kept safe from other people using the browser.
    for (const line of Object.values(DEVICE_INTAKE_COPY)) {
      expect(line).not.toMatch(/locked|never leaves this browser|any time/i);
    }
  });
});

describe("the stored keys", () => {
  it("are exactly the envelope and its key", async () => {
    const { kv, store } = memoryKv();
    await answerFirst((await loadDeviceIntake(opener(kv))).intake, 1);
    expect([...store.keys()].sort()).toEqual(
      [DEVICE_ANSWERS_CRYPTO_KEY_KEY, DEVICE_ANSWERS_ENVELOPE_KEY].sort(),
    );
  });
});
