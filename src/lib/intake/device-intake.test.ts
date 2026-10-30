import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceKv, KvGuard } from "../device-kv";
import { findBannedClaims } from "../honesty";
import { canonicalAnswerValue } from "./answer-input";
import { buildClientState } from "./client-state";
import { EMPTY_CLIENT_ANSWERS, toAnswerMap } from "./client-store";
import type { DeviceAnswerStoreDeps } from "./device-answer-store";
import {
  DEVICE_INTAKE_COPY,
  answerNotice,
  answerOnDevice,
  deleteDeviceIntake,
  keepsAnswers,
  loadDeviceIntake,
  saveForLaterNotice,
  type DeviceIntake,
} from "./device-intake";
import { firstUnansweredIndex, visibleQuestions } from "./flow";
import { QUESTIONS, QUESTION_BY_ID, type Question } from "./spec";

// The step-by-step page's on-device intake (HACK-99): a whole journey runs
// without one network request, resumes after a reload exactly where the
// flow engine says, checks answers as the server does, and tells the
// person the truth about what the browser kept and what was deleted.

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

function opener(kv: DeviceKv): () => Promise<DeviceAnswerStoreDeps> {
  return async () => ({ kv, subtle: crypto.subtle });
}

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

let fetchSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchSpy = vi.fn(() => Promise.reject(new Error("no network on the device path")));
  vi.stubGlobal("fetch", fetchSpy);
});
afterEach(() => {
  vi.unstubAllGlobals();
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

describe("honest copy about what the browser keeps", () => {
  it("without device storage the page still works, in memory, and says so at every step", async () => {
    const { intake, notice } = await loadDeviceIntake(async () => null);
    expect(notice).toBe(DEVICE_INTAKE_COPY.notKeptOnLoad);
    expect(keepsAnswers(intake)).toBe(false);
    const question = intake.view.questions[0];
    const result = await answerOnDevice(intake, question.id, "known", validDraft(QUESTION_BY_ID[question.id]), noPersist);
    expect(result.kind).toBe("saved");
    if (result.kind === "saved") {
      expect(result.notice).toMatch(/isn't keeping answers/);
      expect(result.intake.answers[question.id]).toBeDefined();
      expect(saveForLaterNotice(result.intake)).toBe(DEVICE_INTAKE_COPY.savedForLaterNotKept);
      const cleared = await deleteDeviceIntake(result.intake);
      expect(cleared).toMatchObject({ deleted: true, notice: DEVICE_INTAKE_COPY.clearedNotKept });
      expect(cleared.intake.answers).toEqual(EMPTY_CLIENT_ANSWERS);
    }
    expect((await loadDeviceIntake(() => Promise.reject(new Error("blocked")))).notice).toBe(
      DEVICE_INTAKE_COPY.notKeptOnLoad,
    );
  });

  it("when a write fails mid-visit, the rest of the visit stays in memory and the page says so", async () => {
    const { kv } = memoryKv();
    const failing: DeviceKv = { ...kv, setMany: () => Promise.reject(new Error("quota exceeded")) };
    const { intake } = await loadDeviceIntake(opener(failing));
    const [first, second] = intake.view.questions;
    const result = await answerOnDevice(intake, first.id, "known", validDraft(QUESTION_BY_ID[first.id]), noPersist);
    expect(result).toMatchObject({ kind: "saved", notice: DEVICE_INTAKE_COPY.stoppedKeeping });
    if (result.kind !== "saved") {
      return;
    }
    expect(keepsAnswers(result.intake)).toBe(false);
    expect(saveForLaterNotice(result.intake)).toBe(DEVICE_INTAKE_COPY.savedForLaterNotKept);
    const next = await answerOnDevice(result.intake, second.id, "known", validDraft(QUESTION_BY_ID[second.id]), noPersist);
    expect(next.kind).toBe("saved");
    if (next.kind === "saved") {
      expect(next.notice).toMatch(/isn't keeping answers/);
      expect(Object.keys(next.intake.answers).sort()).toEqual([first.id, second.id].sort());
    }
  });

  it("says when stored answers could not be opened, and when another tab deleted them", async () => {
    const { kv, store } = memoryKv();
    store.set("intake-answers", "sealed1.garbage.garbage");
    const unreadable = await loadDeviceIntake(opener(kv));
    expect(unreadable.notice).toBe(DEVICE_INTAKE_COPY.unreadableOnLoad);
    expect(unreadable.intake.answers).toEqual(EMPTY_CLIENT_ANSWERS);

    const fresh = memoryKv();
    let { intake } = await loadDeviceIntake(opener(fresh.kv));
    const [first, second] = intake.view.questions;
    const saved = await answerOnDevice(intake, first.id, "known", validDraft(QUESTION_BY_ID[first.id]), noPersist);
    expect(saved.kind).toBe("saved");
    if (saved.kind !== "saved") {
      return;
    }
    intake = saved.intake;
    // Another tab deletes everything; this page's next answer is not saved.
    fresh.store.clear();
    const after = await answerOnDevice(intake, second.id, "known", validDraft(QUESTION_BY_ID[second.id]), noPersist);
    expect(after).toMatchObject({ kind: "purged", notice: DEVICE_INTAKE_COPY.purgedElsewhere });
    if (after.kind === "purged") {
      expect(after.intake.answers).toEqual(EMPTY_CLIENT_ANSWERS);
    }
    expect(fresh.store.size).toBe(0);
  });

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

  it("does not claim a delete it could not confirm", async () => {
    const { kv } = memoryKv();
    const { intake } = await loadDeviceIntake(opener(kv));
    const question = intake.view.questions[0];
    const saved = await answerOnDevice(intake, question.id, "known", validDraft(QUESTION_BY_ID[question.id]), noPersist);
    expect(saved.kind).toBe("saved");
    if (saved.kind !== "saved") {
      return;
    }
    const refusing: DeviceIntake = {
      ...saved.intake,
      store: { kv: { ...kv, deleteMany: () => Promise.reject(new Error("refused")) }, subtle: crypto.subtle },
    };
    const result = await deleteDeviceIntake(refusing);
    expect(result.deleted).toBe(false);
    expect(result.notice).toBe(DEVICE_INTAKE_COPY.deleteUnconfirmed);
    expect(result.intake.answers).toEqual(saved.intake.answers);
  });

  it("states progress plainly and keeps every line free of promise language", () => {
    const progress = { answered: 3, remaining: 4, total: 7 };
    expect(answerNotice("known", progress, true)).toBe("Saved on this device. 3 of 7 answered.");
    expect(answerNotice("unknown", progress, true)).toBe("Marked as not sure. You can come back to it.");
    expect(answerNotice("known", progress, false)).toMatch(/^Noted for this visit\. 3 of 7 answered\./);
    for (const line of [
      ...Object.values(DEVICE_INTAKE_COPY),
      answerNotice("unverified", progress, false),
    ]) {
      expect(findBannedClaims(line)).toEqual([]);
    }
  });
});
